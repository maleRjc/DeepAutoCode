/**
 * Git Worktree Lifecycle Manager
 * Inspired by OpenCode's packages/core/src/worktree.ts.
 * Provides full-lifecycle isolation for agent coding sessions:
 * atomic creation, status tracking, unified diff extraction, atomic merge, and safe removal.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);

export interface WorktreeInfo {
  id: string;
  path: string;
  branch: string;
  head: string;
  isMain: boolean;
  locked?: boolean;
}

export interface CreateWorktreeOptions {
  workspaceRoot: string;
  sessionId: string;
  baseRef?: string;
  branch?: string;
}

export interface MergeWorktreeOptions {
  workspaceRoot: string;
  worktreeId: string;
  targetBranch?: string;
  commitMessage?: string;
  squash?: boolean;
}

export interface RemoveWorktreeOptions {
  workspaceRoot: string;
  worktreeId: string;
  force?: boolean;
  deleteBranch?: boolean;
}

export class WorktreeManager {
  private static instance: WorktreeManager | null = null;

  public static getInstance(): WorktreeManager {
    if (!WorktreeManager.instance) {
      WorktreeManager.instance = new WorktreeManager();
    }
    return WorktreeManager.instance;
  }

  private async runGit(cwd: string, args: string[], timeoutMs = 30_000): Promise<string> {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    return (stdout || stderr || '').trim();
  }

  /**
   * Check if the directory is inside a Git working tree.
   */
  public async isGitRepo(workspaceRoot: string): Promise<boolean> {
    try {
      await this.runGit(workspaceRoot, ['rev-parse', '--is-inside-work-tree'], 5000);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all active Git worktrees in porcelain format.
   */
  public async list(workspaceRoot: string): Promise<WorktreeInfo[]> {
    if (!(await this.isGitRepo(workspaceRoot))) return [];

    try {
      const output = await this.runGit(workspaceRoot, ['worktree', 'list', '--porcelain']);
      const blocks = output.split('\n\n').filter(Boolean);
      const list: WorktreeInfo[] = [];

      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const lines = block.split('\n');
        let wtPath = '';
        let head = '';
        let branch = '';
        let locked = false;

        for (const line of lines) {
          if (line.startsWith('worktree ')) {
            wtPath = line.slice(9).trim();
          } else if (line.startsWith('HEAD ')) {
            head = line.slice(5).trim();
          } else if (line.startsWith('branch ')) {
            branch = line.slice(7).replace(/^refs\/heads\//, '').trim();
          } else if (line.startsWith('locked')) {
            locked = true;
          }
        }

        if (wtPath) {
          const normPath = path.resolve(wtPath);
          const isMain = i === 0 || normPath === path.resolve(workspaceRoot);
          const id = path.basename(normPath);
          list.push({
            id,
            path: normPath,
            branch: branch || 'detached',
            head,
            isMain,
            locked,
          });
        }
      }

      return list;
    } catch {
      return [];
    }
  }

  /**
   * Create an isolated Git worktree for an autonomous coding task.
   */
  public async create(options: CreateWorktreeOptions): Promise<{
    ok: boolean;
    worktree?: WorktreeInfo;
    message: string;
  }> {
    const cwd = path.resolve(options.workspaceRoot);
    if (!(await this.isGitRepo(cwd))) {
      return {
        ok: false,
        message: 'Workspace is not a Git repository; worktree isolation unavailable.',
      };
    }

    const safeId = String(options.sessionId || 'agent_task')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 48);
    const worktreePath = path.join(cwd, '.deepautocode', 'worktrees', safeId);
    const branch = options.branch || `evolve/wt-${safeId}`;
    const baseRef = options.baseRef || 'HEAD';

    try {
      await fs.mkdir(path.dirname(worktreePath), { recursive: true });

      // Check if directory already exists
      try {
        await fs.access(worktreePath);
        return {
          ok: true,
          worktree: {
            id: safeId,
            path: worktreePath,
            branch,
            head: '',
            isMain: false,
          },
          message: `Reused existing worktree at ${worktreePath}`,
        };
      } catch {
        // Does not exist, proceed to create
      }

      // Try creating new worktree with branch
      try {
        await this.runGit(cwd, ['worktree', 'add', '-b', branch, worktreePath, baseRef]);
      } catch {
        // If branch already exists, attach without -b
        await this.runGit(cwd, ['worktree', 'add', worktreePath, branch]);
      }

      const head = await this.runGit(worktreePath, ['rev-parse', 'HEAD']).catch(() => '');

      return {
        ok: true,
        worktree: {
          id: safeId,
          path: worktreePath,
          branch,
          head,
          isMain: false,
        },
        message: `Created isolated worktree on branch ${branch}`,
      };
    } catch (err: any) {
      return {
        ok: false,
        message: `Failed to create worktree: ${err?.message || String(err)}`,
      };
    }
  }

  /**
   * Compute unified diff of changes made inside the worktree against the base branch.
   */
  public async diff(workspaceRoot: string, worktreeId: string, baseRef = 'main'): Promise<string> {
    const list = await this.list(workspaceRoot);
    const wt = list.find((w) => w.id === worktreeId || path.resolve(w.path) === path.resolve(worktreeId));
    if (!wt) {
      throw new Error(`Worktree not found for id: ${worktreeId}`);
    }

    try {
      // Diff worktree against baseRef
      const diffOutput = await this.runGit(wt.path, ['diff', `${baseRef}...HEAD`]);
      return diffOutput;
    } catch {
      // Fallback: diff uncommitted changes in worktree
      return await this.runGit(wt.path, ['diff', 'HEAD']).catch(() => '');
    }
  }

  /**
   * Atomically commit worktree changes and merge into the target branch.
   */
  public async merge(options: MergeWorktreeOptions): Promise<{ ok: boolean; message: string }> {
    const { workspaceRoot, worktreeId, targetBranch = 'main', commitMessage, squash = false } = options;
    const list = await this.list(workspaceRoot);
    const wt = list.find((w) => w.id === worktreeId || path.resolve(w.path) === path.resolve(worktreeId));
    if (!wt) {
      return { ok: false, message: `Worktree ${worktreeId} not found.` };
    }

    try {
      // 1. Stage and commit uncommitted changes inside the worktree
      await this.runGit(wt.path, ['add', '-A']);
      const status = await this.runGit(wt.path, ['status', '--porcelain']);
      if (status) {
        const msg = commitMessage || `Agent auto-commit in worktree ${wt.id}`;
        await this.runGit(wt.path, ['commit', '-m', msg]);
      }

      // 2. Perform merge in the main repository
      const mergeArgs = squash
        ? ['merge', '--squash', wt.branch]
        : ['merge', '--no-ff', '-m', `Merge agent worktree ${wt.branch}`, wt.branch];

      await this.runGit(workspaceRoot, mergeArgs);

      return {
        ok: true,
        message: `Successfully merged worktree ${wt.branch} into ${targetBranch}.`,
      };
    } catch (err: any) {
      return {
        ok: false,
        message: `Merge failed: ${err?.message || String(err)}`,
      };
    }
  }

  /**
   * Safely remove a worktree and optionally prune its temporary branch.
   */
  public async remove(options: RemoveWorktreeOptions): Promise<{ ok: boolean; message: string }> {
    const { workspaceRoot, worktreeId, force = true, deleteBranch = true } = options;
    const list = await this.list(workspaceRoot);
    const wt = list.find((w) => w.id === worktreeId || path.resolve(w.path) === path.resolve(worktreeId));

    if (!wt) {
      return { ok: true, message: `Worktree ${worktreeId} was already removed or does not exist.` };
    }
    if (wt.isMain) {
      return { ok: false, message: `Cannot remove primary working tree at ${wt.path}.` };
    }

    try {
      const rmArgs = force ? ['worktree', 'remove', '--force', wt.path] : ['worktree', 'remove', wt.path];
      await this.runGit(workspaceRoot, rmArgs);

      // Clean directory if git worktree left remnants
      try {
        await fs.rm(wt.path, { recursive: true, force: true });
      } catch {
        // ignore
      }

      // Delete temporary branch if requested
      if (deleteBranch && wt.branch && wt.branch.startsWith('evolve/wt-')) {
        await this.runGit(workspaceRoot, ['branch', '-D', wt.branch]).catch(() => undefined);
      }

      return {
        ok: true,
        message: `Successfully removed worktree ${wt.id}.`,
      };
    } catch (err: any) {
      return {
        ok: false,
        message: `Failed to remove worktree: ${err?.message || String(err)}`,
      };
    }
  }
}

