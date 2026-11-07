import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FileTreeNode } from './workbench-server/server.js';

const execFileAsync = promisify(execFile);

export interface SshHostProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: 'password' | 'agent-or-default-key' | 'identity-file' | 'local-loopback';
  password?: string;
  identityFile?: string;
  remotePath: string;
  source?: 'user' | 'ssh-config';
  lastConnectedAt?: string;
}

export interface SshConnectionStatus {
  connected: boolean;
  activeProfile?: SshHostProfile;
  remoteOsInfo?: string;
  latencyMs?: number;
  mirrorWorkspaceRoot?: string;
  connectedAt?: string;
}

export interface SshTestResult {
  ok: boolean;
  host: string;
  port: number;
  tcpReachable: boolean;
  sshAuthenticated: boolean;
  latencyMs: number;
  remoteOsInfo?: string;
  remoteHomeDir?: string;
  message: string;
  remediation?: string;
}

export class SshRemoteManager {
  private profilesFilePath: string;
  private mirrorsRootDir: string;
  private activeProfile: SshHostProfile | null = null;
  private remoteOsInfo = '';
  private lastLatencyMs = 0;
  private connectedAt = '';
  private mirrorWorkspaceRoot = '';

  constructor(private readonly dataRoot: string) {
    this.profilesFilePath = path.join(dataRoot, 'ssh-profiles.json');
    this.mirrorsRootDir = path.join(dataRoot, 'ssh-mirrors');
  }

  getStatus(): SshConnectionStatus {
    if (!this.activeProfile) {
      return { connected: false };
    }
    return {
      connected: true,
      activeProfile: this.activeProfile,
      remoteOsInfo: this.remoteOsInfo,
      latencyMs: this.lastLatencyMs,
      mirrorWorkspaceRoot: this.mirrorWorkspaceRoot,
      connectedAt: this.connectedAt,
    };
  }

  /**
   * Parse ~/.ssh/config to auto-discover existing SSH Host entries (like VS Code / Cursor Remote-SSH)
   */
  async discoverSshConfigHosts(): Promise<SshHostProfile[]> {
    const sshConfigPath = path.join(os.homedir(), '.ssh', 'config');
    try {
      const content = await fs.readFile(sshConfigPath, 'utf-8');
      const lines = content.split(/\r?\n/);
      const discovered: SshHostProfile[] = [];
      let current: Partial<SshHostProfile> | null = null;

      const flushCurrent = () => {
        if (current && current.name && current.name !== '*' && !current.name.includes('*')) {
          discovered.push({
            id: `sshcfg_${current.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
            name: current.name,
            host: current.host || current.name,
            port: current.port || 22,
            username: current.username || os.userInfo().username || 'root',
            authMethod: current.identityFile ? 'identity-file' : 'agent-or-default-key',
            identityFile: current.identityFile,
            remotePath: '~',
            source: 'ssh-config',
          });
        }
        current = null;
      };

      for (const rawLine of lines) {
        const line = rawLine.replace(/#.*$/, '').trim();
        if (!line) continue;
        const match = line.match(/^([a-zA-Z0-9]+)\s+(.+)$/);
        if (!match) continue;
        const key = match[1].toLowerCase();
        const val = match[2].trim().replace(/^["']|["']$/g, '');

        if (key === 'host') {
          flushCurrent();
          current = { name: val };
        } else if (current) {
          if (key === 'hostname') current.host = val;
          else if (key === 'user') current.username = val;
          else if (key === 'port') current.port = Number(val) || 22;
          else if (key === 'identityfile') current.identityFile = val;
        }
      }
      flushCurrent();
      return discovered;
    } catch {
      return [];
    }
  }

  async listProfiles(): Promise<SshHostProfile[]> {
    let saved: SshHostProfile[] = [];
    try {
      const raw = await fs.readFile(this.profilesFilePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) saved = parsed;
    } catch {
      saved = [];
    }

    const fromConfig = await this.discoverSshConfigHosts();
    const savedIds = new Set(saved.map((p) => p.id));
    const savedHosts = new Set(saved.map((p) => `${p.username}@${p.host}:${p.port}`));

    const merged = [...saved];
    for (const cfgHost of fromConfig) {
      const key = `${cfgHost.username}@${cfgHost.host}:${cfgHost.port}`;
      if (!savedIds.has(cfgHost.id) && !savedHosts.has(key)) {
        merged.push(cfgHost);
      }
    }

    return merged;
  }

  async saveProfile(profileInput: Partial<SshHostProfile>): Promise<SshHostProfile[]> {
    const existing = await this.listProfiles();
    const userSaved = existing.filter((p) => p.source !== 'ssh-config');

    const id =
      profileInput.id && !profileInput.id.startsWith('sshcfg_')
        ? profileInput.id
        : `ssh_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    const existingMatch = userSaved.find(
      (p) =>
        p.id === id ||
        (p.host === (profileInput.host || '127.0.0.1').trim() &&
          p.username === (profileInput.username || 'root').trim() &&
          p.port === (Number(profileInput.port) || 22))
    );

    const resolvedPassword =
      profileInput.password !== undefined
        ? profileInput.password
        : existingMatch?.password;

    const cleanProfile: SshHostProfile = {
      id: existingMatch?.id || id,
      name:
        (profileInput.name || '').trim() ||
        `${profileInput.username || 'root'}@${profileInput.host || '127.0.0.1'}`,
      host: (profileInput.host || '127.0.0.1').trim(),
      port: Number(profileInput.port) || 22,
      username: (profileInput.username || 'root').trim(),
      authMethod:
        profileInput.authMethod ||
        (resolvedPassword ? 'password' : 'agent-or-default-key'),
      password: resolvedPassword || undefined,
      identityFile: profileInput.identityFile?.trim() || undefined,
      remotePath: (profileInput.remotePath || '~').trim(),
      source: 'user',
      lastConnectedAt: profileInput.lastConnectedAt,
    };

    const idx = userSaved.findIndex((p) => p.id === cleanProfile.id);
    if (idx >= 0) {
      userSaved[idx] = cleanProfile;
    } else {
      userSaved.unshift(cleanProfile);
    }

    await fs.mkdir(path.dirname(this.profilesFilePath), { recursive: true });
    await fs.writeFile(this.profilesFilePath, JSON.stringify(userSaved, null, 2), 'utf-8');
    return this.listProfiles();
  }

  async deleteProfile(profileId: string): Promise<SshHostProfile[]> {
    const existing = await this.listProfiles();
    const nextUserSaved = existing.filter((p) => p.source === 'user' && p.id !== profileId);
    await fs.mkdir(path.dirname(this.profilesFilePath), { recursive: true });
    await fs.writeFile(this.profilesFilePath, JSON.stringify(nextUserSaved, null, 2), 'utf-8');
    return this.listProfiles();
  }

  private buildSshArgs(profile: SshHostProfile, remoteCommand: string): string[] {
    const hasPassword = Boolean(profile.password && profile.password.length > 0);
    const args: string[] = [
      '-p',
      String(profile.port || 22),
      '-o',
      hasPassword ? 'BatchMode=no' : 'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'ConnectTimeout=8',
    ];
    if (hasPassword) {
      args.push(
        '-o',
        'PasswordAuthentication=yes',
        '-o',
        'KbdInteractiveAuthentication=yes',
        '-o',
        'NumberOfPasswordPrompts=1'
      );
    }
    if (profile.authMethod === 'identity-file' && profile.identityFile) {
      const resolvedKey = profile.identityFile.startsWith('~')
        ? path.join(os.homedir(), profile.identityFile.slice(1))
        : profile.identityFile;
      args.push('-i', resolvedKey);
    }
    args.push(`${profile.username}@${profile.host}`, remoteCommand);
    return args;
  }

  private askPassHelperPath: string | null = null;
  private pulledFileTimestampMap = new Map<string, number>();

  private async ensureAskPassHelper(): Promise<string> {
    if (this.askPassHelperPath) {
      return this.askPassHelperPath;
    }
    await fs.mkdir(this.dataRoot, { recursive: true });
    if (process.platform === 'win32') {
      const helperPath = path.join(this.dataRoot, 'dac-ssh-askpass.cmd');
      const script = `@echo off\r\n"${process.execPath}" -e "process.stdout.write((process.env.DEEPAUTOCODE_SSH_PASS || '') + '\\n')"\r\n`;
      await fs.writeFile(helperPath, script, 'utf-8');
      this.askPassHelperPath = helperPath;
      return helperPath;
    } else {
      const helperPath = path.join(this.dataRoot, 'dac-ssh-askpass.sh');
      const script = `#!/bin/sh\nprintf '%s\\n' "$DEEPAUTOCODE_SSH_PASS"\n`;
      await fs.writeFile(helperPath, script, { encoding: 'utf-8', mode: 0o700 });
      this.askPassHelperPath = helperPath;
      return helperPath;
    }
  }

  private sshActiveCount = 0;
  private sshWaitQueue: Array<() => void> = [];

  private async acquireSshSlot(): Promise<() => void> {
    const MAX_CONCURRENT_SSH = 6;
    if (this.sshActiveCount < MAX_CONCURRENT_SSH) {
      this.sshActiveCount++;
    } else {
      await new Promise<void>((resolve) => this.sshWaitQueue.push(resolve));
      this.sshActiveCount++;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.sshActiveCount--;
      const next = this.sshWaitQueue.shift();
      if (next) next();
    };
  }

  private async execSsh(
    profile: SshHostProfile,
    remoteCommand: string,
    options?: { timeout?: number; maxBuffer?: number }
  ): Promise<{ stdout: string; stderr: string }> {
    const release = await this.acquireSshSlot();
    try {
      const sshArgs = this.buildSshArgs(profile, remoteCommand);
      const hasPassword = Boolean(profile.password && profile.password.length > 0);
      const env: NodeJS.ProcessEnv = { ...process.env };

      if (hasPassword) {
        const askPassScript = await this.ensureAskPassHelper();
        env.SSH_ASKPASS = askPassScript;
        env.SSH_ASKPASS_REQUIRE = 'force';
        env.DISPLAY = env.DISPLAY || '127.0.0.1:0.0';
        env.DEEPAUTOCODE_SSH_PASS = profile.password;
      }

      const execOpts = {
        timeout: options?.timeout ?? 15000,
        maxBuffer: options?.maxBuffer ?? 8 * 1024 * 1024,
        env,
      };

      try {
        return await execFileAsync('ssh', sshArgs, execOpts);
      } catch (err: any) {
        const msg = String(err?.stderr || err?.message || '');
        const isTransientHandshakeErr =
          /Connection reset|Connection closed|kex_exchange_identification|Connection timed out/i.test(
            msg
          );
        if (isTransientHandshakeErr) {
          await new Promise((r) => setTimeout(r, 250));
          return await execFileAsync('ssh', sshArgs, execOpts);
        }
        throw err;
      }
    } finally {
      release();
    }
  }

  private async tryInstallLocalPublicKey(profile: SshHostProfile): Promise<boolean> {
    if (!profile.password) return false;
    const sshDir = path.join(os.homedir(), '.ssh');
    const pubKeyCandidates = [
      path.join(sshDir, 'id_ed25519.pub'),
      path.join(sshDir, 'id_rsa.pub'),
    ];
    let pubKeyContent = '';
    for (const candidate of pubKeyCandidates) {
      try {
        const raw = (await fs.readFile(candidate, 'utf-8')).trim();
        if (raw.startsWith('ssh-')) {
          pubKeyContent = raw;
          break;
        }
      } catch {
        // try next
      }
    }
    if (!pubKeyContent) return false;

    try {
      const b64Key = Buffer.from(pubKeyContent, 'utf-8').toString('base64');
      const installCmd =
        `mkdir -p ~/.ssh && chmod 700 ~/.ssh && ` +
        `KEY=$(echo "${b64Key}" | base64 -d) && ` +
        `(grep -qxF "$KEY" ~/.ssh/authorized_keys 2>/dev/null || echo "$KEY" >> ~/.ssh/authorized_keys) && ` +
        `chmod 600 ~/.ssh/authorized_keys`;
      await this.execSsh(profile, installCmd, { timeout: 8000 });
      return true;
    } catch {
      return false;
    }
  }

  private async probeTcpSocket(
    host: string,
    port: number,
    timeoutMs = 5000
  ): Promise<{ reachable: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let settled = false;
      const finish = (reachable: boolean, error?: string) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve({ reachable, latencyMs: Date.now() - start, error });
      };

      socket.setTimeout(timeoutMs);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false, `TCP connection timed out (${timeoutMs}ms)`));
      socket.once('error', (err) => finish(false, err.message));
      socket.connect(port, host);
    });
  }

  async testConnection(profileInput: Partial<SshHostProfile>): Promise<SshTestResult> {
    let resolvedPassword = profileInput.password;
    if (!resolvedPassword) {
      const saved = await this.listProfiles();
      const match = saved.find(
        (p) =>
          p.host === (profileInput.host || '127.0.0.1').trim() &&
          p.username === (profileInput.username || 'root').trim() &&
          p.port === (Number(profileInput.port) || 22)
      );
      if (match?.password) {
        resolvedPassword = match.password;
      }
    }

    const profile: SshHostProfile = {
      id: profileInput.id || 'test',
      name: profileInput.name || 'Test Host',
      host: (profileInput.host || '127.0.0.1').trim(),
      port: Number(profileInput.port) || 22,
      username: (profileInput.username || 'root').trim(),
      authMethod:
        profileInput.authMethod ||
        (resolvedPassword ? 'password' : 'agent-or-default-key'),
      password: resolvedPassword || undefined,
      identityFile: profileInput.identityFile?.trim() || undefined,
      remotePath: (profileInput.remotePath || '~').trim(),
    };

    if (profile.authMethod === 'local-loopback') {
      const targetDir = path.resolve(profile.remotePath === '~' ? os.homedir() : profile.remotePath);
      try {
        const stat = await fs.stat(targetDir);
        if (!stat.isDirectory()) {
          throw new Error(`Path is not a directory: ${targetDir}`);
        }
        return {
          ok: true,
          host: profile.host,
          port: profile.port,
          tcpReachable: true,
          sshAuthenticated: true,
          latencyMs: 2,
          remoteOsInfo: `${os.type()} ${os.release()} (${os.arch()}) [Local SSH Loopback]`,
          remoteHomeDir: targetDir,
          message: `SSH Loopback 通道验证成功 (${targetDir})`,
        };
      } catch (err) {
        return {
          ok: false,
          host: profile.host,
          port: profile.port,
          tcpReachable: true,
          sshAuthenticated: false,
          latencyMs: 2,
          message: `目标目录不存在或不可访问: ${(err as Error).message}`,
          remediation: '请检查 Remote Path 是否为有效目录路径。',
        };
      }
    }

    const tcpProbe = await this.probeTcpSocket(profile.host, profile.port, 5000);
    if (!tcpProbe.reachable) {
      return {
        ok: false,
        host: profile.host,
        port: profile.port,
        tcpReachable: false,
        sshAuthenticated: false,
        latencyMs: tcpProbe.latencyMs,
        message: `无法连接到远程主机 ${profile.host}:${profile.port} (${tcpProbe.error || 'TCP Unreachable'})`,
        remediation:
          '1. 请确认远程服务器 IP/域名与 SSH 端口 (默认 22) 正确且防火墙已放行；\n2. 若在本地测试，可将认证方式切换为 "Local SSH Loopback (本地远程模拟)"。',
      };
    }

    const startSsh = Date.now();
    try {
      const { stdout } = await this.execSsh(
        profile,
        'uname -srm 2>/dev/null || ver; pwd',
        { timeout: 10000 }
      );
      if (profile.password) {
        void this.tryInstallLocalPublicKey(profile);
      }
      const lines = stdout
        .trim()
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const osInfo = lines[0] || 'Remote SSH Host';
      const homeDir = lines[lines.length - 1] || '/root';

      return {
        ok: true,
        host: profile.host,
        port: profile.port,
        tcpReachable: true,
        sshAuthenticated: true,
        latencyMs: Date.now() - startSsh,
        remoteOsInfo: osInfo,
        remoteHomeDir: homeDir,
        message: `SSH 认证与远程环境握手成功 (${osInfo})`,
      };
    } catch (err: any) {
      const stderr = String(err?.stderr || err?.message || '').trim();
      const missingPassHint = !profile.password
        ? `请在上方「SSH Password (登录密码)」输入框中填写 ${profile.username}@${profile.host} 的密码后再点击测试或连接（首次密码连接成功后会自动为您配置免密公钥）。`
        : `请检查输入的 SSH 密码是否正确，或确认已配置 SSH 公钥免密登录 (~/.ssh/id_rsa / ~/.ssh/id_ed25519)。`;
      return {
        ok: false,
        host: profile.host,
        port: profile.port,
        tcpReachable: true,
        sshAuthenticated: false,
        latencyMs: Date.now() - startSsh,
        message: `TCP 端口已连通 (${tcpProbe.latencyMs}ms)，但 SSH 免密/密钥认证未通过: ${stderr.slice(0, 180)}`,
        remediation: missingPassHint,
      };
    }
  }

  /**
   * Execute a shell command on the active remote SSH host inside its remote workspace path
   */
  async execRemoteCommand(
    command: string,
    cwdOverride?: string
  ): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }> {
    if (!this.activeProfile) {
      throw new Error('SSH_NOT_CONNECTED: No active SSH remote connection');
    }

    const profile = this.activeProfile;
    const remoteDir = cwdOverride || profile.remotePath || '~';
    const start = Date.now();

    if (profile.authMethod === 'local-loopback') {
      const resolvedCwd = path.resolve(remoteDir === '~' ? os.homedir() : remoteDir);
      const { exec } = await import('node:child_process');
      const execAsync = promisify(exec);
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: resolvedCwd,
          timeout: 300000,
        });
        return {
          exitCode: 0,
          stdout: stdout || '',
          stderr: stderr || '',
          durationMs: Date.now() - start,
        };
      } catch (err: any) {
        return {
          exitCode: typeof err?.code === 'number' ? err.code : 1,
          stdout: err?.stdout || '',
          stderr: err?.stderr || err?.message || 'Command failed',
          durationMs: Date.now() - start,
        };
      }
    }

    const wrappedCmd =
      remoteDir === '~'
        ? command
        : `cd ${this.quoteRemotePath(remoteDir)} && ${command}`;

    try {
      const { stdout, stderr } = await this.execSsh(profile, wrappedCmd, {
        timeout: 300000,
        maxBuffer: 16 * 1024 * 1024,
      });
      return {
        exitCode: 0,
        stdout: stdout || '',
        stderr: stderr || '',
        durationMs: Date.now() - start,
      };
    } catch (err: any) {
      return {
        exitCode: typeof err?.code === 'number' ? err.code : 1,
        stdout: err?.stdout || '',
        stderr: err?.stderr || err?.message || 'Remote SSH command failed',
        durationMs: Date.now() - start,
      };
    }
  }

  private quoteRemotePath(p: string): string {
    if (p.startsWith('~/')) {
      return `"$HOME/${p.slice(2).replace(/"/g, '\\"')}"`;
    }
    if (p === '~') {
      return '"$HOME"';
    }
    return `"${p.replace(/"/g, '\\"')}"`;
  }

  /**
   * List subdirectories on the remote host to let the user browse remote folders visually
   */
  async browseRemoteDirectories(
    profileInput: Partial<SshHostProfile>,
    targetDir = '~'
  ): Promise<{ currentDir: string; directories: string[]; files: string[] }> {
    let resolvedPassword = profileInput.password || this.activeProfile?.password;
    if (!resolvedPassword) {
      const saved = await this.listProfiles();
      const match = saved.find(
        (p) =>
          p.host === (profileInput.host || '127.0.0.1').trim() &&
          p.username === (profileInput.username || 'root').trim() &&
          p.port === (Number(profileInput.port) || 22)
      );
      if (match?.password) {
        resolvedPassword = match.password;
      }
    }

    const tempProfile: SshHostProfile = {
      id: profileInput.id || 'browse',
      name: profileInput.name || 'Browse',
      host: (profileInput.host || '127.0.0.1').trim(),
      port: Number(profileInput.port) || 22,
      username: (profileInput.username || 'root').trim(),
      authMethod:
        profileInput.authMethod ||
        (resolvedPassword ? 'password' : 'agent-or-default-key'),
      password: resolvedPassword || undefined,
      identityFile: profileInput.identityFile?.trim() || undefined,
      remotePath: targetDir,
    };

    if (tempProfile.authMethod === 'local-loopback') {
      const abs = path.resolve(targetDir === '~' ? os.homedir() : targetDir);
      const entries = await fs.readdir(abs, { withFileTypes: true });
      const directories: string[] = [];
      const files: string[] = [];
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        if (e.isDirectory()) directories.push(e.name);
        else files.push(e.name);
      }
      return { currentDir: abs, directories: directories.slice(0, 80), files: files.slice(0, 80) };
    }

    const cmd = `cd ${this.quoteRemotePath(targetDir)} && pwd && ls -1Lp`;
    const { stdout } = await this.execSsh(tempProfile, cmd, { timeout: 10000 });
    const lines = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const resolvedPwd = lines[0] || targetDir;
    const directories: string[] = [];
    const files: string[] = [];

    for (const item of lines.slice(1)) {
      if (item.endsWith('/')) {
        directories.push(item.slice(0, -1));
      } else {
        files.push(item);
      }
    }

    return {
      currentDir: resolvedPwd,
      directories: directories.slice(0, 500),
      files: files.slice(0, 500),
    };
  }

  /**
   * Connect to a remote SSH host and synchronize remote workspace metadata/files into a local mirror
   * so the Editor, File Tree, Terminal, Git, and @cline/sdk Agent all operate seamlessly.
   */
  async connect(profileInput: Partial<SshHostProfile>): Promise<{
    status: SshConnectionStatus;
    workspaceRoot: string;
    workspaceDisplayLabel: string;
  }> {
    const testRes = await this.testConnection(profileInput);
    if (!testRes.ok) {
      throw new Error(testRes.message);
    }

    // Normalize remotePath (e.g. resolve /root/.. -> / or ~ -> /root)
    let requestedPath = (profileInput.remotePath || '~').trim();
    if (requestedPath !== '~' && !requestedPath.startsWith('~/')) {
      requestedPath = path.posix.normalize(requestedPath);
    } else if (requestedPath === '~' && testRes.remoteHomeDir) {
      requestedPath = testRes.remoteHomeDir;
    }

    const savedList = await this.saveProfile({
      ...profileInput,
      remotePath: requestedPath,
      lastConnectedAt: new Date().toISOString(),
    });
    const matched =
      savedList.find(
        (p) =>
          p.host === (profileInput.host || '127.0.0.1').trim() &&
          p.username === (profileInput.username || 'root').trim()
      ) || savedList[0];

    matched.remotePath = requestedPath;
    this.activeProfile = matched;
    this.remoteOsInfo = testRes.remoteOsInfo || 'Remote SSH Host';
    this.lastLatencyMs = testRes.latencyMs;
    this.connectedAt = new Date().toISOString();

    if (matched.authMethod === 'local-loopback') {
      const resolvedLocal = path.resolve(
        matched.remotePath === '~' ? os.homedir() : matched.remotePath
      );
      this.mirrorWorkspaceRoot = resolvedLocal;
      return {
        status: this.getStatus(),
        workspaceRoot: this.mirrorWorkspaceRoot,
        workspaceDisplayLabel: `[SSH: ${matched.username}@${matched.host}] ${
          path.basename(resolvedLocal) || resolvedLocal
        }`,
      };
    }

    // Create local mirror workspace for @cline/sdk Agent & Code Editor
    const safeHostSlug = `${matched.username}_${matched.host}_${matched.port}`.replace(
      /[^a-zA-Z0-9_-]/g,
      '_'
    );
    const remoteBaseName =
      matched.remotePath === '/'
        ? 'rootfs'
        : path.posix.basename(matched.remotePath.replace(/\/+$/, '')) || 'workspace';
    const mirrorDir = path.join(this.mirrorsRootDir, safeHostSlug, remoteBaseName);
    await fs.mkdir(mirrorDir, { recursive: true });
    this.mirrorWorkspaceRoot = mirrorDir;

    // Synchronize initial directory structure and key text files from remote SSH workspace
    await this.syncRemoteWorkspaceToMirror(matched, mirrorDir);

    const displayDir = matched.remotePath === '/' ? '/' : remoteBaseName;
    return {
      status: this.getStatus(),
      workspaceRoot: this.mirrorWorkspaceRoot,
      workspaceDisplayLabel: `[SSH: ${matched.username}@${matched.host}] ${displayDir}`,
    };
  }

  async refreshActiveMirror(): Promise<void> {
    if (!this.activeProfile || !this.mirrorWorkspaceRoot) return;
    if (this.activeProfile.authMethod === 'local-loopback') return;
    await this.syncRemoteWorkspaceToMirror(this.activeProfile, this.mirrorWorkspaceRoot);
  }

  private async syncRemoteWorkspaceToMirror(
    profile: SshHostProfile,
    mirrorDir: string
  ): Promise<void> {
    try {
      const isRootOrTopSystemDir =
        profile.remotePath === '/' ||
        /^\/(home|usr|var|etc|lib|proc|sys|dev)\/?$/.test(profile.remotePath);
      const isUserHomeDir = /^(\/root|\/home\/[^/]+)\/?$/.test(profile.remotePath);
      const maxDeepDepth = isUserHomeDir ? 3 : 5;

      // Breadth-first remote discovery:
      // 1) First list 100% of immediate (depth 1) folders (including symlinked dirs via -L) and files so NO top-level folder is ever truncated
      // 2) Then list depth 2..maxDeepDepth children (skipping heavy caches like conda/node_modules/.cache/build artifacts)
      const level1Cmd =
        `find -L . -maxdepth 1 -mindepth 1 \\( -name '.?*' -o -name proc -o -name sys -o -name dev -o -name run \\) -prune -o -type d -print 2>/dev/null | sed 's|^\\./||; s|^|D:|'; ` +
        `find -L . -maxdepth 1 -mindepth 1 \\( -name '.?*' -o -name proc -o -name sys -o -name dev -o -name run \\) -prune -o -type f -print 2>/dev/null | sed 's|^\\./||; s|^|F:|'`;
      const level2Cmd = isRootOrTopSystemDir
        ? ''
        : `; find . -mindepth 2 -maxdepth ${maxDeepDepth} \\( -name '.?*' -o -name node_modules -o -name __pycache__ -o -name '*conda*' -o -name venv -o -name .venv -o -name CMakeFiles \\) -prune -o -type d -print 2>/dev/null | head -n 2000 | sed 's|^\\./||; s|^|D:|'` +
          `; find . -mindepth 2 -maxdepth ${maxDeepDepth} \\( -name '.?*' -o -name node_modules -o -name __pycache__ -o -name '*conda*' -o -name venv -o -name .venv -o -name CMakeFiles \\) -prune -o -type f -print 2>/dev/null | head -n 2500 | sed 's|^\\./||; s|^|F:|'`;

      const singleShotFindCmd = `cd ${this.quoteRemotePath(profile.remotePath)} && pwd && (${level1Cmd}${level2Cmd})`;
      const { stdout } = await this.execSsh(profile, singleShotFindCmd, {
        timeout: 20000,
        maxBuffer: 8 * 1024 * 1024,
      });

      const outLines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (outLines.length > 0 && outLines[0].startsWith('/')) {
        profile.remotePath = outLines[0];
      }

      const dirs: string[] = [];
      const files: string[] = [];

      for (const line of outLines) {
        if (line.startsWith('D:')) {
          const d = line.slice(2).trim();
          if (d && d !== '.') dirs.push(d);
        } else if (line.startsWith('F:')) {
          const f = line.slice(2).trim();
          if (f && f !== '.') files.push(f);
        }
      }

      // Also supplement top-level entries with `ls -1Lp` so any special symlinked folders or non-standard entries are guaranteed present
      try {
        const lsCmd = `cd ${this.quoteRemotePath(profile.remotePath)} && ls -1Lp 2>/dev/null`;
        const { stdout: lsOut } = await this.execSsh(profile, lsCmd, { timeout: 8000 });
        const existingDirs = new Set(dirs);
        const existingFiles = new Set(files);
        for (const item of lsOut.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
          if (item.endsWith('/')) {
            const dName = item.slice(0, -1);
            if (dName && !existingDirs.has(dName)) {
              dirs.unshift(dName);
              existingDirs.add(dName);
            }
          } else if (item && !existingFiles.has(item)) {
            files.unshift(item);
            existingFiles.add(item);
          }
        }
      } catch {
        // ignore ls supplement error
      }

      for (const relDir of dirs.slice(0, 3000)) {
        const localDir = path.join(mirrorDir, relDir);
        await fs.mkdir(localDir, { recursive: true });
      }

      for (const relFile of files.slice(0, 3000)) {
        const localTarget = path.join(mirrorDir, relFile);
        await fs.mkdir(path.dirname(localTarget), { recursive: true });
        try {
          await fs.access(localTarget);
        } catch {
          await fs.writeFile(localTarget, '', 'utf-8');
        }
      }

      // Eagerly fetch top-level documentation & entry files (at most 4 files to keep SSH connection fast)
      const priorityFiles = files
        .filter((p) =>
          /^(README|Makefile|CMakeLists\.txt|package\.json|Cargo\.toml|pyproject\.toml|go\.mod|main\.|index\.)/i.test(
            p
          )
        )
        .slice(0, 4);

      for (const relFile of priorityFiles) {
        await this.pullRemoteFileToMirror(relFile).catch(() => undefined);
      }
    } catch (err) {
      console.error('[DeepAutoCode SSH Mirror] Sync warning:', (err as Error)?.message || err);
    }
  }

  /**
   * Pull a single file from the remote SSH server into the local mirror workspace on-demand.
   * Uses a 30s local mirror freshness cache so consecutive partial-line reads of the same file
   * return in <1ms without spawning redundant ssh.exe handshakes.
   */
  async pullRemoteBinaryFileToMirror(relFilePath: string, force = false): Promise<Buffer | null> {
    if (!this.activeProfile || !this.mirrorWorkspaceRoot) return null;
    if (this.activeProfile.authMethod === 'local-loopback') return null;

    const cleanRel = relFilePath.replace(/\\/g, '/').replace(/^\/+/, '');
    const localTarget = path.join(this.mirrorWorkspaceRoot, cleanRel);

    if (!force) {
      const lastPulledAt = this.pulledFileTimestampMap.get(cleanRel) ?? 0;
      if (Date.now() - lastPulledAt < 30_000) {
        try {
          const cachedBuf = await fs.readFile(localTarget);
          if (cachedBuf.byteLength > 0) {
            return cachedBuf;
          }
        } catch {
          // cache miss
        }
      }
    }

    const cmd = `cd ${this.quoteRemotePath(this.activeProfile.remotePath)} && head -c 15728640 "${cleanRel.replace(
      /"/g,
      '\\"'
    )}" | base64 -w 0`;
    const { stdout } = await this.execSsh(this.activeProfile, cmd, {
      timeout: 30000,
      maxBuffer: 24 * 1024 * 1024,
    });
    const b64 = stdout.trim();
    if (!b64) return null;
    const buf = Buffer.from(b64, 'base64');
    await fs.mkdir(path.dirname(localTarget), { recursive: true });
    await fs.writeFile(localTarget, buf);
    this.pulledFileTimestampMap.set(cleanRel, Date.now());
    return buf;
  }

  async pullRemoteFileToMirror(relFilePath: string, force = false): Promise<string | null> {
    if (!this.activeProfile || !this.mirrorWorkspaceRoot) return null;
    if (this.activeProfile.authMethod === 'local-loopback') return null;

    const cleanRel = relFilePath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (/\.(?:pdf|png|jpg|jpeg|gif|webp|ico|zip)$/i.test(cleanRel)) {
      const bin = await this.pullRemoteBinaryFileToMirror(cleanRel, force);
      return bin ? bin.toString('utf-8') : null;
    }
    const localTarget = path.join(this.mirrorWorkspaceRoot, cleanRel);

    if (!force) {
      const lastPulledAt = this.pulledFileTimestampMap.get(cleanRel) ?? 0;
      if (Date.now() - lastPulledAt < 30_000) {
        try {
          const cachedContent = await fs.readFile(localTarget, 'utf-8');
          if (cachedContent.length > 0) {
            return cachedContent;
          }
        } catch {
          // cache miss on disk, proceed to pull
        }
      }
    }

    const cmd = `cd ${this.quoteRemotePath(this.activeProfile.remotePath)} && head -c 1048576 "${cleanRel.replace(
      /"/g,
      '\\"'
    )}"`;
    const { stdout } = await this.execSsh(this.activeProfile, cmd, {
      timeout: 15000,
      maxBuffer: 8 * 1024 * 1024,
    });
    await fs.mkdir(path.dirname(localTarget), { recursive: true });
    await fs.writeFile(localTarget, stdout, 'utf-8');
    this.pulledFileTimestampMap.set(cleanRel, Date.now());
    return stdout;
  }

  /**
   * Push a modified file from the local mirror workspace back to the remote SSH server.
   * Automatically chunks files > 16KB to stay well below Windows CreateProcess 32KB command-line limit.
   */
  async pushMirrorFileToRemote(relFilePath: string, content: string): Promise<void> {
    if (!this.activeProfile || this.activeProfile.authMethod === 'local-loopback') return;

    const cleanRel = relFilePath.replace(/\\/g, '/').replace(/^\/+/, '');
    this.pulledFileTimestampMap.set(cleanRel, Date.now());
    const rawBuf = Buffer.from(content, 'utf-8');
    const relDir = path.posix.dirname(cleanRel);
    const escapedRel = cleanRel.replace(/"/g, '\\"');
    const mkdirPart =
      relDir && relDir !== '.' ? `mkdir -p "${relDir.replace(/"/g, '\\"')}" && ` : '';

    const CHUNK_BYTES = 16384;
    if (rawBuf.length === 0) {
      const cmd =
        `cd ${this.quoteRemotePath(this.activeProfile.remotePath)} && ` +
        `${mkdirPart}: > "${escapedRel}"`;
      await this.execSsh(this.activeProfile, cmd, { timeout: 15000 });
      return;
    }

    for (let offset = 0; offset < rawBuf.length; offset += CHUNK_BYTES) {
      const slice = rawBuf.subarray(offset, Math.min(offset + CHUNK_BYTES, rawBuf.length));
      const b64 = slice.toString('base64');
      const redirectOp = offset === 0 ? '>' : '>>';
      const prefix = offset === 0 ? mkdirPart : '';
      const cmd =
        `cd ${this.quoteRemotePath(this.activeProfile.remotePath)} && ` +
        `${prefix}printf '%s' "${b64}" | base64 -d ${redirectOp} "${escapedRel}"`;
      await this.execSsh(this.activeProfile, cmd, { timeout: 20000 });
    }
  }

  disconnect(): SshConnectionStatus {
    this.activeProfile = null;
    this.remoteOsInfo = '';
    this.lastLatencyMs = 0;
    this.connectedAt = '';
    this.mirrorWorkspaceRoot = '';
    return this.getStatus();
  }
}

