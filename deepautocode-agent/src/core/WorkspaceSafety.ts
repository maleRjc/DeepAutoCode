import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface SandboxBranchResult {
  enabled: boolean;
  branch?: string;
  previousBranch?: string;
  message: string;
}

export interface CircuitBreakerRollbackResult {
  rolledBackFiles: string[];
  failedFiles: string[];
  message: string;
}

/**
 * Create an isolated `evolve/auto-*` git branch before the Agent's first mutating write.
 * No-ops (enabled=false) when the workspace is not a git repo or git is unavailable.
 */
export async function ensureAgentSandboxBranch(
  workspaceRoot: string
): Promise<SandboxBranchResult> {
  const cwd = path.resolve(workspaceRoot);
  try {
    await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      timeout: 8000,
      windowsHide: true,
    });
  } catch {
    return {
      enabled: false,
      message: 'Workspace is not a git repository; agent edits will apply on the current tree.',
    };
  }

  try {
    const { stdout: branchOut } = await execFileAsync(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd, timeout: 8000, windowsHide: true }
    );
    const previousBranch = branchOut.trim() || 'HEAD';

    // Already on an evolve sandbox branch for this session — keep it.
    if (/^evolve\//i.test(previousBranch)) {
      return {
        enabled: true,
        branch: previousBranch,
        previousBranch,
        message: `Already on agent sandbox branch ${previousBranch}.`,
      };
    }

    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d+Z$/, '')
      .replace('T', '-');
    const branch = `evolve/auto-${stamp}`;

    await execFileAsync('git', ['checkout', '-b', branch], {
      cwd,
      timeout: 15000,
      windowsHide: true,
    });

    return {
      enabled: true,
      branch,
      previousBranch,
      message: `Created isolated agent sandbox branch ${branch} (from ${previousBranch}).`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      enabled: false,
      message: `Failed to create evolve sandbox branch: ${msg}`,
    };
  }
}

/**
 * Circuit-breaker rollback: restore files to their pre-edit originals captured in this session.
 */
export async function rollbackSessionMutations(params: {
  workspaceRoot: string;
  originals: Map<string, string>;
  createdFiles?: string[];
}): Promise<CircuitBreakerRollbackResult> {
  const root = path.resolve(params.workspaceRoot);
  const rolledBackFiles: string[] = [];
  const failedFiles: string[] = [];

  for (const rel of params.createdFiles ?? []) {
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root)) {
      failedFiles.push(rel);
      continue;
    }
    try {
      await fs.rm(abs, { force: true });
      rolledBackFiles.push(rel);
    } catch {
      failedFiles.push(rel);
    }
  }

  for (const [rel, content] of params.originals.entries()) {
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root)) {
      failedFiles.push(rel);
      continue;
    }
    try {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf-8');
      rolledBackFiles.push(rel);
    } catch {
      failedFiles.push(rel);
    }
  }

  return {
    rolledBackFiles: [...new Set(rolledBackFiles)],
    failedFiles: [...new Set(failedFiles)],
    message:
      rolledBackFiles.length > 0
        ? `Circuit breaker restored ${rolledBackFiles.length} file(s) after repeated self-heal failures.`
        : 'Circuit breaker triggered but no session mutations were available to restore.',
  };
}

export interface AgentWorktreeResult {
  enabled: boolean;
  worktreePath?: string;
  branch?: string;
  message: string;
}

/**
 * Stage W: create an isolated git worktree for a parallel Composer session.
 * Path: `<workspace>/.deepautocode/worktrees/<safeSessionId>`
 */
export async function ensureAgentWorktree(params: {
  workspaceRoot: string;
  sessionId: string;
  baseRef?: string;
}): Promise<AgentWorktreeResult> {
  const cwd = path.resolve(params.workspaceRoot);
  const safeId = String(params.sessionId || 'session')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 48);
  const worktreePath = path.join(cwd, '.deepautocode', 'worktrees', safeId);
  const branch = `evolve/wt-${safeId}`;

  try {
    await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      timeout: 8000,
      windowsHide: true,
    });
  } catch {
    return {
      enabled: false,
      message: 'Workspace is not a git repository; parallel session shares the main tree.',
    };
  }

  try {
    await fs.access(worktreePath);
    return {
      enabled: true,
      worktreePath,
      branch,
      message: `Reusing existing agent worktree at ${worktreePath}`,
    };
  } catch {
    // create new
  }

  try {
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    const base = params.baseRef || 'HEAD';
    await execFileAsync(
      'git',
      ['worktree', 'add', '-b', branch, worktreePath, base],
      { cwd, timeout: 60_000, windowsHide: true }
    );
    return {
      enabled: true,
      worktreePath,
      branch,
      message: `Created isolated git worktree ${worktreePath} on branch ${branch}`,
    };
  } catch (err) {
    // Branch may already exist — try without -b
    try {
      await execFileAsync('git', ['worktree', 'add', worktreePath, branch], {
        cwd,
        timeout: 60_000,
        windowsHide: true,
      });
      return {
        enabled: true,
        worktreePath,
        branch,
        message: `Attached agent worktree ${worktreePath} (branch ${branch})`,
      };
    } catch {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        enabled: false,
        message: `Failed to create git worktree: ${msg}`,
      };
    }
  }
}
