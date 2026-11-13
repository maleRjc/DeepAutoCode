import { exec, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { WebSocket, WebSocketServer } from 'ws';
import {
  AgentClientBridge,
  EncryptedFileSecretStorage,
  buildUtf8SubprocessEnv,
  createStreamingConsoleDecoder,
  extractCodeOutlineSymbols,
  isLocalOrPrivateEndpoint,
  loadMcpConfigsFromWorkspace,
  loadAgentMemory,
  appendAgentMemory,
  McpHost,
  parseBuildDiagnostics,
  rankDefinitionCandidates,
  completeDeepSeekFim,
  terminateChildProcessTree,
  DEEPSEEK_FLASH,
  type BuildDiagnostic,
} from '@deepautocode/agent';
import { buildWebviewCspHeader, generateCspNonce } from '../csp.js';
import { ExtensionsMarketplaceManager } from '../extensions-manager.js';
import { LspManager } from '../lsp/LspManager.js';
import { listProviderModels } from '../kernel/model-list.js';
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
    theme: 'cursor-light' | 'cursor-dark' | 'antigravity-midnight' | 'high-contrast';
  };
  /** UI chrome / User Guide locale */
  ui?: {
    locale?: 'zh-CN' | 'zh-TW' | 'en';
  };
  agent: {
    defaultExecutionMode: 'plan' | 'auto' | 'manual';
    autoApproveReadFiles: boolean;
    autoApproveSafeCommands: boolean;
    approvalTimeoutSeconds: number;
    includeActiveFileContext: boolean;
    commandAllowlist: string[];
    /** Global User Rules (always injected) */
    userRules: string;
    projectRules: string;
    /** Preferred build command for post-edit verification (overridable by .deepautocode/verify.json) */
    verifyBuildCommand: string;
    /** Preferred test command for post-edit verification */
    verifyTestCommand: string;
    /** Auto mode creates evolve/* sandbox branches before first mutation */
    enableEvolveSandbox: boolean;
  };
  mcpServers: Array<{
    id: string;
    name: string;
    transport: 'stdio' | 'sse' | 'http';
    commandOrUrl: string;
    enabled: boolean;
    env?: Record<string, string>;
    /** HTTP headers for SSE / Streamable HTTP (Authorization, API keys, …) */
    headers?: Record<string, string>;
    disabledTools?: string[];
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
    minimap: false,
    autoSave: 'afterDelay',
    theme: 'cursor-dark',
  },
  ui: {
    locale: 'zh-CN',
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
    userRules: '',
    projectRules:
      '1. Follow TypeScript strict mode and ESM import conventions.\n2. Keep Cline SDK internal types isolated inside deepautocode-agent.\n3. Enforce workspace path canonicalization and never store plaintext API keys.',
    verifyBuildCommand: 'npm run build',
    verifyTestCommand: 'npm test',
    enableEvolveSandbox: true,
  },
  mcpServers: [
    {
      id: 'mcp-filesystem-guard',
      name: 'Workspace Filesystem Guard (Built-in)',
      transport: 'stdio',
      commandOrUrl: 'builtin://capability-registry/workspace-fs',
      enabled: true,
      disabledTools: [],
    },
    {
      id: 'mcp-git-inspector',
      name: 'Git Repository Inspector',
      transport: 'stdio',
      commandOrUrl: 'npx -y @modelcontextprotocol/server-git',
      enabled: false,
      disabledTools: [],
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
  const sshManager = new SshRemoteManager(dataRoot, persistentSecrets);
  const lspManager = new LspManager();
  if (activeWorkspaceRoot) {
    void lspManager.setWorkspace(activeWorkspaceRoot).catch(() => undefined);
  }
  let workspaceProblems: BuildDiagnostic[] = [];

  async function persistProblems(problems: BuildDiagnostic[]): Promise<void> {
    workspaceProblems = problems.slice(0, 200);
    const payload = {
      updatedAt: new Date().toISOString(),
      problems: workspaceProblems,
    };
    await fs.mkdir(dataRoot, { recursive: true });
    await fs.writeFile(
      path.join(dataRoot, 'problems.json'),
      JSON.stringify(payload, null, 2),
      'utf-8'
    );
    if (activeWorkspaceRoot) {
      try {
        const wsDir = path.join(activeWorkspaceRoot, '.deepautocode');
        await fs.mkdir(wsDir, { recursive: true });
        await fs.writeFile(
          path.join(wsDir, 'problems.json'),
          JSON.stringify(payload, null, 2),
          'utf-8'
        );
      } catch {
        // ignore workspace write failures
      }
    }
  }

  async function mergeProblemsFromOutput(stdout: string, stderr: string): Promise<BuildDiagnostic[]> {
    const parsed = parseBuildDiagnostics(stdout || '', stderr || '', { maxItems: 80 });
    if (parsed.length === 0) return workspaceProblems;
    const merged = [...parsed, ...workspaceProblems];
    const seen = new Set<string>();
    const deduped: BuildDiagnostic[] = [];
    for (const d of merged) {
      const key = `${d.file}:${d.line}:${d.severity}:${d.message.slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(d);
      if (deduped.length >= 120) break;
    }
    await persistProblems(deduped);
    return workspaceProblems;
  }
  let preSshLocalWorkspaceRoot = activeWorkspaceRoot;
  const wsSubscriptions = new Map<WebSocket, { clientId: string; detach: () => Promise<void> }>();
  let wsClientSeq = 0;

  function registerSshCapabilityHooksIfActive() {
    const sshStatus = sshManager.getStatus();
    if (!sshStatus.connected) return;

    bridge.capabilityRegistry.registerExecutor('open-file', async (input: any, ctx) => {
      const canonicalPath = ctx.canonicalPath!;
      const relPath = path.relative(activeWorkspaceRoot, canonicalPath).replace(/\\/g, '/');
      await sshManager.pullRemoteFileToMirror(relPath, true).catch(() => undefined);
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
      try {
        await sshManager.pullRemoteFileToMirror(relPath, false, {
          allowOverwriteDirty: Boolean(input?.forceRemote),
        });
      } catch (err) {
        if ((err as any)?.code === 'SSH_LOCAL_DIRTY') {
          // Keep local dirty buffer; still read from mirror disk
        } else {
          await sshManager.pullRemoteFileToMirror(relPath, true, { allowOverwriteDirty: true }).catch(
            () => undefined
          );
        }
      }

      let buffer: Buffer;
      try {
        buffer = await fs.readFile(canonicalPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          const remoteRoot = sshManager.getStatus().activeProfile?.remotePath || '(remote workspace root)';
          // Never leak the local mirror path; tell the model how to reach files outside the SSH workspace root.
          throw new Error(
            `REMOTE_FILE_NOT_FOUND: "${relPath}" does not exist under the remote workspace root ${remoteRoot}. ` +
              `read_file only reads files inside that root. If the file lives elsewhere on the remote host ` +
              `(e.g. a scratch dir you created with run_command such as /home/<user>/...), read it with ` +
              `run_command, e.g. \`cat -n /abs/path/file | sed -n '1,200p'\`, or copy it into the workspace first.`
          );
        }
        throw err;
      }
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
      const localeRaw = parsed.ui?.locale ?? DEFAULT_IDE_SETTINGS.ui?.locale ?? 'zh-CN';
      const locale =
        localeRaw === 'en' || localeRaw === 'zh-TW' || localeRaw === 'zh-CN'
          ? localeRaw
          : 'zh-CN';
      return {
        editor: { ...DEFAULT_IDE_SETTINGS.editor, ...(parsed.editor ?? {}) },
        ui: {
          ...(DEFAULT_IDE_SETTINGS.ui ?? {}),
          ...(parsed.ui ?? {}),
          locale,
        },
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

  async function persistWorkspaceVerifyConfig(settings: IdeSettingsModel): Promise<void> {
    if (!activeWorkspaceRoot) return;
    try {
      const dir = path.join(activeWorkspaceRoot, '.deepautocode');
      await fs.mkdir(dir, { recursive: true });
      const buildCommand = settings.agent.verifyBuildCommand?.trim() || 'npm run build';
      const testCommand = settings.agent.verifyTestCommand?.trim() || 'npm test';
      await fs.writeFile(
        path.join(dir, 'verify.json'),
        JSON.stringify(
          {
            buildCommand,
            testCommand,
            combinedCommand: `${buildCommand} && ${testCommand}`,
            enableEvolveSandbox: settings.agent.enableEvolveSandbox !== false,
          },
          null,
          2
        ),
        'utf-8'
      );
      // P1: persist IDE project rules so Agent system prompt discovers them every turn
      const userRulesText = String(settings.agent.userRules || '').trim();
      if (userRulesText) {
        await fs.writeFile(
          path.join(dir, 'user-rules.md'),
          `# DeepAutoCode User Rules\n\n${userRulesText}\n`,
          'utf-8'
        );
      } else {
        await fs.rm(path.join(dir, 'user-rules.md'), { force: true }).catch(() => undefined);
      }
      const rulesText = String(settings.agent.projectRules || '').trim();
      if (rulesText) {
        await fs.writeFile(
          path.join(dir, 'project-rules.md'),
          `# DeepAutoCode Project Rules\n\n${rulesText}\n`,
          'utf-8'
        );
      }
      // Stage L/S/V: sync MCP configs (stdio|sse|http + env/headers + disabledTools)
      const mcpServers = Array.isArray(settings.mcpServers) ? settings.mcpServers : [];
      await fs.writeFile(
        path.join(dir, 'mcp.json'),
        JSON.stringify(
          {
            mcpServers: mcpServers.map((s) => {
              const t = String(s.transport || 'stdio').toLowerCase();
              const transport =
                t === 'sse' || t === 'http+sse'
                  ? 'sse'
                  : t === 'http' || t === 'streamable' || t === 'streamable-http'
                    ? 'http'
                    : 'stdio';
              return {
                id: s.id,
                name: s.name,
                transport,
                commandOrUrl: s.commandOrUrl,
                enabled: s.enabled !== false,
                env: s.env && typeof s.env === 'object' ? s.env : undefined,
                headers: s.headers && typeof s.headers === 'object' ? s.headers : undefined,
                disabledTools: Array.isArray(s.disabledTools) ? s.disabledTools : [],
              };
            }),
          },
          null,
          2
        ),
        'utf-8'
      );
    } catch {
      // non-fatal: Agent can still infer verify commands
    }
  }

  async function saveIdeSettings(next: Partial<IdeSettingsModel>): Promise<IdeSettingsModel> {
    const current = await loadIdeSettings();
    const merged: IdeSettingsModel = {
      editor: { ...current.editor, ...(next.editor ?? {}) },
      ui: {
        ...(current.ui ?? {}),
        ...(next.ui ?? {}),
        locale: (next.ui?.locale ?? current.ui?.locale ?? 'zh-CN') as 'zh-CN' | 'zh-TW' | 'en',
      },
      agent: { ...current.agent, ...(next.agent ?? {}) },
      mcpServers: next.mcpServers ?? current.mcpServers,
      recentWorkspaces: next.recentWorkspaces ?? current.recentWorkspaces,
      activeWorkspace: next.activeWorkspace ?? current.activeWorkspace ?? '',
    };
    await fs.mkdir(path.dirname(settingsFilePath), { recursive: true });
    await fs.writeFile(settingsFilePath, JSON.stringify(merged, null, 2), 'utf-8');
    if (next.agent || next.mcpServers) {
      await persistWorkspaceVerifyConfig(merged);
    }
    return merged;
  }

  const workbenchAuthToken = crypto.randomBytes(24).toString('hex');
  const isLoopbackHost = (h?: string) =>
    !h || /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(h.trim());
  const isAllowedOrigin = (origin?: string) =>
    !origin ||
    /^(?:https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?|vscode-webview:\/\/[^\s]+|file:\/\/.*)$/i.test(
      origin.trim()
    );

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    // Localhost Security Guard: block DNS Rebinding (`Host`), Cross-Site Browser CSRF (`Origin` / `Sec-Fetch-Site`),
    // and verify `X-DeepAutoCode-Token` when supplied by browser clients.
    if (url.pathname.startsWith('/api/')) {
      const hostHeader = req.headers.host;
      const originHeader = req.headers.origin;
      const secFetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
      const clientToken = String(req.headers['x-deepautocode-token'] || '').trim();

      if (!isLoopbackHost(hostHeader)) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: false,
            error: 'DNS_REBINDING_BLOCKED: Non-loopback Host header rejected',
          })
        );
        return;
      }
      if (!isAllowedOrigin(originHeader) || secFetchSite === 'cross-site') {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: false,
            error: 'CROSS_ORIGIN_BLOCKED: External browser origin is not allowed to call local IDE APIs',
          })
        );
        return;
      }
      if (clientToken && clientToken !== workbenchAuthToken) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: false,
            error: 'INVALID_WORKBENCH_TOKEN: Session token mismatch',
          })
        );
        return;
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/providers/models') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
      } catch {
        body = {};
      }
      try {
        const providerId = String(body.providerId || '');
        let apiKey = typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey : undefined;
        if (!apiKey && providerId) {
          apiKey = await bridge.providerManager.resolveApiKey(providerId).catch(() => undefined);
        }
        const result = await listProviderModels({
          endpoint: String(body.apiEndpoint || ''),
          apiKey,
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: false,
            models: [],
            error: (err as Error).message,
          })
        );
      }
      return;
    }

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

    if (req.method === 'GET' && url.pathname === '/api/claude-settings') {
      const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
      const activeSnap = bridge.providerManager.getActiveProvider();
      const defaultPayload = {
        env: {
          ANTHROPIC_AUTH_TOKEN: 'EMPTY',
          ANTHROPIC_BASE_URL: activeSnap.provider.apiEndpoint,
          ANTHROPIC_DEFAULT_OPUS_MODEL: activeSnap.model.modelId,
          ANTHROPIC_DEFAULT_SONNET_MODEL: activeSnap.model.modelId,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: activeSnap.model.modelId,
          DISABLE_AUTOUPDATER: '1',
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
          CLAUDE_CODE_SKIP_FIRST_RUN: '1',
          CLAUDE_CODE_TELEMETRY: '0',
          DISABLE_TELEMETRY: '1',
          CLAUDE_CODE_WEB_FETCH_SKIP_SAFETY_CHECK: '1',
        },
        autoUpdate: {
          enabled: false,
        },
        hasCompletedOnboarding: true,
        skipOnboarding: true,
        telemetry: {
          enabled: false,
        },
        tui: 'fullscreen',
      };
      try {
        const raw = await fs.readFile(claudeSettingsPath, 'utf-8');
        const parsed = JSON.parse(raw);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: true,
            exists: true,
            filePath: claudeSettingsPath,
            config: parsed,
          })
        );
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: true,
            exists: false,
            filePath: claudeSettingsPath,
            config: defaultPayload,
          })
        );
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/claude-settings') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
        const activeSnap = bridge.providerManager.getActiveProvider();
        const authToken = String(body.authToken ?? 'EMPTY').trim() || 'EMPTY';
        const baseUrl =
          String(body.baseUrl ?? activeSnap.provider.apiEndpoint ?? 'https://open.bigmodel.cn/api/paas/v4')
            .trim()
            .replace(/\/+$/, '') || 'https://open.bigmodel.cn/api/paas/v4';
        const defaultModel =
          String(body.defaultModel ?? activeSnap.model.modelId ?? 'glm-4-plus').trim() ||
          'glm-4-plus';
        const opusModel = String(body.opusModel ?? defaultModel).trim() || defaultModel;
        const sonnetModel = String(body.sonnetModel ?? defaultModel).trim() || defaultModel;
        const haikuModel = String(body.haikuModel ?? defaultModel).trim() || defaultModel;
        const targetProviderId =
          String(body.providerId ?? '').trim() ||
          (/^glm/i.test(opusModel)
            ? 'glm'
            : /^deepseek/i.test(opusModel)
              ? 'deepseek'
              : /^claude/i.test(opusModel)
                ? 'anthropic'
                : activeSnap.provider.providerId || 'openai-compatible');

        const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
        let existing: Record<string, any> = {};
        try {
          existing = JSON.parse(await fs.readFile(claudeSettingsPath, 'utf-8'));
        } catch {
          existing = {};
        }

        const nextConfig = {
          ...existing,
          env: {
            ...(existing.env && typeof existing.env === 'object' ? existing.env : {}),
            ANTHROPIC_AUTH_TOKEN: authToken,
            ANTHROPIC_BASE_URL: baseUrl,
            ANTHROPIC_DEFAULT_OPUS_MODEL: opusModel,
            ANTHROPIC_DEFAULT_SONNET_MODEL: sonnetModel,
            ANTHROPIC_DEFAULT_HAIKU_MODEL: haikuModel,
            DISABLE_AUTOUPDATER: '1',
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            CLAUDE_CODE_SKIP_FIRST_RUN: '1',
            CLAUDE_CODE_TELEMETRY: '0',
            DISABLE_TELEMETRY: '1',
            CLAUDE_CODE_WEB_FETCH_SKIP_SAFETY_CHECK: '1',
          },
          autoUpdate: {
            enabled: false,
          },
          hasCompletedOnboarding: true,
          skipOnboarding: true,
          telemetry: {
            enabled: false,
          },
          tui: 'fullscreen',
        };

        await fs.mkdir(path.dirname(claudeSettingsPath), { recursive: true });
        await fs.writeFile(claudeSettingsPath, JSON.stringify(nextConfig, null, 2) + '\n', 'utf-8');

        // Also update the selected provider in DeepAutoCode ProviderManager
        await bridge.providerManager.configureProvider({
          providerId: targetProviderId,
          apiEndpoint: baseUrl,
          modelId: opusModel,
          apiKey: authToken,
        });
        const active = await bridge.providerManager.getActiveProviderWithKeyStatus();

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: true,
            filePath: claudeSettingsPath,
            config: nextConfig,
            active,
          })
        );
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/agent-memory') {
      try {
        const root = activeWorkspaceRoot || process.cwd();
        const store = await loadAgentMemory(root);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, ...store }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, entries: [], error: (err as Error).message }));
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/agent-memory') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
        const root = activeWorkspaceRoot || process.cwd();
        if (body?.clear) {
          const dir = path.join(root, '.deepautocode');
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(
            path.join(dir, 'agent-memory.json'),
            JSON.stringify(
              { version: 1, updatedAt: new Date().toISOString(), entries: [] },
              null,
              2
            ),
            'utf-8'
          );
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, entries: [] }));
          return;
        }
        const store = await appendAgentMemory(root, {
          source: body.source || 'manual',
          title: String(body.title || 'Manual memory'),
          summary: String(body.summary || ''),
          sessionId: body.sessionId ? String(body.sessionId) : undefined,
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, ...store }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/mcp/test') {
      try {
        const root = activeWorkspaceRoot || process.cwd();
        // Ensure settings are synced to workspace mcp.json first
        const settings = await loadIdeSettings();
        if (settings.mcpServers?.length) {
          const dir = path.join(root, '.deepautocode');
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(
            path.join(dir, 'mcp.json'),
            JSON.stringify({ mcpServers: settings.mcpServers }, null, 2),
            'utf-8'
          );
        }
        const configs = await loadMcpConfigsFromWorkspace(root);
        const host = new McpHost();
        await host.connectAll(configs, root);
        const tools = host.listTools().map((t) => ({
          serverId: t.serverId,
          serverName: t.serverName,
          name: t.name,
          qualifiedName: t.qualifiedName,
          description: t.description || '',
        }));
        const error = host.getLastError();
        await host.dispose();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: !error || tools.length > 0,
            workspaceRoot: root,
            serverCount: configs.length,
            tools,
            error: error || null,
          })
        );
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: false,
            tools: [],
            error: (err as Error).message || String(err),
          })
        );
      }
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
        await lspManager.setWorkspace(activeWorkspaceRoot);
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
        // P0-3: always force-pull on open so stubs/stale cache never masquerade as remote content
        if (sshStatus.connected) {
          await sshManager.pullRemoteBinaryFileToMirror(relParam, true).catch(async () => {
            await sshManager.pullRemoteFileToMirror(relParam, true).catch(() => undefined);
          });
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
          await sshManager.pullRemoteBinaryFileToMirror(relParam, true).catch(async () => {
            await sshManager.pullRemoteFileToMirror(relParam, true).catch(() => undefined);
          });
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
        const problems = await mergeProblemsFromOutput(remoteRes.stdout, remoteRes.stderr);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: remoteRes.exitCode === 0,
            exitCode: remoteRes.exitCode,
            stdout: remoteRes.stdout,
            stderr: remoteRes.stderr,
            cwd: `${sshStatus.activeProfile.username}@${sshStatus.activeProfile.host}:${sshStatus.activeProfile.remotePath}`,
            durationMs: remoteRes.durationMs,
            problems,
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
        const stdoutDecoder = createStreamingConsoleDecoder(512 * 1024);
        const stderrDecoder = createStreamingConsoleDecoder(512 * 1024);
        let stdout = '';
        let stderr = '';
        let serverReadyTimer: ReturnType<typeof setTimeout> | undefined;
        let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
        let exitDrainTimer: ReturnType<typeof setTimeout> | undefined;

        const child = spawn(cmd, {
          cwd: activeWorkspaceRoot,
          shell: true,
          windowsHide: true,
          env: buildUtf8SubprocessEnv(process.env),
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        const finish = (out: { ok: boolean; exitCode: number; stdout: string; stderr: string }) => {
          if (settled) return;
          settled = true;
          if (serverReadyTimer) clearTimeout(serverReadyTimer);
          if (fallbackTimer) clearTimeout(fallbackTimer);
          if (exitDrainTimer) clearTimeout(exitDrainTimer);
          clearTimeout(hardTimeout);
          resolve(out);
        };

        const finalizeWithCode = (code: number | null) => {
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
          terminateChildProcessTree(child);
          finish({
            ok: false,
            exitCode: 1,
            stdout,
            stderr: `${stderr}\nCommand timed out after 30000ms`.trim(),
          });
        }, 30000);

        child.stdout?.on('data', (chunk: Buffer) => {
          stdout = stdoutDecoder.push(chunk);
          checkReady();
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr = stderrDecoder.push(chunk);
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
        child.on('exit', (code) => {
          if (settled || exitDrainTimer) return;
          exitDrainTimer = setTimeout(() => {
            if (settled) return;
            try {
              child.stdout?.destroy();
              child.stderr?.destroy();
              child.unref();
            } catch {
              // ignore
            }
            finalizeWithCode(code);
          }, 350);
        });
        child.on('close', (code) => {
          finalizeWithCode(code);
        });
      });

      const problems = await mergeProblemsFromOutput(execResult.stdout, execResult.stderr);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          ...execResult,
          cwd: activeWorkspaceRoot,
          durationMs: Date.now() - start,
          problems,
        })
      );
      return;
    }

    if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/ssh/status') {
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
        await lspManager.setWorkspace(activeWorkspaceRoot);

        if (!profileInput?.preserveBridge) {
          await bridge.dispose();
          bridge = await AgentClientBridge.create({
            storageDir,
            workspaceRoot: activeWorkspaceRoot,
            initialBackendMode: 'local',
            secretStorage: persistentSecrets,
          });
        }
        registerSshCapabilityHooksIfActive();

        if (!profileInput?.preserveBridge) {
          for (const [ws, sub] of wsSubscriptions.entries()) {
            if (ws.readyState === WebSocket.OPEN) {
              attachWsToCurrentBridge(ws, sub.clientId);
            } else {
              wsSubscriptions.delete(ws);
            }
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

    if (req.method === 'POST' && url.pathname === '/api/ssh/reconnect') {
      try {
        const conn = await sshManager.reconnect();
        activeWorkspaceRoot = conn.workspaceRoot;
        await saveIdeSettings({ activeWorkspace: '__ssh__' });
        await lspManager.setWorkspace(activeWorkspaceRoot);
        registerSshCapabilityHooksIfActive();
        const tree = await buildWorkspaceTree(activeWorkspaceRoot);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: true,
            status: conn.status,
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

    if (req.method === 'POST' && url.pathname === '/api/ssh/conflict-check') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      try {
        const { filePath } = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
        const result = await sshManager.compareWithRemote(String(filePath || ''));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, ...result, filePath }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/ssh/pull-file') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
        const filePath = String(body.filePath || '');
        const allowOverwriteDirty = Boolean(body.allowOverwriteDirty);
        const content = await sshManager.pullRemoteFileToMirror(filePath, true, {
          allowOverwriteDirty,
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, filePath, content }));
      } catch (err) {
        const code = (err as any)?.code || 'SSH_PULL_FAILED';
        res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: false,
            code,
            error: (err as Error).message,
            conflict: Boolean((err as any)?.conflict),
            filePath: (err as any)?.filePath,
          })
        );
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/ssh/disconnect') {
      const status = sshManager.disconnect();
      activeWorkspaceRoot = preSshLocalWorkspaceRoot || '';
      await saveIdeSettings({ activeWorkspace: activeWorkspaceRoot });
      await lspManager.setWorkspace(activeWorkspaceRoot || emptyWorkspaceDir);

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

    if (req.method === 'GET' && url.pathname === '/api/workspace/problems') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ problems: workspaceProblems }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/workspace/problems') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
        if (body?.clear) {
          await persistProblems([]);
        } else if (typeof body?.stdout === 'string' || typeof body?.stderr === 'string') {
          await mergeProblemsFromOutput(String(body.stdout || ''), String(body.stderr || ''));
        } else if (Array.isArray(body?.problems)) {
          await persistProblems(body.problems as BuildDiagnostic[]);
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, problems: workspaceProblems }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/workspace/outline') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      try {
        const { filePath } = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
        const rel = String(filePath || '')
          .replace(/\\/g, '/')
          .replace(/^\.?\//, '');
        if (!activeWorkspaceRoot || !rel) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'NO_FILE' }));
          return;
        }
        const abs = path.resolve(activeWorkspaceRoot, rel);
        if (!abs.startsWith(path.resolve(activeWorkspaceRoot))) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'PATH_BOUNDARY' }));
          return;
        }
        const content = await fs.readFile(abs, 'utf-8');
        const symbols = extractCodeOutlineSymbols(content, {
          filePath: rel,
          maxEntries: 200,
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: true,
            filePath: rel,
            symbolCount: symbols.length,
            symbols,
          })
        );
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/lsp/status') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, ...lspManager.getStatus() }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/lsp/definition') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
        const filePath = String(body.filePath || '');
        const line = Number(body.line) || 1;
        const character = Number(body.character || body.column) || 1;
        const content =
          typeof body.content === 'string' ? body.content : undefined;
        if (activeWorkspaceRoot) {
          await lspManager.setWorkspace(activeWorkspaceRoot);
        }
        const matches = await lspManager.definition(filePath, line, character, content);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: true,
            matches,
            engine: lspManager.getStatus(),
          })
        );
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/lsp/diagnostics') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
        const filePath = String(body.filePath || '');
        const content =
          typeof body.content === 'string' ? body.content : undefined;
        if (activeWorkspaceRoot) {
          await lspManager.setWorkspace(activeWorkspaceRoot);
        }
        const diagnostics = await lspManager.diagnostics(filePath, content);
        // Merge into Problems panel store
        if (diagnostics.length > 0) {
          await mergeProblemsFromOutput(
            diagnostics
              .map(
                (d) =>
                  `${d.file}:${d.line}:${d.column || 1}: ${d.severity}: ${d.message}`
              )
              .join('\n'),
            ''
          );
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, diagnostics, problems: workspaceProblems }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/workspace/definition') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      try {
        const { symbol, currentFile } = JSON.parse(
          Buffer.concat(chunks).toString('utf-8') || '{}'
        );
        const q = String(symbol || '').trim();
        if (!q || !activeWorkspaceRoot) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, matches: [] }));
          return;
        }
        const tree = await buildWorkspaceTree(activeWorkspaceRoot);
        const files = flattenFiles(tree).slice(0, 180);
        const matches: Array<{ file: string; line: number; preview: string }> = [];
        const prefer = String(currentFile || '').replace(/\\/g, '/');
        const ordered = [
          ...files.filter((f) => f === prefer),
          ...files.filter((f) => f !== prefer),
        ];
        for (const relFile of ordered) {
          if (matches.length >= 80) break;
          try {
            const abs = path.join(activeWorkspaceRoot, relFile);
            const stat = await fs.stat(abs);
            if (stat.size > 384 * 1024) continue;
            const content = await fs.readFile(abs, 'utf-8');
            const lines = content.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              if (!lines[i].includes(q)) continue;
              matches.push({
                file: relFile,
                line: i + 1,
                preview: lines[i].trim().slice(0, 140),
              });
              if (matches.length >= 80) break;
            }
          } catch {
            // ignore
          }
        }
        const ranked = rankDefinitionCandidates(q, matches).slice(0, 20);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, symbol: q, matches: ranked }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/extensions') {
      const matrix = await extManager.loadMatrix();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(matrix));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/extensions/install-lsp-pack') {
      try {
        const result = await extManager.installRecommendedLspPack();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      }
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

    // Ghost Text / Inline Code Autocomplete — DeepSeek FIM with heuristic fallback
    const autocompleteCache = ((globalThis as any).__dacAutocompleteCache ??= new Map()) as Map<
      string,
      string
    >;
    if (req.method === 'POST' && url.pathname === '/api/ai/autocomplete') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
        const prefix = String(body.prefix || '');
        const suffix = String(body.suffix || '');
        const filePath = String(body.filePath || '').toLowerCase();
        const cacheKey = `${filePath}|${prefix.slice(-240)}|${suffix.slice(0, 40)}`;
        if (autocompleteCache.has(cacheKey)) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              ok: true,
              completion: autocompleteCache.get(cacheKey) || '',
              cached: true,
            })
          );
          return;
        }

        let completion = '';
        let source: 'fim' | 'heuristic' = 'heuristic';

        // Prefer the currently active provider (including internal Custom / GLM / vLLM or DeepSeek)
        try {
          if (prefix.trim().length >= 8) {
            const activeSnap = bridge.providerManager.getActiveProvider();
            const activeProvider = activeSnap?.provider;
            const activeModelId = activeSnap?.model?.modelId || DEEPSEEK_FLASH;
            let fimProviderId = activeProvider?.providerId || 'deepseek';
            let fimEndpoint = activeProvider?.apiEndpoint || 'https://api.deepseek.com/v1';
            let fimModel =
              fimProviderId === 'deepseek' ? DEEPSEEK_FLASH : activeModelId;
            let apiKey = await bridge.providerManager.resolveApiKey(fimProviderId);
            if (!apiKey && isLocalOrPrivateEndpoint(fimEndpoint)) {
              apiKey = 'EMPTY';
            }
            if (!apiKey && fimProviderId !== 'deepseek') {
              const dsKey = await bridge.providerManager.resolveApiKey('deepseek');
              if (dsKey) {
                apiKey = dsKey;
                fimProviderId = 'deepseek';
                fimEndpoint = 'https://api.deepseek.com/v1';
                fimModel = DEEPSEEK_FLASH;
              }
            }
            if (apiKey && activeProvider?.protocol !== 'anthropic') {
              const fim = await completeDeepSeekFim({
                apiKey,
                prompt: prefix.slice(-3500),
                suffix: suffix.slice(0, 1200),
                model: fimModel,
                apiEndpoint: fimEndpoint,
                providerId: fimProviderId,
                maxTokens: 128,
                temperature: 0,
                timeoutMs: 6_000,
              });
              if (fim.ok && fim.text.trim()) {
                completion = fim.text.replace(/\r\n/g, '\n');
                // Cap multi-line suggestions so ghost text stays readable
                const lines = completion.split('\n');
                if (lines.length > 8) {
                  completion = lines.slice(0, 8).join('\n');
                }
                source = 'fim';
              }
            }
          }
        } catch {
          // silent degrade to heuristics
        }

        if (!completion) {
          const lines = prefix.split(/\r?\n/);
          const lastLine = lines[lines.length - 1] || '';
          const trimmed = lastLine.trim();

          if (trimmed.endsWith('{') && !suffix.trim().startsWith('}')) {
            completion = '\n  \n}';
          } else if (
            trimmed.startsWith('import ') &&
            !trimmed.includes('from') &&
            trimmed.includes('{')
          ) {
            completion =
              filePath.endsWith('.tsx') || filePath.endsWith('.ts')
                ? " from './components';"
                : " from './utils';";
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
          } else if (/^(?:async\s+)?function\s+[a-zA-Z0-9_]+\s*\([^)]*\)\s*$/.test(trimmed)) {
            completion = '{\n  \n}';
          } else if (/^export\s+const\s+[a-zA-Z0-9_]+\s*=\s*$/.test(trimmed)) {
            completion = '() => {\n  return null;\n};';
          }
        }

        if (autocompleteCache.size > 200) {
          const first = autocompleteCache.keys().next().value;
          if (first) autocompleteCache.delete(first);
        }
        autocompleteCache.set(cacheKey, completion);

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, completion, cached: false, source }));
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
        const parsedTargetUrl = new URL(targetUrl);
        if (
          (parsedTargetUrl.protocol !== 'http:' && parsedTargetUrl.protocol !== 'https:') ||
          parsedTargetUrl.hostname === '169.254.169.254' ||
          parsedTargetUrl.hostname === 'metadata.google.internal'
        ) {
          throw new Error(`Disallowed browser inspection URL: ${targetUrl}`);
        }
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
  <script nonce="${nonce}">
    window.__DAC_INITIAL_THEME__ = ${JSON.stringify(savedTheme)};
    window.__DAC_WORKBENCH_TOKEN__ = ${JSON.stringify(workbenchAuthToken)};
    (function() {
      var origFetch = window.fetch;
      if (typeof origFetch === 'function') {
        window.fetch = function(input, init) {
          try {
            var urlStr = typeof input === 'string' ? input : (input && input.url) || '';
            if (urlStr.startsWith('/api/') || urlStr.indexOf(window.location.origin + '/api/') === 0) {
              var nextInit = Object.assign({}, init || {});
              var headers = new Headers(nextInit.headers || (input instanceof Request ? input.headers : undefined));
              if (!headers.has('X-DeepAutoCode-Token')) {
                headers.set('X-DeepAutoCode-Token', window.__DAC_WORKBENCH_TOKEN__);
              }
              nextInit.headers = headers;
              return origFetch.call(window, input, nextInit);
            }
          } catch (_e) {}
          return origFetch.call(window, input, init);
        };
      }
    })();
  </script>
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
  // Disable Node 20's default 5-minute HTTP requestTimeout so long-running /api/bridge Agent turns never drop prematurely
  server.requestTimeout = 0;
  server.headersTimeout = 120000;
  wss.on('error', (err) => {
    console.error('[DeepAutoCode WS Server] Error (guarded):', err?.message || err);
  });
  wss.on('connection', (ws, req) => {
    const reqOrigin = req?.headers?.origin;
    const reqHost = req?.headers?.host;
    if (!isLoopbackHost(reqHost) || !isAllowedOrigin(reqOrigin)) {
      ws.close(1008, 'Cross-origin WebSocket connection rejected');
      return;
    }
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
    authToken: workbenchAuthToken,
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
