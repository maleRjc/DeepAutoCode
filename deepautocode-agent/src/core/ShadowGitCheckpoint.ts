/**
 * Shadow-git checkpoints (Cline-inspired): snapshots via a private git dir under
 * `.deepautocode/shadow-git`, without touching the user's real repo index/HEAD.
 *
 * Uses GIT_DIR + GIT_WORK_TREE so commits are invisible to the project git status.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ShadowCheckpointResult {
  ok: boolean;
  commit?: string;
  message: string;
  skipped?: boolean;
  reason?: string;
}

export interface ShadowGitCheckpointOptions {
  workspaceRoot: string;
  /** Relative to workspace. Default `.deepautocode/shadow-git`. */
  shadowDir?: string;
  timeoutMs?: number;
}

function runGit(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve({ code: 124, stdout, stderr: stderr || 'git timeout' });
    }, timeoutMs);
    child.stdout?.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: err.message });
    });
  });
}

export class ShadowGitCheckpoint {
  private readonly workspaceRoot: string;
  private readonly shadowDir: string;
  private readonly timeoutMs: number;
  private ready = false;

  constructor(options: ShadowGitCheckpointOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.shadowDir = path.resolve(
      this.workspaceRoot,
      options.shadowDir ?? path.join('.deepautocode', 'shadow-git'),
    );
    this.timeoutMs = Math.max(2000, options.timeoutMs ?? 30_000);
  }

  getShadowDir(): string {
    return this.shadowDir;
  }

  private env(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GIT_DIR: this.shadowDir,
      GIT_WORK_TREE: this.workspaceRoot,
      // Avoid inheriting user's index/hooks surprises
      GIT_INDEX_FILE: path.join(this.shadowDir, 'index'),
    };
  }

  async ensureInitialized(): Promise<void> {
    if (this.ready && fs.existsSync(path.join(this.shadowDir, 'HEAD'))) {
      return;
    }
    fs.mkdirSync(this.shadowDir, { recursive: true });
    const head = path.join(this.shadowDir, 'HEAD');
    if (!fs.existsSync(head)) {
      const init = await runGit(
        ['init', '--quiet'],
        this.env(),
        this.workspaceRoot,
        this.timeoutMs,
      );
      if (init.code !== 0) {
        throw new Error(`shadow-git init failed: ${init.stderr || init.stdout}`);
      }
      // Exclude the shadow dir itself + common noise (best-effort)
      const exclude = path.join(this.shadowDir, 'info', 'exclude');
      fs.mkdirSync(path.dirname(exclude), { recursive: true });
      const lines = [
        '.deepautocode/',
        'node_modules/',
        '.git/',
        'dist/',
        'build/',
        '*.log',
      ];
      fs.writeFileSync(exclude, `${lines.join('\n')}\n`, 'utf8');
      await runGit(
        ['config', 'user.email', 'checkpoint@deepautocode.local'],
        this.env(),
        this.workspaceRoot,
        this.timeoutMs,
      );
      await runGit(
        ['config', 'user.name', 'DeepAutoCode Checkpoint'],
        this.env(),
        this.workspaceRoot,
        this.timeoutMs,
      );
    }
    this.ready = true;
  }

  /**
   * Create a checkpoint commit of the current worktree state.
   * No-ops (skipped) when there is nothing new to commit.
   */
  async create(message: string): Promise<ShadowCheckpointResult> {
    try {
      await this.ensureInitialized();
    } catch (err) {
      return {
        ok: false,
        message: String(message || 'checkpoint'),
        reason: err instanceof Error ? err.message : String(err),
      };
    }

    const env = this.env();
    const add = await runGit(['add', '-A'], env, this.workspaceRoot, this.timeoutMs);
    if (add.code !== 0) {
      return {
        ok: false,
        message,
        reason: `git add failed: ${add.stderr || add.stdout}`,
      };
    }

    const status = await runGit(
      ['status', '--porcelain'],
      env,
      this.workspaceRoot,
      this.timeoutMs,
    );
    if (status.code !== 0) {
      return { ok: false, message, reason: status.stderr || status.stdout };
    }
    if (!status.stdout.trim()) {
      // Still record HEAD for callers
      const rev = await runGit(['rev-parse', 'HEAD'], env, this.workspaceRoot, this.timeoutMs);
      return {
        ok: true,
        skipped: true,
        message,
        commit: rev.code === 0 ? rev.stdout.trim() : undefined,
        reason: 'nothing to commit',
      };
    }

    const safeMsg = String(message || 'checkpoint').replace(/"/g, "'").slice(0, 200);
    const commit = await runGit(
      ['commit', '-m', safeMsg, '--quiet', '--allow-empty-message'],
      env,
      this.workspaceRoot,
      this.timeoutMs,
    );
    if (commit.code !== 0) {
      return {
        ok: false,
        message: safeMsg,
        reason: `git commit failed: ${commit.stderr || commit.stdout}`,
      };
    }

    const rev = await runGit(['rev-parse', 'HEAD'], env, this.workspaceRoot, this.timeoutMs);
    return {
      ok: true,
      message: safeMsg,
      commit: rev.code === 0 ? rev.stdout.trim() : undefined,
    };
  }
}

/** Convenience singleton-ish factory keyed by workspace root. */
const cache = new Map<string, ShadowGitCheckpoint>();

export function getShadowGitCheckpoint(workspaceRoot: string): ShadowGitCheckpoint {
  const key = path.resolve(workspaceRoot);
  let existing = cache.get(key);
  if (!existing) {
    existing = new ShadowGitCheckpoint({ workspaceRoot: key });
    cache.set(key, existing);
  }
  return existing;
}
