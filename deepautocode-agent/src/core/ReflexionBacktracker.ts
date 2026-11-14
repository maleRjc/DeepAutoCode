/**
 * Reflexion & Backtracking Engine
 * Implements hypothesis-driven exploration, dead-end pruning, and automated rollback.
 * When an agent fails repeatedly (e.g., 3 consecutive failed attempts on the same hypothesis),
 * it halts further compounding edits, cleanly resets the workspace/worktree to the baseline,
 * and synthesizes a structured Reflexion Note forcing the agent to pivot to Plan B.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

export interface HypothesisRecord {
  id: string;
  description: string;
  startedAt: number;
  attempts: number;
  maxAttempts: number;
  failures: Array<{
    attempt: number;
    error: string;
    timestamp: number;
  }>;
  status: 'active' | 'succeeded' | 'abandoned_backtracked';
  reflexionNote?: string;
}

export interface ReflexionBacktrackerOptions {
  workspaceRoot: string;
  maxAttemptsPerHypothesis?: number;
  isWorktreeSandbox?: boolean;
  onBacktrack?: (note: string) => void;
}

export class ReflexionBacktracker {
  private readonly workspaceRoot: string;
  private readonly maxAttemptsPerHypothesis: number;
  private readonly isWorktreeSandbox: boolean;
  private currentHypothesis: HypothesisRecord | null = null;
  private readonly hypothesisHistory: HypothesisRecord[] = [];
  private hypothesisCounter = 0;

  constructor(options: ReflexionBacktrackerOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.maxAttemptsPerHypothesis = Math.max(1, options.maxAttemptsPerHypothesis ?? 3);
    // Safety check: is this a disposable worktree/sandbox (under .deepautocode/worktrees or tmp)?
    this.isWorktreeSandbox =
      options.isWorktreeSandbox ??
      (this.workspaceRoot.includes(path.join('.deepautocode', 'worktrees')) ||
        this.workspaceRoot.includes('tmp') ||
        this.workspaceRoot.includes('temp'));
  }

  /**
   * Start or update the current hypothesis being tested by the agent.
   */
  public startHypothesis(description: string, maxAttempts?: number): HypothesisRecord {
    if (this.currentHypothesis && this.currentHypothesis.status === 'active') {
      this.currentHypothesis.status = 'abandoned_backtracked';
      this.hypothesisHistory.push(this.currentHypothesis);
    }

    const id = `hyp_${++this.hypothesisCounter}`;
    this.currentHypothesis = {
      id,
      description: description.trim() || `Hypothesis ${this.hypothesisCounter}`,
      startedAt: Date.now(),
      attempts: 0,
      maxAttempts: maxAttempts ?? this.maxAttemptsPerHypothesis,
      failures: [],
      status: 'active',
    };
    return this.currentHypothesis;
  }

  public getActiveHypothesis(): HypothesisRecord | null {
    return this.currentHypothesis;
  }

  public getHistory(): HypothesisRecord[] {
    return [...this.hypothesisHistory];
  }

  /**
   * Record a failed verification or compilation attempt under the active hypothesis.
   * Returns whether a dead-end threshold was reached and backtracking should occur.
   */
  public recordFailure(errorDetail: string): {
    shouldBacktrack: boolean;
    attempts: number;
    maxAttempts: number;
    hypothesisId: string;
  } {
    if (!this.currentHypothesis || this.currentHypothesis.status !== 'active') {
      this.startHypothesis('Default exploration hypothesis');
    }

    const hyp = this.currentHypothesis!;
    hyp.attempts += 1;
    hyp.failures.push({
      attempt: hyp.attempts,
      error: errorDetail.slice(0, 1000),
      timestamp: Date.now(),
    });

    const shouldBacktrack = hyp.attempts >= hyp.maxAttempts;
    return {
      shouldBacktrack,
      attempts: hyp.attempts,
      maxAttempts: hyp.maxAttempts,
      hypothesisId: hyp.id,
    };
  }

  /**
   * Record success when tests/build pass under the active hypothesis.
   */
  public recordSuccess(): void {
    if (this.currentHypothesis) {
      this.currentHypothesis.status = 'succeeded';
      this.hypothesisHistory.push(this.currentHypothesis);
      this.currentHypothesis = null;
    }
  }

  /**
   * Execute atomic rollback of the workspace changes (if in worktree sandbox)
   * and synthesize a high-priority Reflexion Note.
   */
  public async backtrack(lesson?: string): Promise<{
    ok: boolean;
    reflexionPrompt: string;
    reverted: boolean;
    error?: string;
  }> {
    const hyp = this.currentHypothesis;
    const failuresSummary = hyp?.failures
      .map((f) => `Attempt ${f.attempt}: ${f.error.split('\n')[0]}`)
      .join(' | ') || 'Continuous failure threshold reached.';

    let reverted = false;
    let revertError: string | undefined;

    // Safety guard: only execute git reset in a verified worktree sandbox
    if (this.isWorktreeSandbox) {
      try {
        await execFileAsync('git', ['reset', '--hard', 'HEAD'], {
          cwd: this.workspaceRoot,
          windowsHide: true,
          timeout: 15000,
        });
        await execFileAsync('git', ['clean', '-fd'], {
          cwd: this.workspaceRoot,
          windowsHide: true,
          timeout: 15000,
        });
        reverted = true;
      } catch (err: any) {
        revertError = err?.message || String(err);
      }
    } else {
      revertError = 'Skipped hard git reset: workspace is primary repository (not an isolated worktree).';
    }

    const synthesizedLesson =
      lesson ||
      `Hypothesis "${hyp?.description}" is fundamentally flawed or hitting insurmountable conflicts. Do not retry the exact same code modifications.`;

    const reflexionPrompt = [
      `[REFLEXION & BACKTRACK TRIGGERED]`,
      `Hypothesis "${hyp?.description || 'current strategy'}" failed ${hyp?.attempts || this.maxAttemptsPerHypothesis} times in a row.`,
      `Failures: ${failuresSummary}`,
      `Action: Workspace state restored (${reverted ? 'git reset in worktree' : 'checkpoint notice'}).`,
      `Lesson: ${synthesizedLesson}`,
      `Mandatory Instruction: You MUST now formulate an alternative hypothesis (Plan B) with a fundamentally different approach. Do NOT repeat the previous edits!`,
    ].join('\n');

    if (hyp) {
      hyp.status = 'abandoned_backtracked';
      hyp.reflexionNote = reflexionPrompt;
      this.hypothesisHistory.push(hyp);
      this.currentHypothesis = null;
    }

    return {
      ok: true,
      reflexionPrompt,
      reverted,
      error: revertError,
    };
  }
}

