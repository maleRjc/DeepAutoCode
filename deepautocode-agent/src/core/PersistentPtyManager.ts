/**
 * Persistent PTY & Interactive Terminal Manager
 * Inspired by OpenCode's packages/core/src/persistent-pty.
 * Maintains stateful, long-lived terminal sessions (PowerShell / Bash) across agent turns,
 * preserving working directory, virtual environments (venv), and environment variables.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';

export interface TerminalSessionOptions {
  terminalId?: string;
  sessionId?: string;
  cwd: string;
  env?: Record<string, string>;
  shell?: string;
}

export interface TerminalExecutionResult {
  output: string;
  exitCode: number;
  durationMs: number;
}

export class PersistentTerminalSession {
  public readonly id: string;
  public readonly sessionId?: string;
  public readonly cwd: string;
  private child: ChildProcess;
  private isWindows: boolean;
  private buffer: string[] = [];
  private isAlive = true;
  private executionQueue: Promise<any> = Promise.resolve();

  constructor(options: TerminalSessionOptions) {
    this.id = options.terminalId ?? `term_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    this.sessionId = options.sessionId;
    this.cwd = options.cwd;
    this.isWindows = os.platform() === 'win32';

    const defaultShell = this.isWindows ? 'powershell.exe' : '/bin/bash';
    const shellCmd = options.shell || defaultShell;
    const shellArgs = this.isWindows
      ? ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass']
      : ['-i'];

    this.child = spawn(shellCmd, shellArgs, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.child.stdout?.setEncoding('utf-8');
    this.child.stderr?.setEncoding('utf-8');

    this.child.on('exit', () => {
      this.isAlive = false;
    });

    this.child.on('error', () => {
      this.isAlive = false;
    });
  }

  public get alive(): boolean {
    return this.isAlive && !this.child.killed;
  }

  /**
   * Run a command inside the persistent shell session and wait for completion.
   * Execution is strictly serialized per terminal session to prevent interleaving.
   */
  public async execute(command: string, timeoutMs: number = 30_000): Promise<TerminalExecutionResult> {
    const run = () => this.executeInternal(command, timeoutMs);
    const queued = this.executionQueue.then(run, run);
    this.executionQueue = queued;
    return queued;
  }

  private executeInternal(command: string, timeoutMs: number): Promise<TerminalExecutionResult> {
    if (!this.alive) {
      throw new Error(`Terminal session ${this.id} is closed or terminated.`);
    }

    const startMs = Date.now();
    const token = `__DAC_TERM_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}__`;

    // Drain any pending unread data from previous commands
    try {
      while (this.child.stdout?.read() !== null) {}
      while (this.child.stderr?.read() !== null) {}
    } catch {
      // Ignore drain errors
    }

    // Windows PowerShell vs Unix Bash wrapped invocation
    const wrappedCommand = this.isWindows
      ? `& { ${command.trim()} }; $ec = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }; [Console]::Out.WriteLine("${token}:$ec")\r\n`
      : `${command.trim()}; ec=$?; printf "\\n${token}:$ec\\n"\n`;

    return new Promise<TerminalExecutionResult>((resolve, reject) => {
      let accumulatedOutput = '';
      let timer: NodeJS.Timeout | null = null;
      const sentinelRegex = new RegExp(`${token}:(-?\\d+)`);

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        this.child.stdout?.removeListener('data', onData);
        this.child.stderr?.removeListener('data', onData);
      };

      const onData = (chunk: string | Buffer) => {
        const text = String(chunk);
        accumulatedOutput += text;

        const match = accumulatedOutput.match(sentinelRegex);
        if (match && typeof match.index === 'number') {
          const exitCode = parseInt(match[1], 10);
          let cleanOutput = accumulatedOutput.slice(0, match.index).trim();

          // Strip command echo if shell echoed the command line back
          const lines = cleanOutput.split(/\r?\n/);
          if (lines.length > 0 && lines[0].includes(token)) {
            lines.shift();
            cleanOutput = lines.join('\n').trim();
          }

          cleanup();
          this.buffer.push(cleanOutput);
          resolve({
            output: cleanOutput,
            exitCode: isNaN(exitCode) ? 0 : exitCode,
            durationMs: Date.now() - startMs,
          });
        }
      };

      this.child.stdout?.on('data', onData);
      this.child.stderr?.on('data', onData);

      timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Terminal execution timed out after ${timeoutMs}ms for command: ${command}`
          )
        );
      }, timeoutMs);

      // Write command to terminal stdin
      this.child.stdin?.write(wrappedCommand);
    });
  }

  /**
   * Write raw data directly to stdin (for interactive prompts like y/N).
   */
  public writeInput(data: string): void {
    if (!this.alive) {
      throw new Error(`Terminal session ${this.id} is closed.`);
    }
    this.child.stdin?.write(data.endsWith('\n') ? data : `${data}\n`);
  }

  /**
   * Get recent terminal outputs.
   */
  public getHistory(maxEntries: number = 20): string[] {
    return this.buffer.slice(-maxEntries);
  }

  /**
   * Terminate terminal session.
   */
  public close(): void {
    this.isAlive = false;
    try {
      if (this.child && !this.child.killed) {
        if (this.isWindows) {
          this.child.stdin?.write("exit\r\n");
          setTimeout(() => {
            if (!this.child.killed) this.child.kill('SIGKILL');
          }, 300);
        } else {
          this.child.kill('SIGTERM');
        }
      }
    } catch {
      // Ignore cleanup error
    }
  }
}

/**
 * Global Registry for Persistent Terminals.
 */
export class PersistentPtyManager {
  private static instance: PersistentPtyManager | null = null;
  private sessions = new Map<string, PersistentTerminalSession>();

  public static getInstance(): PersistentPtyManager {
    if (!PersistentPtyManager.instance) {
      PersistentPtyManager.instance = new PersistentPtyManager();
    }
    return PersistentPtyManager.instance;
  }

  public getOrCreateTerminal(options: TerminalSessionOptions): PersistentTerminalSession {
    const id = options.terminalId || (options.sessionId ? `term_${options.sessionId}` : 'default_term');
    const existing = this.sessions.get(id);
    if (existing && existing.alive) {
      return existing;
    }
    const session = new PersistentTerminalSession({ ...options, terminalId: id });
    this.sessions.set(id, session);
    return session;
  }

  public getTerminal(terminalId: string): PersistentTerminalSession | undefined {
    return this.sessions.get(terminalId);
  }

  public listTerminals(): Array<{ id: string; alive: boolean; sessionId?: string; cwd: string }> {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      alive: s.alive,
      sessionId: s.sessionId,
      cwd: s.cwd,
    }));
  }

  public closeTerminal(terminalId: string): boolean {
    const session = this.sessions.get(terminalId);
    if (session) {
      session.close();
      this.sessions.delete(terminalId);
      return true;
    }
    return false;
  }

  public closeAll(): void {
    for (const session of this.sessions.values()) {
      session.close();
    }
    this.sessions.clear();
  }
}

