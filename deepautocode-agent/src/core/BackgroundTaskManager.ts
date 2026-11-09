import { spawn, type ChildProcess } from 'node:child_process';
import { globalSubagentOrchestrator } from './SubagentOrchestrator.js';

export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'killed';

export interface BackgroundTaskSnapshot {
  taskId: string;
  sessionId: string;
  command: string;
  cwd: string;
  pid?: number;
  isDaemon: boolean;
  status: BackgroundTaskStatus;
  exitCode: number | null;
  startedAt: string;
  completedAt?: string;
  durationMs: number;
  stdout: string;
  stderr: string;
}

interface ManagedTaskInternal {
  taskId: string;
  sessionId: string;
  command: string;
  cwd: string;
  pid?: number;
  isDaemon: boolean;
  status: BackgroundTaskStatus;
  exitCode: number | null;
  startedAtMs: number;
  startedAt: string;
  completedAt?: string;
  stdout: string;
  stderr: string;
  child: ChildProcess;
  onUpdate?: (snapshot: BackgroundTaskSnapshot) => void;
}

const MAX_TASK_LOG_CHARS = 128 * 1024;

export function parseCommandEnvPrefixes(rawCommand: string): {
  cleanCommand: string;
  extraEnv: Record<string, string>;
} {
  let rest = String(rawCommand || '').trim();
  const extraEnv: Record<string, string> = {};
  while (true) {
    const m = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)\s+([\s\S]+)$/);
    if (!m) break;
    extraEnv[m[1]] = m[2].replace(/^["']|["']$/g, '');
    rest = m[3].trim();
  }
  return { cleanCommand: rest || rawCommand, extraEnv };
}

function appendCapped(prev: string, chunk: string): string {
  const combined = prev + chunk;
  if (combined.length <= MAX_TASK_LOG_CHARS) return combined;
  return `...[truncated older log]...\n${combined.slice(-MAX_TASK_LOG_CHARS)}`;
}

/**
 * Antigravity-style Background Task Manager (`WaitMsBeforeAsync` + `IsDaemon` + `manage_task`).
 * Tracks backgrounded shell commands, buffers stdout/stderr, supports interactive stdin (`send_input`),
 * and emits reactive completion notifications.
 */
export class BackgroundTaskManager {
  private readonly tasks = new Map<string, ManagedTaskInternal>();
  private taskCounter = 0;

  public async runOrBackgroundCommand(params: {
    sessionId: string;
    command: string;
    cwd: string;
    waitMsBeforeAsync?: number;
    isDaemon?: boolean;
    signal?: AbortSignal;
    onStateChange?: (snapshot: BackgroundTaskSnapshot) => void;
  }): Promise<{
    backgrounded: boolean;
    task: BackgroundTaskSnapshot;
  }> {
    const taskId = `task_${Date.now().toString(36)}_${++this.taskCounter}`;
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const isDaemon = Boolean(params.isDaemon);
    const waitMs = Math.max(
      200,
      Math.min(120_000, Number(params.waitMsBeforeAsync ?? (isDaemon ? 600 : 10_000)))
    );

    const { cleanCommand, extraEnv } = parseCommandEnvPrefixes(params.command);
    const child = spawn(cleanCommand, {
      cwd: params.cwd,
      shell: true,
      windowsHide: true,
      env: { ...process.env, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const entry: ManagedTaskInternal = {
      taskId,
      sessionId: params.sessionId,
      command: params.command,
      cwd: params.cwd,
      pid: child.pid,
      isDaemon,
      status: 'running',
      exitCode: null,
      startedAtMs,
      startedAt,
      stdout: '',
      stderr: '',
      child,
      onUpdate: params.onStateChange,
    };

    this.tasks.set(taskId, entry);

    let exitDrainTimer: ReturnType<typeof setTimeout> | undefined;
    let settledCompletion: (() => void) | undefined;
    let wasBackgrounded = false;
    const completionPromise = new Promise<void>((resolve) => {
      settledCompletion = resolve;
    });

    const finalizeEntry = (code: number | null, killed = false) => {
      if (entry.status !== 'running') return;
      if (exitDrainTimer) clearTimeout(exitDrainTimer);
      const exitCode = typeof code === 'number' ? code : killed ? 137 : 0;
      entry.exitCode = exitCode;
      entry.status = killed ? 'killed' : exitCode === 0 ? 'completed' : 'failed';
      entry.completedAt = new Date().toISOString();
      settledCompletion?.();
      const snap = this.toSnapshot(entry);
      entry.onUpdate?.(snap);
      if (wasBackgrounded) {
        globalSubagentOrchestrator.enqueueWakeup({
          sessionId: entry.sessionId,
          sender: taskId,
          priority: 'HIGH',
          content: `Background task "${taskId}" (${entry.command}) finished with status=${entry.status} exitCode=${exitCode}.\nOutput:\n${(entry.stdout || entry.stderr).slice(-2000)}`,
        });
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      entry.stdout = appendCapped(entry.stdout, chunk.toString('utf-8'));
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      entry.stderr = appendCapped(entry.stderr, chunk.toString('utf-8'));
    });

    child.on('error', (err) => {
      entry.stderr = appendCapped(entry.stderr, `\n${err.message}`);
      finalizeEntry(1, false);
    });

    child.on('exit', (code) => {
      if (entry.status !== 'running' || exitDrainTimer) return;
      exitDrainTimer = setTimeout(() => {
        finalizeEntry(code, false);
      }, 300);
    });

    child.on('close', (code) => {
      finalizeEntry(code, false);
    });

    if (params.signal) {
      params.signal.addEventListener(
        'abort',
        () => {
          if (entry.status === 'running' && !entry.isDaemon) {
            this.killTask(taskId);
          }
        },
        { once: true }
      );
    }

    entry.onUpdate?.(this.toSnapshot(entry));

    const finishedInTime = await Promise.race([
      completionPromise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), waitMs)),
    ]);

    if (!finishedInTime) {
      wasBackgrounded = true;
    }

    return {
      backgrounded: !finishedInTime,
      task: this.toSnapshot(entry),
    };
  }

  public listTasks(sessionId?: string): BackgroundTaskSnapshot[] {
    const list: BackgroundTaskSnapshot[] = [];
    for (const entry of this.tasks.values()) {
      if (!sessionId || entry.sessionId === sessionId) {
        list.push(this.toSnapshot(entry));
      }
    }
    return list.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  public getTaskStatus(taskId: string): BackgroundTaskSnapshot | null {
    const entry = this.tasks.get(taskId);
    if (!entry) return null;
    return this.toSnapshot(entry);
  }

  public async sendTaskInput(
    taskId: string,
    input: string,
    waitMs = 400
  ): Promise<BackgroundTaskSnapshot> {
    const entry = this.tasks.get(taskId);
    if (!entry) {
      throw new Error(`TASK_NOT_FOUND: Background task "${taskId}" does not exist`);
    }
    if (entry.status !== 'running') {
      throw new Error(
        `TASK_NOT_RUNNING: Background task "${taskId}" is already ${entry.status} (exitCode=${entry.exitCode})`
      );
    }
    if (!entry.child.stdin || entry.child.stdin.destroyed) {
      throw new Error(`TASK_STDIN_CLOSED: Background task "${taskId}" stdin is not writable`);
    }
    const payload = input.endsWith('\n') ? input : `${input}\n`;
    entry.child.stdin.write(payload, 'utf-8');
    if (waitMs > 0) {
      await new Promise((r) => setTimeout(r, waitMs));
    }
    return this.toSnapshot(entry);
  }

  public killTask(taskId: string): BackgroundTaskSnapshot {
    const entry = this.tasks.get(taskId);
    if (!entry) {
      throw new Error(`TASK_NOT_FOUND: Background task "${taskId}" does not exist`);
    }
    if (entry.status === 'running') {
      try {
        if (process.platform === 'win32' && entry.pid) {
          spawn('taskkill', ['/PID', String(entry.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          }).unref();
        } else {
          entry.child.kill('SIGTERM');
        }
      } catch {
        // ignore kill errors
      }
      entry.status = 'killed';
      entry.exitCode = 137;
      entry.completedAt = new Date().toISOString();
      try {
        entry.child.stdout?.destroy();
        entry.child.stderr?.destroy();
        entry.child.stdin?.destroy();
      } catch {
        // ignore
      }
      entry.onUpdate?.(this.toSnapshot(entry));
    }
    return this.toSnapshot(entry);
  }

  public killSessionTasks(sessionId: string, includeDaemons = false): number {
    let killedCount = 0;
    for (const entry of this.tasks.values()) {
      if (
        entry.sessionId === sessionId &&
        entry.status === 'running' &&
        (includeDaemons || !entry.isDaemon)
      ) {
        this.killTask(entry.taskId);
        killedCount += 1;
      }
    }
    return killedCount;
  }

  private toSnapshot(entry: ManagedTaskInternal): BackgroundTaskSnapshot {
    const endMs = entry.completedAt ? Date.parse(entry.completedAt) : Date.now();
    return {
      taskId: entry.taskId,
      sessionId: entry.sessionId,
      command: entry.command,
      cwd: entry.cwd,
      pid: entry.pid,
      isDaemon: entry.isDaemon,
      status: entry.status,
      exitCode: entry.exitCode,
      startedAt: entry.startedAt,
      completedAt: entry.completedAt,
      durationMs: Math.max(0, endMs - entry.startedAtMs),
      stdout: entry.stdout,
      stderr: entry.stderr,
    };
  }
}

export const globalBackgroundTaskManager = new BackgroundTaskManager();
