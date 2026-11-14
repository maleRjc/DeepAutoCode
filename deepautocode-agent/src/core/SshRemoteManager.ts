/**
 * SSH Remote Development & Tunneling Manager
 * Inspired by OpenCode's packages/gui-plugins/src/ssh and packages/cli/src/ssh-askpass.
 * Enables DeepAutoCode to connect to remote Linux/cloud development servers,
 * establish secure port tunnels, execute remote commands, and bootstrap remote agent instances.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export interface SshTargetConfig {
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
  extraOptions?: string[];
  rawTarget: string;
}

export interface SshExecutionResult {
  ok: boolean;
  output: string;
  exitCode: number;
  durationMs: number;
  error?: string;
}

export interface SshTunnelHandle {
  tunnelId: string;
  localPort: number;
  remotePort: number;
  target: SshTargetConfig;
  alive: boolean;
  close: () => void;
}

export class SshRemoteManager {
  private static instance: SshRemoteManager | null = null;
  private activeTunnels = new Map<string, SshTunnelHandle>();

  public static getInstance(): SshRemoteManager {
    if (!SshRemoteManager.instance) {
      SshRemoteManager.instance = new SshRemoteManager();
    }
    return SshRemoteManager.instance;
  }

  public getSshExecutable(): string {
    return os.platform() === 'win32' ? 'ssh.exe' : 'ssh';
  }

  /**
   * Parse various SSH target strings (e.g. `user@host:22`, `ssh -i ~/.ssh/id_rsa user@host -p 2222`).
   */
  public parseTarget(input: string): SshTargetConfig {
    const raw = String(input || '').trim();
    if (!raw) {
      throw new Error('SSH target cannot be empty.');
    }

    const tokens = raw.split(/\s+/).filter(Boolean);
    if (tokens[0] === 'ssh' || tokens[0] === 'ssh.exe') {
      tokens.shift();
    }

    let host = '';
    let user: string | undefined;
    let port: number | undefined;
    let identityFile: string | undefined;
    const extraOptions: string[] = [];

    let i = 0;
    while (i < tokens.length) {
      const tok = tokens[i];
      if (tok === '-p' && i + 1 < tokens.length) {
        port = parseInt(tokens[++i], 10);
      } else if (tok === '-i' && i + 1 < tokens.length) {
        identityFile = tokens[++i];
      } else if (tok === '-o' && i + 1 < tokens.length) {
        extraOptions.push('-o', tokens[++i]);
      } else if (tok.startsWith('-')) {
        extraOptions.push(tok);
      } else if (!host) {
        // Parse user@host or user@host:port or host:port
        let targetHost = tok;
        if (targetHost.includes('@')) {
          const atIdx = targetHost.indexOf('@');
          user = targetHost.slice(0, atIdx);
          targetHost = targetHost.slice(atIdx + 1);
        }
        if (targetHost.includes(':')) {
          const [h, p] = targetHost.split(':');
          targetHost = h;
          if (p && !port) {
            port = parseInt(p, 10);
          }
        }
        host = targetHost;
      } else {
        extraOptions.push(tok);
      }
      i++;
    }

    if (!host) {
      throw new Error(`Invalid SSH target specification: "${input}"`);
    }

    return {
      host,
      user,
      port,
      identityFile,
      extraOptions,
      rawTarget: input,
    };
  }

  /**
   * Build standard command-line arguments for OpenSSH invocation.
   */
  public buildSshArgs(target: SshTargetConfig, command?: string): string[] {
    const args: string[] = [
      '-T',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'StrictHostKeyChecking=accept-new',
    ];

    if (target.port) {
      args.push('-p', String(target.port));
    }
    if (target.identityFile) {
      args.push('-i', target.identityFile);
    }
    if (target.extraOptions && target.extraOptions.length > 0) {
      args.push(...target.extraOptions);
    }

    const destination = target.user ? `${target.user}@${target.host}` : target.host;
    args.push(destination);

    if (command) {
      args.push(command);
    }

    return args;
  }

  /**
   * Test connectivity to the remote host.
   */
  public async checkConnection(target: SshTargetConfig, timeoutMs = 8000): Promise<{
    ok: boolean;
    banner?: string;
    error?: string;
  }> {
    const res = await this.execute(target, 'echo "DAC_SSH_PONG"', { timeoutMs });
    if (res.ok && res.output.includes('DAC_SSH_PONG')) {
      return { ok: true, banner: res.output.trim() };
    }
    return { ok: false, error: res.error || res.output || 'SSH connection probe failed' };
  }

  /**
   * Execute a remote command via SSH.
   */
  public async execute(
    target: SshTargetConfig,
    remoteCommand: string,
    options: { timeoutMs?: number; cwd?: string } = {}
  ): Promise<SshExecutionResult> {
    const startMs = Date.now();
    const timeoutMs = options.timeoutMs ?? 30_000;
    const sshCmd = this.getSshExecutable();

    const cmdToRun = options.cwd
      ? `cd ${options.cwd} && ${remoteCommand}`
      : remoteCommand;

    const args = this.buildSshArgs(target, cmdToRun);

    return new Promise<SshExecutionResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let killed = false;

      const child = spawn(sshCmd, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout?.setEncoding('utf-8');
      child.stderr?.setEncoding('utf-8');

      child.stdout?.on('data', (d) => { stdout += String(d); });
      child.stderr?.on('data', (d) => { stderr += String(d); });

      const timer = setTimeout(() => {
        killed = true;
        child.kill();
        resolve({
          ok: false,
          output: (stdout + '\n' + stderr).trim(),
          exitCode: -1,
          durationMs: Date.now() - startMs,
          error: `SSH execution timed out after ${timeoutMs}ms`,
        });
      }, timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timer);
        if (killed) return;
        const exitCode = code ?? 0;
        const combined = (stdout + (stderr ? '\n' + stderr : '')).trim();
        resolve({
          ok: exitCode === 0,
          output: combined,
          exitCode,
          durationMs: Date.now() - startMs,
          error: exitCode !== 0 ? stderr.trim() || `Process exited with code ${exitCode}` : undefined,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          ok: false,
          output: '',
          exitCode: -1,
          durationMs: Date.now() - startMs,
          error: `Failed to spawn SSH process: ${err.message}`,
        });
      });
    });
  }

  /**
   * Create an SSH Port Forwarding Tunnel (e.g. forward local port to remote DeepAutoCode backend).
   * Maps 127.0.0.1:<localPort> -> remote 127.0.0.1:<remotePort>
   */
  public async createTunnel(options: {
    target: SshTargetConfig;
    localPort: number;
    remotePort: number;
    tunnelId?: string;
  }): Promise<SshTunnelHandle> {
    const { target, localPort, remotePort } = options;
    const tunnelId = options.tunnelId || `tunnel_${localPort}_${remotePort}_${Date.now().toString(36)}`;
    const sshCmd = this.getSshExecutable();

    const args: string[] = [
      '-N', // Do not execute a remote command
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    ];

    if (target.port) args.push('-p', String(target.port));
    if (target.identityFile) args.push('-i', target.identityFile);
    if (target.extraOptions) args.push(...target.extraOptions);

    const destination = target.user ? `${target.user}@${target.host}` : target.host;
    args.push(destination);

    const child = spawn(sshCmd, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let isAlive = true;
    child.on('exit', () => { isAlive = false; });
    child.on('error', () => { isAlive = false; });

    const handle: SshTunnelHandle = {
      tunnelId,
      localPort,
      remotePort,
      target,
      get alive() {
        return isAlive && !child.killed;
      },
      close: () => {
        isAlive = false;
        try {
          if (!child.killed) child.kill();
        } catch {
          // ignore
        }
        this.activeTunnels.delete(tunnelId);
      },
    };

    this.activeTunnels.set(tunnelId, handle);
    return handle;
  }

  /**
   * Remote environment probe: detects Node.js, Git, OS architecture, and DeepAutoCode remote daemon status.
   */
  public async probeRemoteEnvironment(target: SshTargetConfig): Promise<{
    ok: boolean;
    os?: string;
    arch?: string;
    nodeVersion?: string;
    gitVersion?: string;
    remoteDacInstalled?: boolean;
    error?: string;
  }> {
    const probeScript = `
      printf "OS=%s\\n" "$(uname -s 2>/dev/null || echo unknown)"
      printf "ARCH=%s\\n" "$(uname -m 2>/dev/null || echo unknown)"
      printf "NODE=%s\\n" "$(node -v 2>/dev/null || echo none)"
      printf "GIT=%s\\n" "$(git --version 2>/dev/null || echo none)"
      printf "DAC=%s\\n" "$(which dac 2>/dev/null || which deepautocode 2>/dev/null || echo none)"
    `;

    const res = await this.execute(target, probeScript, { timeoutMs: 12000 });
    if (!res.ok) {
      return { ok: false, error: res.error || 'Failed to probe remote environment' };
    }

    const lines = res.output.split(/\r?\n/);
    const getVal = (prefix: string) => lines.find((l) => l.startsWith(prefix))?.slice(prefix.length).trim();

    const osName = getVal('OS=');
    const arch = getVal('ARCH=');
    const nodeVer = getVal('NODE=');
    const gitVer = getVal('GIT=');
    const dacPath = getVal('DAC=');

    return {
      ok: true,
      os: osName,
      arch,
      nodeVersion: nodeVer && nodeVer !== 'none' ? nodeVer : undefined,
      gitVersion: gitVer && gitVer !== 'none' ? gitVer : undefined,
      remoteDacInstalled: Boolean(dacPath && dacPath !== 'none'),
    };
  }

  public getTunnel(tunnelId: string): SshTunnelHandle | undefined {
    return this.activeTunnels.get(tunnelId);
  }

  public listTunnels(): SshTunnelHandle[] {
    return Array.from(this.activeTunnels.values());
  }

  public closeAllTunnels(): void {
    for (const t of this.activeTunnels.values()) {
      t.close();
    }
    this.activeTunnels.clear();
  }
}

