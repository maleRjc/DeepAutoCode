import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export function isPrivateLanHost(host: string): boolean {
  return /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host);
}

export async function resolveRelayAlias(): Promise<string | null> {
  const fromEnv =
    process.env.DAC_SSH_RELAY_HOST?.trim() || process.env.DSH_KERNEL_SSH_RELAY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const raw = await fs.readFile(path.join(os.homedir(), '.ssh', 'config'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const match = line.trim().match(/^Host\s+([^\s*#]+)/i);
      if (match?.[1]) return match[1].trim();
    }
  } catch {
    // no ssh config
  }
  return null;
}

export interface RelayTunnel {
  localPort: number;
  close(): void;
}

async function findFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        socket.once('connect', () => {
          socket.end();
          resolve();
        });
        socket.once('error', reject);
      });
      return;
    } catch {
      if (Date.now() - started > timeoutMs) {
        throw new Error(`${Math.round(timeoutMs / 1000)}s 内没有建立本地转发端口`);
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

/** Open `ssh -N -L 127.0.0.1:<port>:<host>:<port>` through a relay Host. */
export async function openRelayTunnel(
  host: string,
  port: number,
  alias: string,
  debug = false
): Promise<RelayTunnel> {
  const localPort = await findFreePort();
  const child: ChildProcess = spawn(
    'ssh',
    [
      '-N',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'ConnectTimeout=8',
      '-L',
      `127.0.0.1:${localPort}:${host}:${port}`,
      alias,
    ],
    { stdio: 'ignore', windowsHide: true }
  );

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      child.kill();
    } catch {
      // ignore
    }
  };

  try {
    await waitForPort(localPort, 15000);
  } catch (err) {
    close();
    throw new Error(
      `SSH 中继 ${alias} 启动失败：${(err as Error).message}。请确认 \`ssh ${alias}\` 能免密登录，且该主机能访问 ${host}:${port}。`
    );
  }
  if (debug) {
    console.log(`[ssh-relay] ${host}:${port} -> 127.0.0.1:${localPort} via ${alias}`);
  }
  return { localPort, close };
}
