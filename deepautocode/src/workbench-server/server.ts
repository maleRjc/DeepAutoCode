import { exec, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { WebSocket, WebSocketServer } from 'ws';
import { AgentClientBridge, EncryptedFileSecretStorage } from '@deepautocode/agent';
import { buildWebviewCspHeader, generateCspNonce } from '../csp.js';
import { ExtensionsMarketplaceManager } from '../extensions-manager.js';
import { SshRemoteManager } from '../ssh-remote.js';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Support both tsx source execution (<repo>/src/workbench-server) and compiled dist (<repo>/dist/src/workbench-server)
const isCompiledDist = __dirname.replace(/\\/g, '/').includes('/dist/');
const REPO_ROOT = isCompiledDist
  ? path.resolve(__dirname, '../../..')
  : path.resolve(__dirname, '../..');
const MONOREPO_ROOT = path.resolve(REPO_ROOT, '..');

// Global crash guards so unhandled async/stream errors never terminate the IDE Workbench Server
process.on('uncaughtException', (err) => {
  console.error('[DeepAutoCode Workbench] Uncaught Exception (guarded):', err?.message || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[DeepAutoCode Workbench] Unhandled Rejection (guarded):', reason);
});

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileTreeNode[];
}

export interface IdeSettingsModel {
  editor: {
    fontSize: number;
    tabSize: number;
    wordWrap: boolean;
    lineNumbers: boolean;
    minimap: boolean;
    autoSave: 'off' | 'afterDelay' | 'onFocusChange';
    theme: 'cursor-dark' | 'antigravity-midnight' | 'high-contrast';
  };
  agent: {
    defaultExecutionMode: 'plan' | 'auto' | 'manual';
    autoApproveReadFiles: boolean;
    autoApproveSafeCommands: boolean;
    approvalTimeoutSeconds: number;
    includeActiveFileContext: boolean;
    commandAllowlist: string[];
    projectRules: string;
  };
  mcpServers: Array<{
    id: string;
    name: string;
    transport: 'stdio' | 'sse';
    commandOrUrl: string;
    enabled: boolean;
  }>;
  recentWorkspaces: string[];
  activeWorkspace?: string;
}

const DEFAULT_IDE_SETTINGS: IdeSettingsModel = {
  editor: {
    fontSize: 13,
    tabSize: 2,
    wordWrap: true,
    lineNumbers: true,
    minimap: true,
    autoSave: 'afterDelay',
    theme: 'cursor-dark',
  },
  agent: {
    defaultExecutionMode: 'auto',
    autoApproveReadFiles: true,
    autoApproveSafeCommands: true,
    approvalTimeoutSeconds: 120,
    includeActiveFileContext: true,
    commandAllowlist: [
      'git status',
      'git diff',
      'git log',
      'node -v',
      'npm test',
      'npm run typecheck',
      'npm run build',
    ],
    projectRules:
      '1. Follow TypeScript strict mode and ESM import conventions.\n2. Keep Cline SDK internal types isolated inside deepautocode-agent.\n3. Enforce workspace path canonicalization and never store plaintext API keys.',
  },
  mcpServers: [
    {
      id: 'mcp-filesystem-guard',
      name: 'Workspace Filesystem Guard (Built-in)',
      transport: 'stdio',
      commandOrUrl: 'builtin://capability-registry/workspace-fs',
      enabled: true,
    },
    {
      id: 'mcp-git-inspector',
      name: 'Git Repository Inspector',
      transport: 'stdio',
      commandOrUrl: 'npx -y @modelcontextprotocol/server-git',
      enabled: true,
    },
  ],
  recentWorkspaces: [],
  activeWorkspace: '',
};

async function buildWorkspaceTree(
  rootDir: string,
  relDir = '',
  depth = 0
): Promise<FileTreeNode[]> {
  if (depth > 4) return [];
  const absDir = relDir ? path.join(rootDir, relDir) : rootDir;
  const entries = await fs.readdir(absDir, { withFileTypes: true }).catch(() => []);
  const ignored = new Set([
    'node_modules',
    '.git',
    '.deepautocode-data',
    '.DS_Store',
  ]);

  const nodes: FileTreeNode[] = [];
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue;
    const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      const children = await buildWorkspaceTree(rootDir, relPath, depth + 1);
      nodes.push({
        name: entry.name,
        path: relPath,
        type: 'directory',
        children,
      });
    } else {
      nodes.push({
        name: entry.name,
        path: relPath,
        type: 'file',
      });
    }
  }

  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return nodes;
}

function flattenFiles(nodes: FileTreeNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.type === 'file') {
      out.push(n.path);
    } else if (n.children) {
      flattenFiles(n.children, out);
    }
  }
  return out;
}

export async function createWorkbenchServer(options?: {
  port?: number;
  storageDir?: string;
  workspaceRoot?: string;
}) {
  const dataRoot = options?.storageDir
    ? path.resolve(options.storageDir, '..')
    : path.join(REPO_ROOT, '.deepautocode-data');
  const storageDir = options?.storageDir ?? path.join(dataRoot, 'agent-runtime');
  const emptyWorkspaceDir = path.join(dataRoot, 'empty-workspace');
  await fs.mkdir(emptyWorkspaceDir, { recursive: true });
  const settingsFilePath = path.join(dataRoot, 'ide-settings.json');
  const secretsVaultPath = path.join(dataRoot, 'secrets.enc.json');
  const persistentSecrets = new EncryptedFileSecretStorage(secretsVaultPath);

  let activeWorkspaceRoot = options?.workspaceRoot ? path.resolve(options.workspaceRoot) : '';
  let restoreSshOnBoot = false;
  if (!options?.workspaceRoot) {
    try {
      const rawSettings = await fs.readFile(settingsFilePath, 'utf-8');
      const parsedSettings = JSON.parse(rawSettings);
      const savedActive = parsedSettings?.activeWorkspace;
      if (savedActive === '__ssh__') {
        restoreSshOnBoot = true;
      } else if (typeof savedActive === 'string' && savedActive.trim().length > 0) {
        const stat = await fs.stat(savedActive);
        if (stat.isDirectory()) {
          activeWorkspaceRoot = path.resolve(savedActive);
        }
      }
    } catch {
      // First launch: keep activeWorkspaceRoot = '' (Welcome / No Folder Opened state)
    }
  }

  let bridge = await AgentClientBridge.create({
    storageDir,
    workspaceRoot: activeWorkspaceRoot || emptyWorkspaceDir,
    initialBackendMode: 'local',
    secretStorage: persistentSecrets,
  });

  const extManager = new ExtensionsMarketplaceManager(REPO_ROOT, dataRoot);
  const sshManager = new SshRemoteManager(dataRoot);
  let preSshLocalWorkspaceRoot = activeWorkspaceRoot;
  const wsSubscriptions = new Map<WebSocket, { clientId: string; detach: () => Promise<void> }>();
  let wsClientSeq = 0;

  function registerSshCapabilityHooksIfActive() {
    const sshStatus = sshManager.getStatus();
    if (!sshStatus.connected) return;

    bridge.capabilityRegistry.registerExecutor('open-file', async (input: any, ctx) => {
      const canonicalPath = ctx.canonicalPath!;
      const relPath = path.relative(activeWorkspaceRoot, canonicalPath).replace(/\\/g, '/');
      await sshManager.pullRemoteFileToMirror(relPath).catch(() => undefined);
      await fs.access(canonicalPath);
      return {
        opened: true,
        canonicalPath,
        line: input.line ?? 1,
        column: input.column ?? 1,
      };
    });

    bridge.capabilityRegistry.registerExecutor('read-file', async (input: any, ctx) => {
      const canonicalPath = ctx.canonicalPath!;
      const relPath = path.relative(activeWorkspaceRoot, canonicalPath).replace(/\\/g, '/');
      await sshManager.pullRemoteFileToMirror(relPath).catch(() => undefined);

      const buffer = await fs.readFile(canonicalPath);
      const maxBytes = input.maxBytes ?? 512 * 1024;
      const truncated = buffer.byteLength > maxBytes;
      const slice = truncated ? buffer.subarray(0, maxBytes) : buffer;
      const content =
        input.encoding === 'base64' ? slice.toString('base64') : slice.toString('utf-8');
      return {
        canonicalPath,
        content,
        byteLength: buffer.byteLength,
        truncated,
      };
    });

    bridge.capabilityRegistry.registerExecutor('write-file', async (input: any, ctx) => {
      const canonicalPath = ctx.canonicalPath!;
      let existed = true;
      try {
        await fs.access(canonicalPath);
      } catch {
        existed = false;
      }
      if (input.createDirectories !== false) {
        await fs.mkdir(path.dirname(canonicalPath), { recursive: true });
      }
      const buf = Buffer.from(input.content, 'utf-8');
      await fs.writeFile(canonicalPath, buf);

      const relPath = path.relative(activeWorkspaceRoot, canonicalPath).replace(/\\/g, '/');
      await sshManager.pushMirrorFileToRemote(relPath, input.content);

      return {
        canonicalPath,
        bytesWritten: buf.byteLength,
        operation: existed ? 'modify' : 'create',
      };
    });

    bridge.capabilityRegistry.registerExecutor('run-build', async (input: any) => {
      const commandStr = String(input.command || '');
      const res = await sshManager.execRemoteCommand(commandStr);
      // If the remote command generated or touched any .pdf files, pull them into the local mirror automatically
      if (/\.pdf\b|build_pdf/i.test(`${commandStr}\n${res.stdout || ''}`)) {
        try {
          const findPdf = await sshManager.execRemoteCommand(
            `find . -maxdepth 3 -name "*.pdf" -type f 2>/dev/null | sed 's|^\\./||' | head -n 10`
          );
          const pdfRelPaths = (findPdf.stdout || '')
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l.endsWith('.pdf'));
          for (const pdfRel of pdfRelPaths) {
            await sshManager.pullRemoteBinaryFileToMirror(pdfRel, true).catch(() => undefined);
          }
        } catch {
          // ignore pdf auto-pull errors
        }
      }
      return res;
    });
  }

  // Auto-restore the most recently connected SSH Remote workspace only if SSH was the active workspace on exit
  if ((options?.port ?? 3840) !== 0 && restoreSshOnBoot) {
    try {
      const savedProfiles = await sshManager.listProfiles();
      const lastActiveProfile = [...savedProfiles]
        .filter((p) => Boolean(p.lastConnectedAt))
        .sort((a, b) => String(b.lastConnectedAt || '').localeCompare(String(a.lastConnectedAt || '')))[0];
      if (lastActiveProfile) {
        const conn = await sshManager.connect(lastActiveProfile);
        activeWorkspaceRoot = conn.workspaceRoot;
        await bridge.dispose();
        bridge = await AgentClientBridge.create({
          storageDir,
          workspaceRoot: activeWorkspaceRoot,
          initialBackendMode: 'local',
          secretStorage: persistentSecrets,
        });
        registerSshCapabilityHooksIfActive();
      }
    } catch (err) {
      console.warn('[DeepAutoCode SSH Auto-Restore] Skipped:', (err as Error)?.message || err);
    }
  }

  function attachWsToCurrentBridge(ws: WebSocket, existingClientId?: string) {
    const clientId = existingClientId ?? `workbench-ui-${++wsClientSeq}`;
    const detach = bridge.attachWebview(clientId, (event) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(event));
      }
    });
    wsSubscriptions.set(ws, { clientId, detach });
  }

  async function loadIdeSettings(): Promise<IdeSettingsModel> {
    try {
      const raw = await fs.readFile(settingsFilePath, 'utf-8');
      const parsed = JSON.parse(raw);
      return {
        editor: { ...DEFAULT_IDE_SETTINGS.editor, ...(parsed.editor ?? {}) },
        agent: { ...DEFAULT_IDE_SETTINGS.agent, ...(parsed.agent ?? {}) },
        mcpServers: Array.isArray(parsed.mcpServers)
          ? parsed.mcpServers
          : DEFAULT_IDE_SETTINGS.mcpServers,
        recentWorkspaces: Array.isArray(parsed.recentWorkspaces)
          ? parsed.recentWorkspaces
          : DEFAULT_IDE_SETTINGS.recentWorkspaces,
        activeWorkspace:
          typeof parsed.activeWorkspace === 'string'
            ? parsed.activeWorkspace
            : DEFAULT_IDE_SETTINGS.activeWorkspace,
      };
    } catch {
      return structuredClone(DEFAULT_IDE_SETTINGS);
    }
  }

  async function saveIdeSettings(next: Partial<IdeSettingsModel>): Promise<IdeSettingsModel> {
    const current = await loadIdeSettings();
    const merged: IdeSettingsModel = {
      editor: { ...current.editor, ...(next.editor ?? {}) },
      agent: { ...current.agent, ...(next.agent ?? {}) },
      mcpServers: next.mcpServers ?? current.mcpServers,
      recentWorkspaces: next.recentWorkspaces ?? current.recentWorkspaces,
      activeWorkspace: next.activeWorkspace ?? current.activeWorkspace ?? '',
    };
    await fs.mkdir(path.dirname(settingsFilePath), { recursive: true });
    await fs.writeFile(settingsFilePath, JSON.stringify(merged, null, 2), 'utf-8');
    return merged;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (req.method === 'POST' && url.pathname === '/api/bridge') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        const response = await bridge.handleWebviewMessage(body);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(response));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            category: 'response',
            type: 'unknown',
            requestId: 'parse_err',
            ok: false,
            error: { code: 'INVALID_JSON', message: (err as Error).message },
          })
        );
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/simulate-restart') {
      const restartRes = await bridge.restartRuntimeInstance();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(restartRes));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/settings') {
      const settings = await loadIdeSettings();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          workspaceRoot: activeWorkspaceRoot,
          settings,
          capabilities: bridge.capabilityRegistry.getDefinitions().map((d) => ({
            name: d.name,
            description: d.description,
            codeOssApi: d.codeOssApi,
            requiresApprovalByDefault: d.requiresApprovalByDefault,
            allowedInPlanMode: d.allowedInPlanMode,
            defaultTimeoutMs: d.defaultTimeoutMs,
          })),
        })
      );
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/settings') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const patch = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
      const saved = await saveIdeSettings(patch);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, settings: saved }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/workspace/switch') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const { folderPath } = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
      const resolved = path.resolve(String(folderPath ?? activeWorkspaceRoot));
      try {
        const stat = await fs.stat(resolved);
        if (!stat.isDirectory()) {
          throw new Error(`Not a directory: ${resolved}`);
        }
        activeWorkspaceRoot = resolved;
        await bridge.dispose();
        bridge = await AgentClientBridge.create({
          storageDir,
          workspaceRoot: activeWorkspaceRoot,
          initialBackendMode: 'local',
          secretStorage: persistentSecrets,
        });

        // Rebind all active WebSocket UI clients to the newly created bridge
        for (const [ws, sub] of wsSubscriptions.entries()) {
          if (ws.readyState === WebSocket.OPEN) {
            attachWsToCurrentBridge(ws, sub.clientId);
          } else {
            wsSubscriptions.delete(ws);
          }
        }

        const currentSettings = await loadIdeSettings();
        const recent = [
          activeWorkspaceRoot,
          ...currentSettings.recentWorkspaces.filter((w) => w !== activeWorkspaceRoot),
        ].slice(0, 8);
        await saveIdeSettings({ recentWorkspaces: recent, activeWorkspace: activeWorkspaceRoot });

        const tree = await buildWorkspaceTree(activeWorkspaceRoot);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: true,
            workspaceRoot: activeWorkspaceRoot,
            tree,
            files: flattenFiles(tree).slice(0, 300),
            recentWorkspaces: recent,
          })
        );
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/workspace/close') {
      if (sshManager.getStatus().connected) {
        sshManager.disconnect();
      }
      activeWorkspaceRoot = '';
      preSshLocalWorkspaceRoot = '';
      await saveIdeSettings({ activeWorkspace: '' });

      await bridge.dispose();
      bridge = await AgentClientBridge.create({
        storageDir,
        workspaceRoot: emptyWorkspaceDir,
        initialBackendMode: 'local',
        secretStorage: persistentSecrets,
      });

      for (const [ws, sub] of wsSubscriptions.entries()) {
        if (ws.readyState === WebSocket.OPEN) {
          attachWsToCurrentBridge(ws, sub.clientId);
        } else {
          wsSubscriptions.delete(ws);
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          ok: true,
          workspaceRoot: '',
          workspaceName: 'No Folder Opened',
          tree: [],
          files: [],
        })
      );
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/workspace/create') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const { targetPath, kind, content } = JSON.parse(
        Buffer.concat(chunks).toString('utf-8') || '{}'
      );
      try {
        if (kind === 'directory') {
          const abs = path.resolve(activeWorkspaceRoot, String(targetPath));
          if (!abs.startsWith(path.resolve(activeWorkspaceRoot))) {
            throw new Error('PATH_BOUNDARY_VIOLATION: Cannot create folder outside workspace');
          }
          await fs.mkdir(abs, { recursive: true });
        } else {
          await bridge.capabilityRegistry.invoke(
            'write-file',
            {
              filePath: String(targetPath),
              content: String(content ?? ''),
              createDirectories: true,
            },
            {
              sessionId: 'ide_user_create',
              workspaceRoot: activeWorkspaceRoot,
              executionMode: 'auto',
            }
          );
        }
        const tree = await buildWorkspaceTree(activeWorkspaceRoot);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, tree, files: flattenFiles(tree) }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/workspace/delete') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const { targetPath } = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
      try {
        const abs = path.resolve(activeWorkspaceRoot, String(targetPath));
        if (!abs.startsWith(path.resolve(activeWorkspaceRoot)) || abs === activeWorkspaceRoot) {
          throw new Error('PATH_BOUNDARY_VIOLATION: Invalid delete target');
        }
        await fs.rm(abs, { recursive: true, force: true });
        const tree = await buildWorkspaceTree(activeWorkspaceRoot);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, tree, files: flattenFiles(tree) }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/workspace/raw') {
      const relParam = String(url.searchParams.get('path') || '').replace(/^\/+/, '');
      const download = url.searchParams.get('download') === '1';
      try {
        const abs = path.resolve(activeWorkspaceRoot, relParam);
        if (!abs.startsWith(path.resolve(activeWorkspaceRoot))) {
          throw new Error('PATH_BOUNDARY_VIOLATION: File outside workspace');
        }
        const sshStatus = sshManager.getStatus();
        if (sshStatus.connected) {
          let needsPull = false;
          try {
            const st = await fs.stat(abs);
            if (st.size === 0) needsPull = true;
          } catch {
            needsPull = true;
          }
          if (needsPull) {
            await sshManager.pullRemoteBinaryFileToMirror(relParam, true).catch(() => undefined);
          }
        }
        const buf = await fs.readFile(abs);
        const ext = path.extname(abs).toLowerCase();
        const mime =
          ext === '.pdf'
            ? 'application/pdf'
            : ext === '.png'
              ? 'image/png'
              : ext === '.ico'
                ? 'image/x-icon'
                : ext === '.jpg' || ext === '.jpeg'
                  ? 'image/jpeg'
                  : ext === '.gif'
                    ? 'image/gif'
                    : ext === '.webp'
                      ? 'image/webp'
                      : ext === '.svg'
                        ? 'image/svg+xml'
                        : ext === '.bmp'
                          ? 'image/bmp'
                          : ext === '.avif'
                            ? 'image/avif'
                            : ext === '.html' || ext === '.htm'
                              ? 'text/html; charset=utf-8'
                              : 'application/octet-stream';
        const fileName = path.basename(abs);
        res.writeHead(200, {
          'Content-Type': mime,
          'Content-Length': String(buf.byteLength),
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          ...(download
            ? {
                'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
              }
            : {
                'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`,
              }),
        });
        res.end(buf);
      } catch (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`File not found: ${(err as Error).message}`);
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/workspace/open-external') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const { targetPath } = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
      try {
        const relParam = String(targetPath || '').replace(/^\/+/, '');
        const abs = path.resolve(activeWorkspaceRoot, relParam);
        if (!abs.startsWith(path.resolve(activeWorkspaceRoot))) {
          throw new Error('PATH_BOUNDARY_VIOLATION: File outside workspace');
        }
        const sshStatus = sshManager.getStatus();
        if (sshStatus.connected) {
          let needsPull = false;
          try {
            const st = await fs.stat(abs);
            if (st.size === 0) needsPull = true;
          } catch {
            needsPull = true;
          }
          if (needsPull) {
            await sshManager.pullRemoteBinaryFileToMirror(relParam, true).catch(() => undefined);
          }
        }
        await fs.access(abs);
        if (process.platform === 'win32') {
          spawn('cmd.exe', ['/c', 'start', '""', abs], { detached: true, stdio: 'ignore' }).unref();
        } else if (process.platform === 'darwin') {
          spawn('open', [abs], { detached: true, stdio: 'ignore' }).unref();
        } else {
          spawn('xdg-open', [abs], { detached: true, stdio: 'ignore' }).unref();
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, path: abs }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/workspace/files') {
      const sshStatus = sshManager.getStatus();
      if (!activeWorkspaceRoot && !sshStatus.connected) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            workspaceRoot: '',
            workspaceName: 'No Folder Opened',
            tree: [],
            files: [],
          })
        );
        return;
      }
      if (sshStatus.connected && sshStatus.activeProfile) {
        await sshManager.refreshActiveMirror();
      }
      const tree = await buildWorkspaceTree(activeWorkspaceRoot);
      const files = flattenFiles(tree);
      const sshProfile = sshStatus.connected ? sshStatus.activeProfile : undefined;
      const workspaceName = sshProfile
        ? `[SSH: ${sshProfile.username}@${sshProfile.host}] ${
            path.posix.basename(sshProfile.remotePath.replace(/\/+$/, '')) || 'root'
          }`
        : path.basename(activeWorkspaceRoot);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          workspaceRoot: activeWorkspaceRoot,
          workspaceName,
          tree,
          files: files.slice(0, 300),
        })
      );
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/workspace/search') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const { query } = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
      const q = String(query ?? '').trim().toLowerCase();
      const matches: Array<{ file: string; line: number; preview: string }> = [];

      if (q.length > 0 && activeWorkspaceRoot) {
        const tree = await buildWorkspaceTree(activeWorkspaceRoot);
        const files = flattenFiles(tree).slice(0, 150);
        for (const relFile of files) {
          if (matches.length >= 60) break;
          try {
            const abs = path.join(activeWorkspaceRoot, relFile);
            const stat = await fs.stat(abs);
            if (stat.size > 256 * 1024) continue;
            const content = await fs.readFile(abs, 'utf-8');
            const lines = content.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].toLowerCase().includes(q)) {
                matches.push({
                  file: relFile,
                  line: i + 1,
                  preview: lines[i].trim().slice(0, 120),
                });
                if (matches.length >= 60) break;
              }
            }
          } catch {
            // ignore binary or unreadable files
          }
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ matches }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/git/status') {
      try {
        const sshStatus = sshManager.getStatus();
        if (!activeWorkspaceRoot && !sshStatus.connected) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ branch: 'main', changes: [] }));
          return;
        }
        let branchOut = 'main';
        let statusOut = '';
        if (sshStatus.connected) {
          const [bRes, sRes] = await Promise.all([
            sshManager.execRemoteCommand('git branch --show-current'),
            sshManager.execRemoteCommand('git status --porcelain'),
          ]);
          branchOut = bRes.stdout.trim() || 'main';
          statusOut = sRes.stdout;
        } else {
          const [branchRes, statusRes] = await Promise.all([
            execAsync('git branch --show-current', { cwd: activeWorkspaceRoot }).catch(() => ({
              stdout: 'main',
            })),
            execAsync('git status --porcelain', { cwd: activeWorkspaceRoot }).catch(() => ({
              stdout: '',
            })),
          ]);
          branchOut = branchRes.stdout.trim() || 'main';
          statusOut = statusRes.stdout;
        }
        const changes = statusOut
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => ({
            status: line.slice(0, 2).trim() || 'M',
            file: line.slice(3).trim(),
          }));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            branch: branchOut,
            changes,
          })
        );
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ branch: 'main', changes: [], error: (err as Error).message }));
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/terminal/exec') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const { command } = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
      const cmd = String(command ?? '').trim();
      const start = Date.now();
      const sshStatus = sshManager.getStatus();

      if (sshStatus.connected && sshStatus.activeProfile) {
        const remoteRes = await sshManager.execRemoteCommand(cmd);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: remoteRes.exitCode === 0,
            exitCode: remoteRes.exitCode,
            stdout: remoteRes.stdout,
            stderr: remoteRes.stderr,
            cwd: `${sshStatus.activeProfile.username}@${sshStatus.activeProfile.host}:${sshStatus.activeProfile.remotePath}`,
            durationMs: remoteRes.durationMs,
          })
        );
        return;
      }

      const killsIdeProcessPattern =
        /\btaskkill\b[^|;&]*\/im\s+["']?(node|electron|tsx)(\.exe)?\b|\bStop-Process\b[^|;&]*-Name\s+["']?(node|electron|tsx)\b|\bGet-Process\b[^|;&]*\b(node|electron|tsx)\b[^|;&]*Stop-Process\b|\b(killall|pkill)\b[^|;&]*\b(node|electron|tsx)\b|\bwmic\b[^|;&]*\b(node|electron)\.exe\b/i;

      if (killsIdeProcessPattern.test(cmd)) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: true,
            exitCode: 0,
            stdout:
              `[DeepAutoCode Safety Guard] 已安全拦截全局终止 node/electron 进程的操作（当前 IDE 后端运行在 Node.js 进程 PID ${process.pid} / 端口 3840）。\n` +
              `如需释放特定业务端口（如 3000），请仅按端口查询对应 PID，或使用其它 PORT 环境变量启动服务。`,
            stderr: '',
            cwd: activeWorkspaceRoot,
            durationMs: Date.now() - start,
          })
        );
        return;
      }

      const isLongRunningServerCmd =
        /\b(npm(\.cmd)?\s+(start|run\s+(dev|start|serve))|node(\.exe)?\s+[^\s|;&]*server[^\s|;&]*\.js|python\d?\s+[^\s|;&]*-m\s+http\.server)\b/i.test(
          cmd
        );
      const serverReadyPattern =
        /(?:listening on|服务已启动|已启动|started server|http:\/\/localhost:\d+|http:\/\/127\.0\.0\.1:\d+|Local:\s+https?:\/\/|ready in \d+\s*ms)/i;

      const execResult = await new Promise<{
        ok: boolean;
        exitCode: number;
        stdout: string;
        stderr: string;
      }>((resolve) => {
        let settled = false;
        let stdout = '';
        let stderr = '';
        let serverReadyTimer: ReturnType<typeof setTimeout> | undefined;
        let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

        const child = spawn(cmd, {
          cwd: activeWorkspaceRoot,
          shell: true,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        const finish = (out: { ok: boolean; exitCode: number; stdout: string; stderr: string }) => {
          if (settled) return;
          settled = true;
          if (serverReadyTimer) clearTimeout(serverReadyTimer);
          if (fallbackTimer) clearTimeout(fallbackTimer);
          clearTimeout(hardTimeout);
          resolve(out);
        };

        const detachAsRunningServer = (note: string) => {
          if (settled) return;
          try {
            child.stdout?.destroy();
            child.stderr?.destroy();
            child.unref();
          } catch {
            // ignore
          }
          finish({
            ok: true,
            exitCode: 0,
            stdout: `${stdout.trimEnd()}\n${note}`.trim(),
            stderr,
          });
        };

        const checkReady = () => {
          if (settled || serverReadyTimer) return;
          if (serverReadyPattern.test(`${stdout}\n${stderr}`)) {
            serverReadyTimer = setTimeout(() => {
              if (!settled && child.exitCode === null) {
                detachAsRunningServer(
                  `[DeepAutoCode] 常驻服务已启动并在后台持续运行 (PID: ${child.pid ?? 'unknown'})。`
                );
              }
            }, 1000);
          }
        };

        if (isLongRunningServerCmd) {
          fallbackTimer = setTimeout(() => {
            if (!settled && child.exitCode === null) {
              detachAsRunningServer(
                `[DeepAutoCode] 服务进程已在后台持续运行 (PID: ${child.pid ?? 'unknown'})。`
              );
            }
          }, 5000);
        }

        const hardTimeout = setTimeout(() => {
          if (settled) return;
          try {
            child.kill();
          } catch {
            // ignore
          }
          finish({
            ok: false,
            exitCode: 1,
            stdout,
            stderr: `${stderr}\nCommand timed out after 30000ms`.trim(),
          });
        }, 30000);

        child.stdout?.on('data', (chunk: Buffer) => {
          if (stdout.length < 512 * 1024) stdout += chunk.toString('utf-8');
          checkReady();
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          if (stderr.length < 512 * 1024) stderr += chunk.toString('utf-8');
          checkReady();
        });
        child.on('error', (err) => {
          finish({
            ok: false,
            exitCode: 1,
            stdout,
            stderr: `${stderr}\n${err.message}`.trim(),
          });
        });
        child.on('close', (code) => {
          const combined = `${stdout}\n${stderr}`;
          if (/EADDRINUSE|已被占用|address already in use/i.test(combined)) {
            finish({
              ok: true,
              exitCode: 0,
              stdout: `${combined}\n[DeepAutoCode] 检测到目标端口已被占用，说明该服务实例已在后台运行中。`.trim(),
              stderr: '',
            });
            return;
          }
          const exitCode = typeof code === 'number' ? code : 0;
          finish({
            ok: exitCode === 0,
            exitCode,
            stdout,
            stderr,
          });
        });
      });

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          ...execResult,
          cwd: activeWorkspaceRoot,
          durationMs: Date.now() - start,
        })
      );
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/ssh/status') {
      const profiles = await sshManager.listProfiles();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: sshManager.getStatus(), profiles }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/ssh/profiles') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
      const profiles = await sshManager.saveProfile(body);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, profiles }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/ssh/profiles/delete') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const { profileId } = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
      const profiles = await sshManager.deleteProfile(String(profileId || ''));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, profiles }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/ssh/test') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
      const result = await sshManager.testConnection(body);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/ssh/browse') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const { profile, targetDir } = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
      try {
        const result = await sshManager.browseRemoteDirectories(profile || {}, targetDir || '~');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/ssh/connect') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const profileInput = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
      try {
        if (!sshManager.getStatus().connected) {
          preSshLocalWorkspaceRoot = activeWorkspaceRoot;
        }
        const conn = await sshManager.connect(profileInput);
        activeWorkspaceRoot = conn.workspaceRoot;
        await saveIdeSettings({ activeWorkspace: '__ssh__' });

        await bridge.dispose();
        bridge = await AgentClientBridge.create({
          storageDir,
          workspaceRoot: activeWorkspaceRoot,
          initialBackendMode: 'local',
          secretStorage: persistentSecrets,
        });
        registerSshCapabilityHooksIfActive();

        for (const [ws, sub] of wsSubscriptions.entries()) {
          if (ws.readyState === WebSocket.OPEN) {
            attachWsToCurrentBridge(ws, sub.clientId);
          } else {
            wsSubscriptions.delete(ws);
          }
        }

        const tree = await buildWorkspaceTree(activeWorkspaceRoot);
        const profiles = await sshManager.listProfiles();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: true,
            status: conn.status,
            profiles,
            workspaceRoot: activeWorkspaceRoot,
            workspaceName: conn.workspaceDisplayLabel,
            tree,
            files: flattenFiles(tree).slice(0, 300),
          })
        );
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/ssh/disconnect') {
      const status = sshManager.disconnect();
      activeWorkspaceRoot = preSshLocalWorkspaceRoot || '';
      await saveIdeSettings({ activeWorkspace: activeWorkspaceRoot });

      await bridge.dispose();
      bridge = await AgentClientBridge.create({
        storageDir,
        workspaceRoot: activeWorkspaceRoot || emptyWorkspaceDir,
        initialBackendMode: 'local',
        secretStorage: persistentSecrets,
      });

      for (const [ws, sub] of wsSubscriptions.entries()) {
        if (ws.readyState === WebSocket.OPEN) {
          attachWsToCurrentBridge(ws, sub.clientId);
        } else {
          wsSubscriptions.delete(ws);
        }
      }

      const tree = activeWorkspaceRoot ? await buildWorkspaceTree(activeWorkspaceRoot) : [];
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          ok: true,
          status,
          workspaceRoot: activeWorkspaceRoot,
          workspaceName: activeWorkspaceRoot
            ? path.basename(activeWorkspaceRoot)
            : 'No Folder Opened',
          tree,
          files: flattenFiles(tree).slice(0, 300),
        })
      );
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/extensions') {
      const matrix = await extManager.loadMatrix();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(matrix));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/extensions/install-openvsx') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      try {
        const { extensionId } = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        const result = await extManager.installFromOpenVsx(extensionId);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/extensions/install-vsix') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      try {
        const { vsixFileName, userConfirmedLicense } = JSON.parse(
          Buffer.concat(chunks).toString('utf-8')
        );
        const result = await extManager.installLocalVsix(
          vsixFileName,
          Boolean(userConfirmedLicense)
        );
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      }
      return;
    }

    // Antigravity Artifacts API: list & create structured Markdown Artifacts (Plans, Task Checklists, Walkthroughs)
    if (req.method === 'GET' && url.pathname === '/api/workspace/artifacts') {
      const artifactsDir = path.join(dataRoot, 'artifacts');
      await fs.mkdir(artifactsDir, { recursive: true });
      const entries = await fs.readdir(artifactsDir).catch(() => []);
      const items: any[] = [];
      for (const file of entries) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw = await fs.readFile(path.join(artifactsDir, file), 'utf-8');
          items.push(JSON.parse(raw));
        } catch {
          // ignore
        }
      }
      items.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, artifacts: items }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/workspace/artifacts') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
        const artifactsDir = path.join(dataRoot, 'artifacts');
        await fs.mkdir(artifactsDir, { recursive: true });
        const id = body.id || `art_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const record = {
          id,
          sessionId: body.sessionId || '',
          artifactType: body.artifactType || 'plan',
          title: String(body.title || 'Implementation Plan').trim(),
          content: String(body.content || '').trim(),
          workspaceRoot: activeWorkspaceRoot,
          createdAt: body.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await fs.writeFile(
          path.join(artifactsDir, `${id}.json`),
          JSON.stringify(record, null, 2),
          'utf-8'
        );
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, artifact: record }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      }
      return;
    }

    // Antigravity .agents/ Workspace Customizations API (Rules, Skills, Workflows)
    if (req.method === 'GET' && url.pathname === '/api/workspace/customizations') {
      if (!activeWorkspaceRoot) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, rules: [], skills: [], workflows: [] }));
        return;
      }
      const rules: Array<{ name: string; path: string; content: string }> = [];
      const skills: Array<{ name: string; description: string; path: string }> = [];
      const workflows: Array<{ name: string; description: string; path: string }> = [];

      for (const rootRule of ['AGENTS.md', 'CLAUDE.md', '.cursorrules']) {
        try {
          const raw = await fs.readFile(path.join(activeWorkspaceRoot, rootRule), 'utf-8');
          if (raw.trim()) {
            rules.push({ name: rootRule, path: rootRule, content: raw.slice(0, 6000) });
          }
        } catch {
          // ignore
        }
      }
      try {
        const rulesDir = path.join(activeWorkspaceRoot, '.agents', 'rules');
        const entries = await fs.readdir(rulesDir, { withFileTypes: true });
        for (const e of entries) {
          if (e.isFile() && /\.(?:md|txt)$/i.test(e.name)) {
            const raw = await fs.readFile(path.join(rulesDir, e.name), 'utf-8');
            rules.push({
              name: e.name.replace(/\.(?:md|txt)$/i, ''),
              path: `.agents/rules/${e.name}`,
              content: raw.slice(0, 6000),
            });
          }
        }
      } catch {
        // ignore
      }
      try {
        const skillsDir = path.join(activeWorkspaceRoot, '.agents', 'skills');
        const entries = await fs.readdir(skillsDir, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory()) {
            const rel = `.agents/skills/${e.name}/SKILL.md`;
            const raw = await fs
              .readFile(path.join(skillsDir, e.name, 'SKILL.md'), 'utf-8')
              .catch(() => '');
            if (raw) {
              const descMatch = raw.match(/description:\s*([^\r\n]+)/i);
              skills.push({
                name: e.name,
                description: descMatch?.[1]?.trim() || `Workspace skill (${e.name})`,
                path: rel,
              });
            }
          }
        }
      } catch {
        // ignore
      }
      try {
        const wfDir = path.join(activeWorkspaceRoot, '.agents', 'workflows');
        const entries = await fs.readdir(wfDir, { withFileTypes: true });
        for (const e of entries) {
          if (e.isFile() && /\.md$/i.test(e.name)) {
            const raw = await fs.readFile(path.join(wfDir, e.name), 'utf-8');
            const descMatch = raw.match(/description:\s*([^\r\n]+)/i);
            workflows.push({
              name: `/${e.name.replace(/\.md$/i, '')}`,
              description: descMatch?.[1]?.trim() || `Custom workflow (${e.name})`,
              path: `.agents/workflows/${e.name}`,
            });
          }
        }
      } catch {
        // ignore
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, rules, skills, workflows }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/workspace/customizations') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      try {
        if (!activeWorkspaceRoot) {
          throw new Error('Open a project workspace folder first.');
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
        const kind = String(body.kind || 'rule');
        const rawName = String(body.name || 'project-conventions')
          .trim()
          .replace(/[^a-zA-Z0-9_-]/g, '-');
        const content = String(body.content || '').trim();
        let relPath = `.agents/rules/${rawName}.md`;
        if (kind === 'skill') {
          relPath = `.agents/skills/${rawName}/SKILL.md`;
        } else if (kind === 'workflow') {
          relPath = `.agents/workflows/${rawName}.md`;
        }
        const fullPath = path.join(activeWorkspaceRoot, relPath);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, content, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, path: relPath }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      }
      return;
    }

    // Antigravity Ghost Text / Inline Code Autocomplete API
    if (req.method === 'POST' && url.pathname === '/api/ai/autocomplete') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
        const prefix = String(body.prefix || '');
        const suffix = String(body.suffix || '');
        const filePath = String(body.filePath || '').toLowerCase();

        let completion = '';
        const lines = prefix.split(/\r?\n/);
        const lastLine = lines[lines.length - 1] || '';
        const trimmed = lastLine.trim();

        if (trimmed.endsWith('{') && !suffix.trim().startsWith('}')) {
          completion = '\n  \n}';
        } else if (trimmed.startsWith('import ') && !trimmed.includes('from') && trimmed.includes('{')) {
          completion = filePath.endsWith('.tsx') || filePath.endsWith('.ts') ? " from './components';" : " from './utils';";
        } else if (/^const\s+\[[a-zA-Z0-9_]+,\s*set[a-zA-Z0-9_]*\]\s*=\s*$/.test(trimmed)) {
          completion = 'useState(false);';
        } else if (/^interface\s+[a-zA-Z0-9_]+\s*$/.test(trimmed)) {
          completion = '{\n  id: string;\n  name: string;\n}';
        } else if (/^export\s+function\s+[a-zA-Z0-9_]+\s*\([^)]*\)\s*$/.test(trimmed)) {
          completion = '{\n  return null;\n}';
        } else if (/^if\s*\([^)]+\)\s*$/.test(trimmed)) {
          completion = '{\n  \n}';
        } else if (trimmed.endsWith('console.log(')) {
          completion = "'Debug:', );";
        } else if (trimmed.endsWith(': React.')) {
          completion = 'ReactNode';
        }

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, completion }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      }
      return;
    }

    // Antigravity Autonomous Browser Inspection API
    if (req.method === 'POST' && url.pathname === '/api/browser/action') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
        const targetUrl = String(body.url || 'http://localhost:3000/').trim();
        const action = String(body.action || 'navigate');
        const selector = body.selector ? String(body.selector).trim() : undefined;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const resp = await fetch(targetUrl, { signal: controller.signal });
        clearTimeout(timeout);

        const html = await resp.text();
        const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
        const pageTitle = titleMatch ? titleMatch[1].trim() : 'Untitled Document';

        const headings = Array.from(html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi))
          .map((m) => m[1].replace(/<[^>]+>/g, '').trim())
          .filter(Boolean)
          .slice(0, 8);

        const buttons = Array.from(html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/gi))
          .map((m) => m[1].replace(/<[^>]+>/g, '').trim())
          .filter(Boolean)
          .slice(0, 10);

        const links = Array.from(html.matchAll(/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi))
          .map((m) => ({ href: m[1], label: m[2].replace(/<[^>]+>/g, '').trim() }))
          .filter((l) => Boolean(l.label))
          .slice(0, 10);

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: resp.ok,
            action,
            targetUrl,
            status: `${resp.status} ${resp.statusText}`,
            pageTitle,
            headings,
            buttons,
            links,
            htmlSnippet: action === 'get_html' ? html.slice(0, 4000) : html.slice(0, 1000),
          })
        );
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: false,
            error: `Browser navigation failed: ${(err as Error).message}`,
          })
        );
      }
      return;
    }

    // Serve built Webview static assets with CSP nonce injection
    const distWebview = path.join(REPO_ROOT, 'dist', 'webview');
    // Brand assets (logo.svg / logo-*.png / logo.ico) live in <repo>/assets and are
    // exposed under /assets/* so the favicon and in-app logo resolve in the workbench.
    const brandAssets = path.join(REPO_ROOT, 'assets');
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const nonce = generateCspNonce();
      const csp = buildWebviewCspHeader({
        cspSource: "'self'",
        nonce,
        allowLocalWebSocket: true,
      });

      let savedTheme = 'cursor-light';
      try {
        const rawSettings = await fs.readFile(settingsFilePath, 'utf-8');
        const parsedSettings = JSON.parse(rawSettings);
        if (typeof parsedSettings?.editor?.theme === 'string' && parsedSettings.editor.theme.trim()) {
          savedTheme = parsedSettings.editor.theme.trim();
        }
      } catch {
        // fallback to cursor-light
      }
      const isLightInit = savedTheme === 'cursor-light' || savedTheme === 'light';
      const initBg = isLightInit ? '#f8fafc' : '#0d1017';
      const initFg = isLightInit ? '#0f172a' : '#e2e8f0';

      let assetVersion = Date.now().toString(36);
      try {
        const jsStat = await fs.stat(path.join(distWebview, 'assets', 'index.js'));
        assetVersion = Math.floor(jsStat.mtimeMs).toString(36);
      } catch {
        // fallback to timestamp
      }

      const html = `<!DOCTYPE html>
<html lang="zh-CN" data-theme="${savedTheme}" style="background:${initBg};color:${initFg};">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>DeepAutoCode — AI Native IDE (v1.1)</title>
  <link rel="icon" type="image/svg+xml" href="/assets/logo.svg?v=${assetVersion}" />
  <link rel="alternate icon" type="image/png" sizes="32x32" href="/assets/logo-32.png?v=${assetVersion}" />
  <link rel="apple-touch-icon" sizes="180x180" href="/assets/logo-256.png?v=${assetVersion}" />
  <meta name="theme-color" content="#0A1122" />
  <link rel="stylesheet" href="/assets/index.css?v=${assetVersion}" />
</head>
<body style="background:${initBg};color:${initFg};margin:0;">
  <div id="root"></div>
  <script nonce="${nonce}">window.__DAC_INITIAL_THEME__ = ${JSON.stringify(savedTheme)};</script>
  <script nonce="${nonce}" type="module" src="/assets/index.js?v=${assetVersion}"></script>
</body>
</html>`;

      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': csp,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      });
      res.end(html);
      return;
    }

    const isBrandAsset =
      url.pathname.startsWith('/assets/logo') ||
      url.pathname === '/favicon.ico' ||
      /^\/logo(?:-\d+|-icon|-mark|-wordmark|-preview)?\.(?:svg|png|ico|jpg)$/i.test(url.pathname);
    const assetRoot = isBrandAsset ? brandAssets : distWebview;
    const brandFileName =
      url.pathname === '/favicon.ico'
        ? '/logo.ico'
        : url.pathname.replace(/^\/assets\//, '/');
    const resolvedAsset = isBrandAsset
      ? path.resolve(brandAssets, `.${brandFileName}`)
      : path.resolve(distWebview, `.${url.pathname}`);
    if (resolvedAsset.startsWith(assetRoot)) {
      try {
        const data = await fs.readFile(resolvedAsset);
        const ext = path.extname(resolvedAsset);
        const mime =
          ext === '.js'
            ? 'application/javascript; charset=utf-8'
            : ext === '.css'
              ? 'text/css; charset=utf-8'
              : ext === '.svg'
                ? 'image/svg+xml'
                : ext === '.png'
                  ? 'image/png'
                  : ext === '.ico'
                    ? 'image/x-icon'
                    : ext === '.jpg' || ext === '.jpeg'
                      ? 'image/jpeg'
                      : 'application/octet-stream';
        res.writeHead(200, {
          'Content-Type': mime,
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        });
        res.end(data);
        return;
      } catch {
        // fall through to 404
      }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('error', (err) => {
    console.error('[DeepAutoCode WS Server] Error (guarded):', err?.message || err);
  });
  wss.on('connection', (ws) => {
    attachWsToCurrentBridge(ws);
    ws.on('error', (err) => {
      console.error('[DeepAutoCode WS Client] Error (guarded):', err?.message || err);
    });
    ws.on('close', () => {
      const sub = wsSubscriptions.get(ws);
      wsSubscriptions.delete(ws);
      if (sub) {
        void sub.detach();
      }
    });
  });

  const requestedPort = options?.port ?? 3840;

  async function listenWithFallback(startPort: number): Promise<number> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidatePort = startPort === 0 ? 0 : startPort + attempt;
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (err: NodeJS.ErrnoException) => {
            server.removeListener('listening', onListening);
            reject(err);
          };
          const onListening = () => {
            server.removeListener('error', onError);
            resolve();
          };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(candidatePort, '127.0.0.1');
        });
        const addr = server.address();
        return typeof addr === 'object' && addr ? addr.port : candidatePort;
      } catch (err: any) {
        if (err?.code === 'EADDRINUSE' && startPort !== 0) {
          continue;
        }
        throw err;
      }
    }
    throw new Error(`Could not find an available port starting from ${startPort}`);
  }

  const actualPort = await listenWithFallback(requestedPort);

  return {
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}`,
    workspaceRoot: activeWorkspaceRoot,
    monorepoRoot: MONOREPO_ROOT,
    bridge,
    extManager,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => server.close(() => r()));
      await bridge.dispose();
    },
  };
}

// Run directly when executed via `npm run dev:workbench`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createWorkbenchServer({
    port: Number(process.env.PORT ?? 3840),
    workspaceRoot: MONOREPO_ROOT,
  }).then((srv) => {
    console.log(`========================================================`);
    console.log(` DeepAutoCode AI IDE Workbench running at: ${srv.url}`);
    console.log(`========================================================`);
  });
}
