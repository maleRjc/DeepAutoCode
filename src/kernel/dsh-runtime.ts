import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client';
import {
  createUnifiedDiff,
  type AgentExecutionMode,
  type BackendMode,
  type ClineRuntimeEvent,
  type DiffChangeRecord,
  type IClineCoreInstance,
  type SendPromptInput,
  type SessionManifest,
  type SessionMessage,
  type SessionTimelineItem,
  type StartSessionInput,
  type ToolCallRecord,
} from '@deepautocode/agent';
import { DshSessionStore, type DshSessionManifest } from './store.js';
import { startGatewayProxy, type GatewayDelta, type GatewayProxy } from './gateway-proxy.js';

/** Minimal shape of the DAC agent bridge we need for human-in-the-loop approvals. */
interface ApprovalCapableBridge {
  approvalBridge?: {
    requestApproval(input: {
      sessionId: string;
      toolName: string;
      summary: string;
      risk: 'low' | 'medium' | 'high' | 'critical';
      targetPath?: string;
      command?: string;
      cwd?: string;
      arguments?: Record<string, unknown>;
    }): Promise<{ approved: boolean; approvalId: string }>;
  };
}

const DSH_PROVIDER = 'deepseek-official';

/** Filesystem tools whose successful call produces a reviewable diff in the IDE. */
const EDIT_TOOL_NAMES = new Set(['write', 'edit', 'str_replace_editor', 'apply_patch']);

interface TurnBuffer {
  text: string;
  thinking: string;
  toolCalls: ToolCallRecord[];
  timeline: SessionTimelineItem[];
}

interface SessionState {
  manifest: DshSessionManifest;
  messages: SessionMessage[];
  diffs: DiffChangeRecord[];
  client?: HarnessClient;
  initializing?: Promise<HarnessClient>;
  apiKey?: string;
  busy: boolean;
  queue: Array<{ prompt: string; images?: SendPromptInput['images'] }>;
  turn: TurnBuffer;
  pendingDiffByCall: Map<string, { filePath: string; before: string; operation: 'create' | 'modify' }>;
  startedAtByCall: Map<string, number>;
  dshSessionReady: boolean;
  /** True while the gateway proxy already streamed this turn's text. */
  streamedThisTurn?: boolean;
  /** Reason reported by the kernel's `turn/end` when a turn did not complete. */
  lastTurnError?: string;
}

export interface DshRuntimeOptions {
  storageDir: string;
  backendMode?: BackendMode;
  dshHome?: string;
  providerManager?: ProviderManagerLike;
}

/** Minimal view of the DAC ProviderManager needed to declare gateway routes. */
interface ProviderManagerLike {
  getProviderById?(providerId: string): ProviderProfileLike | undefined;
}

interface ProviderProfileLike {
  protocol?: string;
  apiEndpoint?: string;
  models?: Array<{
    modelId: string;
    displayName?: string;
    contextWindow?: number;
    maxOutputTokens?: number;
  }>;
}

/**
 * The DeepSeek Harness kernel behind the DeepAutoCode workbench.
 *
 * Implements the DAC `IClineCoreInstance` contract so the whole existing
 * Workbench server (sessions, approvals, diffs, REST surface and the React UI)
 * keeps working while model turns and tool execution are provided by `dsh`.
 */
export class DshRuntime implements IClineCoreInstance {
  readonly instanceId = `dsh-runtime-${crypto.randomUUID()}`;
  readonly backendMode: BackendMode = 'local';
  readonly storageDir: string;
  readonly sdkUnderlyingAvailable = true;

  private readonly store: DshSessionStore;
  private readonly dshHome: string;
  private readonly providerManager?: ProviderManagerLike;
  private readonly listeners = new Set<(event: ClineRuntimeEvent) => void>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly relayTunnels = new Map<string, { port: number; child: ChildProcess }>();
  private readonly gatewayProxies = new Map<string, GatewayProxy>();
  /** clientKey -> session whose turn is currently waiting on the model. */
  private readonly activeTurns = new Map<string, SessionState>();
  /**
   * One Harness process can host many sessions; sharing it keeps the provider's
   * prefix cache warm and skips the 3–5s process+boot cost per conversation.
   */
  private readonly clientPool = new Map<
    string,
    { client?: HarnessClient; initializing?: Promise<HarnessClient> }
  >();

  constructor(options: DshRuntimeOptions) {
    this.storageDir = options.storageDir;
    this.store = new DshSessionStore(options.storageDir);
    this.providerManager = options.providerManager;
    // Reuse the user's existing Harness home by default so a DeepSeek key that
    // was already configured for `dsh` keeps working here; DSH_KERNEL_HOME can
    // point at an isolated home instead.
    this.dshHome =
      options.dshHome ??
      process.env.DSH_KERNEL_HOME ??
      process.env.DSH_HOME ??
      path.join(os.homedir(), '.dsh');
  }

  // ---------------------------------------------------------------- lifecycle

  async start(input: StartSessionInput): Promise<{
    sessionId: string;
    manifest: SessionManifest;
    manifestPath: string;
  }> {
    const sessionId = input.sessionId ?? `sess_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    const manifest: DshSessionManifest = {
      sessionId,
      title: input.title?.trim() || 'AI Session',
      workspaceRoot: input.config.workspaceRoot,
      providerId: input.config.providerId,
      modelId: input.config.modelId,
      backendMode: this.backendMode,
      executionMode: (input.config.executionMode ?? 'auto') as AgentExecutionMode,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      lastSequence: 0,
      sdkManaged: true,
      storagePath: this.store.sessionDir(sessionId),
      kernel: 'dsh',
      dshSessionId: `dsh_${crypto.randomUUID()}`,
    };

    const state: SessionState = {
      manifest,
      messages: [],
      diffs: [],
      apiKey: input.config.apiKey,
      busy: false,
      queue: [],
      turn: this.emptyTurn(),
      pendingDiffByCall: new Map(),
      startedAtByCall: new Map(),
      dshSessionReady: false,
    };

    this.sessions.set(sessionId, state);
    await this.store.writeManifest(manifest);
    await this.store.writeMessages(sessionId, []);

    if (input.prompt && input.prompt.trim()) {
      // Fire and forget: the Webview already receives the session, then events.
      void this.send({
        sessionId,
        prompt: input.prompt,
        workspaceRoot: input.config.workspaceRoot,
        executionMode: input.config.executionMode,
      }).catch((err) => this.emitError(state, err));
    }

    return { sessionId, manifest, manifestPath: this.store.manifestPath(sessionId) };
  }

  async send(input: SendPromptInput): Promise<{ message: SessionMessage }> {
    const state = this.requireState(input.sessionId);
    const now = new Date().toISOString();
    const message: SessionMessage = {
      id: `msg_${crypto.randomUUID()}`,
      sessionId: state.manifest.sessionId,
      role: 'user',
      content: input.prompt,
      sequence: state.messages.length + 1,
      timestamp: now,
      images: input.images,
    };
    state.messages.push(message);
    state.manifest.updatedAt = now;
    state.manifest.status = 'running';
    state.manifest.lastSequence = Math.max(state.manifest.lastSequence, message.sequence);
    await this.persist(state);
    this.emit(state, 'session_state', { status: 'running' });

    state.queue.push({ prompt: input.prompt, images: input.images });
    this.drainQueue(state).catch((err) => this.emitError(state, err));

    return { message };
  }

  subscribe(listener: (event: ClineRuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---------------------------------------------------------------- inspection

  async list(): Promise<SessionManifest[]> {
    const manifests = await this.store.listManifests();
    return manifests;
  }

  async get(sessionId: string): Promise<SessionManifest | null> {
    const live = this.sessions.get(sessionId);
    if (live) return live.manifest;
    const record = await this.store.readRecord(sessionId);
    return record?.manifest ?? null;
  }

  async readMessages(sessionId: string): Promise<SessionMessage[]> {
    const live = this.sessions.get(sessionId);
    if (live) return [...live.messages];
    const record = await this.store.readRecord(sessionId);
    return record?.messages ?? [];
  }

  async readDiffs(sessionId: string): Promise<DiffChangeRecord[]> {
    const live = this.sessions.get(sessionId);
    if (live) return [...live.diffs];
    const record = await this.store.readRecord(sessionId);
    return record?.diffs ?? [];
  }

  // ---------------------------------------------------------------- diff review

  async updateDiffStatus(
    sessionId: string,
    diffId: string,
    status: DiffChangeRecord['status'],
    feedback?: string
  ): Promise<DiffChangeRecord | null> {
    const state = await this.requireStateLazy(sessionId);
    if (!state) return null;
    const diff = state.diffs.find((d) => d.diffId === diffId);
    if (!diff) return null;

    if (status === 'rejected' && diff.appliedToDisk) {
      const abs = path.resolve(state.manifest.workspaceRoot, diff.filePath);
      try {
        if (diff.operation === 'create') await fs.rm(abs, { force: true });
        else await fs.writeFile(abs, diff.originalContent, 'utf8');
        diff.appliedToDisk = false;
      } catch (err) {
        this.emitError(state, err);
      }
    }

    diff.status = status;
    diff.feedback = feedback ?? diff.feedback;
    diff.updatedAt = new Date().toISOString();
    await this.store.writeDiffs(sessionId, state.diffs);
    this.emit(state, 'diff_updated', diff as unknown as Record<string, unknown>);
    return diff;
  }

  async updateDiffProposed(
    sessionId: string,
    diffId: string,
    proposedContent: string,
    options?: { writeToDisk?: boolean; finalize?: 'accept' | 'reject' | 'keep' }
  ): Promise<DiffChangeRecord | null> {
    const state = await this.requireStateLazy(sessionId);
    if (!state) return null;
    const diff = state.diffs.find((d) => d.diffId === diffId);
    if (!diff) return null;

    diff.proposedContent = proposedContent;
    diff.unifiedDiff = createUnifiedDiff(diff.filePath, diff.originalContent, proposedContent);
    diff.updatedAt = new Date().toISOString();

    if (options?.writeToDisk) {
      const abs = path.resolve(state.manifest.workspaceRoot, diff.filePath);
      await fs.writeFile(abs, proposedContent, 'utf8');
      diff.appliedToDisk = true;
    }
    if (options?.finalize === 'accept') diff.status = 'accepted';
    if (options?.finalize === 'reject') diff.status = 'rejected';

    await this.store.writeDiffs(sessionId, state.diffs);
    this.emit(state, 'diff_updated', diff as unknown as Record<string, unknown>);
    return diff;
  }

  async reviewAllPendingDiffs(
    sessionId: string,
    action: 'accept' | 'reject'
  ): Promise<DiffChangeRecord[]> {
    const state = await this.requireStateLazy(sessionId);
    if (!state) return [];
    const pending = state.diffs.filter((d) => d.status === 'pending');
    const results: DiffChangeRecord[] = [];
    for (const diff of pending) {
      const updated = await this.updateDiffStatus(
        sessionId,
        diff.diffId,
        action === 'accept' ? 'accepted' : 'rejected'
      );
      if (updated) results.push(updated);
    }
    return results;
  }

  // ---------------------------------------------------------------- checkpoints (not needed by the DSH kernel)

  async createCheckpoint(): Promise<null> {
    return null;
  }

  async listCheckpoints(): Promise<[]> {
    return [];
  }

  async restoreCheckpoint(): Promise<{ ok: boolean; restored: number; deleted: number; checkpointId: string }> {
    return { ok: false, restored: 0, deleted: 0, checkpointId: '' };
  }

  // ---------------------------------------------------------------- stop / delete

  async abort(sessionId: string, _reason?: string): Promise<boolean> {
    const state = this.sessions.get(sessionId);
    if (!state) return false;
    state.queue.length = 0;
    state.busy = false;
    const hadClient = Boolean(this.clientPool.get(this.clientKey(state))?.client);
    await this.closeClient(state);
    state.dshSessionReady = false;
    state.manifest.status = 'cancelled';
    state.manifest.updatedAt = new Date().toISOString();
    await this.persist(state);
    this.emit(state, 'session_state', { status: 'cancelled' });
    return hadClient;
  }

  async stop(sessionId: string): Promise<boolean> {
    return this.abort(sessionId);
  }

  async delete(sessionId: string): Promise<boolean> {
    await this.abort(sessionId).catch(() => false);
    this.sessions.delete(sessionId);
    await this.store.deleteSession(sessionId);
    return true;
  }

  async dispose(): Promise<void> {
    for (const entry of this.clientPool.values()) {
      if (entry.client) await entry.client.close().catch(() => {});
    }
    this.clientPool.clear();
    for (const tunnel of this.relayTunnels.values()) {
      try {
        tunnel.child.kill();
      } catch {
        // ignore
      }
    }
    this.relayTunnels.clear();
    for (const proxy of this.gatewayProxies.values()) {
      try {
        proxy.close();
      } catch {
        // ignore
      }
    }
    this.gatewayProxies.clear();
    this.sessions.clear();
    this.listeners.clear();
  }

  // ---------------------------------------------------------------- kernel plumbing

  private async drainQueue(state: SessionState): Promise<void> {
    if (state.busy) return;
    const next = state.queue.shift();
    if (!next) return;

    state.busy = true;
    const timeoutMs = Number(process.env.DSH_KERNEL_TURN_TIMEOUT_MS ?? 900000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let subscription:
      | { next(): Promise<{ method: string; params: Record<string, unknown> }>; close(): void }
      | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `内核在 ${Math.round(timeoutMs / 1000)}s 内没有完成本轮（初始化卡住、网络不可达或模型无响应）。` +
                  '这是本机连不上模型服务的典型表现；请检查网络/代理与 API Key，或调大 DSH_KERNEL_TURN_TIMEOUT_MS 后重试。'
              )
            ),
          timeoutMs
        );
      });
      await Promise.race([
        this.performTurn(state, next, (sub) => {
          subscription = sub;
        }),
        deadline,
      ]);
    } catch (err) {
      subscription?.close();
      await this.closeClient(state);
      state.dshSessionReady = false;
      this.emitError(state, err);
      await this.finishTurn(state, true);
    } finally {
      if (timer) clearTimeout(timer);
      state.busy = false;
      if (state.queue.length > 0) {
        void this.drainQueue(state).catch((err) => this.emitError(state, err));
      }
    }
  }

  private async performTurn(
    state: SessionState,
    item: { prompt: string; images?: SendPromptInput['images'] },
    onSubscription: (sub: {
      next(): Promise<{ method: string; params: Record<string, unknown> }>;
      close(): void;
    }) => void
  ): Promise<void> {
    if (state.manifest.providerId === 'deepseek' && !state.apiKey && !process.env.DEEPSEEK_API_KEY) {
      // The kernel can also resolve credentials from its own home
      // (~/.dsh/.credentials.yaml) — a key configured for official `dsh`
      // keeps working here, so only fail when no source can provide one.
      const homeCredential = await fs
        .access(path.join(this.dshHome, '.credentials.yaml'))
        .then(() => true)
        .catch(() => false);
      if (!homeCredential) {
        throw new Error(
          '缺少 DeepSeek API Key：请点右上角「设置」→ Provider 选 DeepSeek → 填入 API Key 并保存；' +
            '或设置环境变量 DEEPSEEK_API_KEY，或先在 DeepSeek Harness 里登录（会复用 ~/.dsh 凭据）。'
        );
      }
    }

    const client = await this.ensureClient(state);
    const dshSessionId = state.manifest.dshSessionId!;
    this.activeTurns.set(this.clientKey(state), state);
    state.streamedThisTurn = false;
    state.lastTurnError = undefined;

    if (state.manifest.status === 'cancelled') {
      state.manifest.status = 'running';
    }

    const sub = client.subscribeSessionTree(dshSessionId);
    onSubscription(sub);
    const idle = new Promise<void>((resolve) => {
      const pump = async () => {
        for (;;) {
          let notification;
          try {
            notification = await sub.next();
          } catch {
            resolve();
            return;
          }
          this.handleNotification(state, notification);
          if (
            notification.method === 'session.status' &&
            (notification.params as { sessionId?: string }).sessionId === dshSessionId &&
            (notification.params as { status?: string }).status === 'idle'
          ) {
            resolve();
            return;
          }
        }
      };
      void pump();
    });

    const blocks: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [
      { type: 'text', text: item.prompt },
    ];
    for (const image of item.images ?? []) {
      const match = /^data:([^;]+);base64,(.*)$/i.exec(image.dataUrl ?? '');
      if (match) blocks.push({ type: 'image', data: match[2], mimeType: match[1] });
    }

    await client.prompt(dshSessionId, blocks as never);
    await idle;
    sub.close();

    await this.finishTurn(state);
  }

  private clientKey(state: SessionState): string {
    const rawKey = state.apiKey ?? '';
    const hashed = rawKey
      ? crypto.createHash('sha1').update(rawKey).digest('hex').slice(0, 12)
      : 'none';
    return JSON.stringify({
      provider: state.manifest.providerId,
      model: state.manifest.modelId,
      cwd: state.manifest.workspaceRoot,
      home: this.dshHome,
      key: hashed,
    });
  }

  private async closeClient(state: SessionState): Promise<void> {
    const key = this.clientKey(state);
    const entry = this.clientPool.get(key);
    this.clientPool.delete(key);
    if (entry?.client) await entry.client.close().catch(() => {});
  }

  private async ensureClient(state: SessionState): Promise<HarnessClient> {
    const key = this.clientKey(state);
    let entry = this.clientPool.get(key);
    if (entry?.client) return entry.client;
    if (entry?.initializing) return entry.initializing;
    if (!entry) {
      entry = {};
      this.clientPool.set(key, entry);
    }

    const isDeepSeek = state.manifest.providerId === 'deepseek';
    const env: NodeJS.ProcessEnv = { ...process.env };
    let provider = DSH_PROVIDER;
    let model = this.resolveModel(state.manifest.modelId);
    let patches: string[] | undefined;

    if (isDeepSeek) {
      const apiKey = state.apiKey ?? process.env.DEEPSEEK_API_KEY;
      if (apiKey) env.DEEPSEEK_API_KEY = apiKey;
      const deepseekEndpoint =
        this.providerManager?.getProviderById?.('deepseek')?.apiEndpoint || 'https://api.deepseek.com/v1';
      await this.assertReachable(deepseekEndpoint);
    } else {
      const route = await this.ensureGatewayRoute(state);
      provider = route.provider;
      model = route.model;
      patches = [route.patchPath];
      // The declared route resolves its key through apiKeyEnv per request.
      env.DAC_LLM_API_KEY = state.apiKey ?? process.env.DAC_LLM_API_KEY ?? 'EMPTY';
    }
    // Electron runs the kernel process with its bundled Node; force it into
    // Node mode so `process.execPath <dsh bin>` behaves like plain `node`.
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';

    if (process.env.DSH_KERNEL_DEBUG === '1') {
      console.log(
        `[dsh-kernel] provider=${provider} model=${model} patches=${patches?.join(',') ?? '-'} ` +
          `apiKeyFromSession=${state.apiKey ? 'yes' : 'no'} ` +
          `DAC_LLM_API_KEY=${env.DAC_LLM_API_KEY ? `len:${env.DAC_LLM_API_KEY.length}` : '-'} ` +
          `DEEPSEEK_API_KEY=${env.DEEPSEEK_API_KEY ? `len:${env.DEEPSEEK_API_KEY.length}` : '-'}`
      );
    }

    const dshHome = this.dshHome;
    const initialize = async (): Promise<HarnessClient> => {
      const client = new HarnessClient({
        dshHome,
        profile: 'sdk',
        env,
        patches,
        initializeTimeoutMs: Number(process.env.DSH_KERNEL_INIT_TIMEOUT_MS ?? 180000),
        onUserQuestion: async () => ({ cancelled: true }),
      });
      client.start();
      client.onRequest(async (method, params) => {
        if (method !== 'approval/request') throw new Error(`Unsupported request: ${method}`);
        return this.answerApproval(state, params as Record<string, unknown>);
      });
      await client.initialize({
        cwd: state.manifest.workspaceRoot,
        provider,
        model,
        approvalRequests: true,
        capabilities: { userQuestions: true },
      });

      if (state.manifest.dshSessionId && state.messages.length > 0) {
        await client.resumeSession(state.manifest.dshSessionId).catch(() => {});
      }
      return client;
    };

    entry.initializing = initialize().then(
      (client) => {
        entry!.client = client;
        entry!.initializing = undefined;
        state.dshSessionReady = true;
        return client;
      },
      (err) => {
        entry!.initializing = undefined;
        this.clientPool.delete(key);
        throw err;
      }
    );
    return entry.initializing;
  }

  /**
   * Declare a pi-ai gateway route for a non-DeepSeek provider so any
   * OpenAI-compatible endpoint (vLLM / SGLang / Ollama / GLM / company gateway)
   * or Anthropic endpoint can drive the kernel.
   */
  private async ensureGatewayRoute(
    state: SessionState
  ): Promise<{ provider: string; model: string; patchPath: string }> {
    const providerId = state.manifest.providerId;
    const profile = this.providerManager?.getProviderById?.(providerId);
    const endpoint = profile?.apiEndpoint?.trim();
    if (!endpoint) {
      throw new Error(
        `Provider「${providerId}」缺少 API Endpoint。请点右上角「设置」填写接口地址后再试。`
      );
    }
    if (!/^https?:\/\//i.test(endpoint)) {
      throw new Error(`Provider「${providerId}」的 API Endpoint 必须以 http(s):// 开头：${endpoint}`);
    }

    const api = profile?.protocol === 'anthropic' ? 'anthropic-messages' : 'openai-completions';
    const baseURL = this.normalizeBaseUrl(endpoint, api);
    // Private LAN gateways are often only reachable through an SSH relay host
    // (the official DeepAutoCode app does the same); try direct first, then tunnel.
    const effective = await this.resolveReachableBaseUrl(baseURL);
    let gatewayBaseURL = effective.url;
    if (effective.relayed) {
      // Always proxied for relayed gateways: the proxy both forwards SSE deltas
      // to the UI (real token streaming) and can disable the thinking pass.
      const proxyKey = this.clientKey(state);
      let proxy = this.gatewayProxies.get(proxyKey);
      if (!proxy) {
        const started = await startGatewayProxy({
          targetOrigin: new URL(effective.url).origin,
          disableThinking: process.env.DSH_KERNEL_DISABLE_THINKING === '1',
          onDelta: (delta) => this.forwardGatewayDelta(proxyKey, delta),
        });
        proxy = started;
        this.gatewayProxies.set(proxyKey, started);
        if (process.env.DSH_KERNEL_DEBUG === '1') {
          console.log(
            `[dsh-kernel] gateway proxy 127.0.0.1:${started.port} -> ${effective.url} ` +
              `(thinking ${process.env.DSH_KERNEL_DISABLE_THINKING === '1' ? 'off' : 'on'})`
          );
        }
      }
      const basePath = new URL(effective.url).pathname.replace(/\/$/, '');
      gatewayBaseURL = `http://127.0.0.1:${proxy.port}${basePath}`;
    }
    const modelId = state.manifest.modelId || profile?.models?.[0]?.modelId || 'default';
    const catalog = profile?.models?.length
      ? profile.models
      : [{ modelId, displayName: modelId, contextWindow: 131072, maxOutputTokens: 16384 }];
    const modelEntry = catalog.find((m) => m.modelId === modelId) ?? catalog[0];

    const yaml = [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      dac-gateway:',
      "        displayName: 'DeepAutoCode Gateway'",
      `        api: ${api}`,
      `        baseURL: ${JSON.stringify(gatewayBaseURL)}`,
      '        apiKeyEnv: DAC_LLM_API_KEY',
      '        models:',
      `          - id: ${JSON.stringify(modelId)}`,
      `            name: ${JSON.stringify(modelEntry.displayName || modelId)}`,
      `            contextWindow: ${Math.max(4096, Number(modelEntry.contextWindow) || 131072)}`,
      `            maxTokens: ${Math.max(1024, Number(modelEntry.maxOutputTokens) || 16384)}`,
      '',
    ].join('\n');

    const dir = path.resolve(this.storageDir, '..', 'kernel');
    await fs.mkdir(dir, { recursive: true });
    const patchPath = path.join(dir, 'pi-ai-gateway.yml');
    await fs.writeFile(patchPath, yaml, 'utf8');

    return { provider: 'dac-gateway', model: modelId, patchPath };
  }

  private normalizeBaseUrl(endpoint: string, api: string): string {
    let base = endpoint.replace(/\/+$/, '');
    if (api === 'anthropic-messages') return base;
    // OpenAI-compatible servers expect the version segment in the base URL.
    if (!/\/v\d+(?:[a-z0-9.-]*)?$/i.test(base)) base += '/v1';
    return base;
  }

  /**
   * Fail fast when the model endpoint cannot be reached at all.
   *
   * Without this the kernel just waits on a dead TCP connection (the provider's
   * own timeout is minutes long), which looks like "no reaction" in the UI.
   */
  private async assertReachable(endpoint: string, timeoutOverrideMs?: number): Promise<void> {
    if (process.env.DSH_KERNEL_SKIP_PREFLIGHT === '1') return;
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new Error(`模型 Endpoint 不是合法 URL：${endpoint}。请在「设置」里修正 API Base Endpoint。`);
    }
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    const host = url.hostname;
    const timeoutMs = timeoutOverrideMs ?? Number(process.env.DSH_KERNEL_PREFLIGHT_TIMEOUT_MS ?? 4000);

    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect({ host, port });
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error(`${timeoutMs / 1000}s 内无响应（服务未启动或网络/VPN 不通）`));
        }, timeoutMs);
        socket.once('connect', () => {
          clearTimeout(timer);
          socket.end();
          resolve();
        });
        socket.once('error', (err: NodeJS.ErrnoException) => {
          clearTimeout(timer);
          socket.destroy();
          reject(new Error(err.code || err.message));
        });
      });
    } catch (err) {
      throw new Error(
        `无法连接模型网关 ${host}:${port}：${(err as Error).message}。` +
          '请确认该服务已启动、本机网络/VPN 能访问它；也可以先在「设置 → 测试连通性」里验证。'
      );
    }
  }

  private resolveModel(modelId?: string): string {
    const override = process.env.DSH_KERNEL_MODEL?.trim();
    if (override) return override;
    const model = (modelId ?? '').toLowerCase();
    if (model.includes('pro')) return 'deepseek-v4-pro';
    return 'deepseek-v4-flash';
  }

  /**
   * Resolve the URL the kernel should actually call. Private LAN gateways are
   * commonly reachable only from an SSH relay host, so fall back to a local
   * port forward through `ssh` when a direct connection fails.
   */
  private async resolveReachableBaseUrl(
    baseURL: string
  ): Promise<{ url: string; relayed: boolean }> {
    const url = new URL(baseURL);
    const host = url.hostname;
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));

    if (!this.isPrivateLanHost(host)) {
      await this.assertReachable(baseURL);
      return { url: baseURL, relayed: false };
    }

    // A TCP probe is not enough here: these LAN gateways often accept the TCP
    // connection and then reset the HTTP request unless it comes from the
    // relay network. When a relay host exists, use it directly.
    const alias = await this.resolveRelayAlias();
    if (!alias || process.env.DSH_KERNEL_NO_SSH_RELAY === '1') {
      await this.assertReachable(baseURL, 2500);
      return { url: baseURL, relayed: false };
    }

    try {
      const localPort = await this.openRelayTunnel(host, port, alias);
      const relayed = new URL(baseURL);
      relayed.hostname = '127.0.0.1';
      relayed.port = String(localPort);
      if (process.env.DSH_KERNEL_DEBUG === '1') {
        console.log(`[dsh-kernel] relay ${host}:${port} -> 127.0.0.1:${localPort} via ${alias}`);
      }
      return { url: relayed.toString().replace(/\/$/, ''), relayed: true };
    } catch (relayError) {
      // Fall back to a direct connection only when the relay cannot start.
      try {
        await this.assertReachable(baseURL, 2500);
        return { url: baseURL, relayed: false };
      } catch {
        throw relayError;
      }
    }
  }

  private isPrivateLanHost(host: string): boolean {
    return /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host);
  }

  private async resolveRelayAlias(): Promise<string | null> {
    const fromEnv =
      process.env.DAC_SSH_RELAY_HOST?.trim() || process.env.DSH_KERNEL_SSH_RELAY?.trim();
    if (fromEnv) return fromEnv;
    try {
      const configPath = path.join(os.homedir(), '.ssh', 'config');
      const raw = await fs.readFile(configPath, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        const match = line.trim().match(/^Host\s+([^\s*#]+)/i);
        if (match?.[1]) return match[1].trim();
      }
    } catch {
      // no ssh config
    }
    return null;
  }

  private async findFreePort(): Promise<number> {
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

  private async openRelayTunnel(host: string, port: number, alias: string): Promise<number> {
    const key = `${host}:${port}`;
    const existing = this.relayTunnels.get(key);
    if (existing && existing.child.exitCode === null) return existing.port;

    const localPort = await this.findFreePort();
    const child = spawn(
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
    this.relayTunnels.set(key, { port: localPort, child });
    child.on('exit', () => {
      const current = this.relayTunnels.get(key);
      if (current?.child === child) this.relayTunnels.delete(key);
    });

    try {
      await this.waitForPort(localPort, 15000);
    } catch (err) {
      child.kill();
      this.relayTunnels.delete(key);
      throw new Error(
        `SSH 中继 ${alias} 启动失败：${(err as Error).message}。请确认 \`ssh ${alias}\` 能免密登录，且该主机能访问 ${host}:${port}。`
      );
    }
    return localPort;
  }

  private async waitForPort(port: number, timeoutMs: number): Promise<void> {
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

  private async answerApproval(
    state: SessionState,
    params: Record<string, unknown>
  ): Promise<{ outcome: 'allowed-once' | 'rejected' | 'cancelled' }> {
    const toolName = String(params.toolName ?? 'tool');
    const reason = String(params.reason ?? '');
    const bridge = (globalThis as { __dacAgentBridge?: ApprovalCapableBridge }).__dacAgentBridge;
    if (!bridge?.approvalBridge) return { outcome: 'allowed-once' };

    try {
      const decision = await bridge.approvalBridge.requestApproval({
        sessionId: state.manifest.sessionId,
        toolName,
        summary: reason || `Allow ${toolName}?`,
        risk: toolName.includes('bash') || toolName.includes('pwsh') ? 'high' : 'medium',
        arguments: params as Record<string, unknown>,
      });
      return { outcome: decision.approved ? 'allowed-once' : 'rejected' };
    } catch {
      return { outcome: 'cancelled' };
    }
  }

  private forwardGatewayDelta(clientKey: string, delta: GatewayDelta): void {
    const state = this.activeTurns.get(clientKey);
    if (!state) return;
    if (delta.reasoning) {
      state.turn.thinking += delta.reasoning;
      state.streamedThisTurn = true;
      this.emit(state, 'thinking_delta', { delta: delta.reasoning });
    }
    if (delta.text) {
      state.turn.text += delta.text;
      state.streamedThisTurn = true;
      this.emit(state, 'text_delta', { delta: delta.text });
    }
  }

  private handleNotification(
    state: SessionState,
    notification: { method: string; params: Record<string, unknown> }
  ): void {
    if (process.env.DSH_KERNEL_DEBUG === '1') {
      const ev = (notification.params as { event?: { type?: string } }).event;
      console.log(`[dsh-kernel] notify ${notification.method}${ev?.type ? '/' + ev.type : ''}`);
    }
    if (notification.method === 'session.status') return;

    if (notification.method === 'session.event') {
      const event = notification.params.event as
        | { type?: string; data?: Record<string, any> }
        | undefined;
      if (!event?.type) return;
      this.handleSessionEvent(state, event.type, event.data ?? {});
    }
  }

  private handleSessionEvent(
    state: SessionState,
    type: string,
    data: Record<string, any>
  ): void {
    switch (type) {
      case 'assistant/message': {
        if (process.env.DSH_KERNEL_DEBUG === '1' && data.usage) {
          console.log('[dsh-kernel] usage', JSON.stringify(data.usage));
        }
        // The gateway proxy already streamed these deltas for this turn.
        if (state.streamedThisTurn) break;
        const message = data.message;
        const content: any[] = Array.isArray(message?.content) ? message.content : [];
        for (const block of content) {
          if (block?.type === 'reasoning' && block.text) {
            state.turn.thinking += String(block.text);
            this.emit(state, 'thinking_delta', { delta: String(block.text) });
            state.turn.timeline.push({
              id: `tl_think_${crypto.randomUUID()}`,
              kind: 'thinking',
              timestamp: new Date().toISOString(),
              thinking: String(block.text),
            });
          } else if (block?.type === 'text' && block.text) {
            state.turn.text += String(block.text);
            this.emit(state, 'text_delta', { delta: String(block.text) });
            state.turn.timeline.push({
              id: `tl_text_${crypto.randomUUID()}`,
              kind: 'text',
              timestamp: new Date().toISOString(),
              text: String(block.text),
            });
          }
        }
        break;
      }
      case 'tool/call': {
        const callId = String(data.callId ?? crypto.randomUUID());
        const name = String(data.name ?? 'tool');
        const startedAt = new Date().toISOString();
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(String(data.arguments ?? '{}')) as Record<string, unknown>;
        } catch {
          args = { raw: String(data.arguments ?? '') };
        }
        const record: ToolCallRecord = {
          toolCallId: callId,
          toolName: name,
          args,
          status: 'running',
          risk: name.includes('bash') || name.includes('pwsh') ? 'high' : 'medium',
          startedAt,
        };
        state.turn.toolCalls.push(record);
        state.startedAtByCall.set(callId, Date.now());
        this.emit(state, 'tool_call_started', record as unknown as Record<string, unknown>);
        void this.captureBeforeEdit(state, callId, name, args);
        break;
      }
      case 'tool/result': {
        const message = data.message;
        const callId = String(message?.toolCallId ?? '');
        const record = state.turn.toolCalls.find((tc) => tc.toolCallId === callId);
        if (!record) break;
        const failed = Boolean(message?.isError);
        const resultText = this.flattenContent(message?.content);
        record.status = failed ? 'failed' : 'completed';
        record.result = resultText;
        if (failed) record.error = resultText;
        record.completedAt = new Date().toISOString();
        const started = state.startedAtByCall.get(callId);
        record.durationMs = started ? Date.now() - started : undefined;
        state.startedAtByCall.delete(callId);
        this.emit(
          state,
          failed ? 'tool_call_failed' : 'tool_call_completed',
          record as unknown as Record<string, unknown>
        );
        void this.captureAfterEdit(state, record);
        break;
      }
      case 'turn/end': {
        const reason = data.reason as
          | { kind?: string; error?: { message?: string }; message?: string }
          | undefined;
        if (reason?.kind && reason.kind !== 'completed') {
          state.lastTurnError =
            reason.error?.message || reason.message || `本轮未完成（${reason.kind}）`;
        }
        break;
      }
      default:
        break;
    }
  }

  private flattenContent(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .map((block: any) => (block?.type === 'text' ? String(block.text ?? '') : ''))
      .filter(Boolean)
      .join('\n');
  }

  private async captureBeforeEdit(
    state: SessionState,
    callId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<void> {
    if (!EDIT_TOOL_NAMES.has(toolName)) return;
    const rawPath = String(args.path ?? args.file_path ?? args.filePath ?? '');
    if (!rawPath) return;
    const abs = path.isAbsolute(rawPath) ? rawPath : path.resolve(state.manifest.workspaceRoot, rawPath);
    let before = '';
    let operation: 'create' | 'modify' = 'create';
    try {
      before = await fs.readFile(abs, 'utf8');
      operation = 'modify';
    } catch {
      operation = 'create';
    }
    state.pendingDiffByCall.set(callId, {
      filePath: path.relative(state.manifest.workspaceRoot, abs).replace(/\\/g, '/'),
      before,
      operation,
    });
  }

  private async captureAfterEdit(state: SessionState, record: ToolCallRecord): Promise<void> {
    const pending = state.pendingDiffByCall.get(record.toolCallId);
    if (!pending) return;
    state.pendingDiffByCall.delete(record.toolCallId);
    if (record.status === 'failed') return;

    const abs = path.resolve(state.manifest.workspaceRoot, pending.filePath);
    let after = '';
    try {
      after = await fs.readFile(abs, 'utf8');
    } catch {
      return;
    }
    if (after === pending.before) return;

    const now = new Date().toISOString();
    const diff: DiffChangeRecord = {
      diffId: `diff_${crypto.randomUUID()}`,
      sessionId: state.manifest.sessionId,
      filePath: pending.filePath,
      operation: pending.operation,
      originalContent: pending.before,
      proposedContent: after,
      unifiedDiff: createUnifiedDiff(pending.filePath, pending.before, after),
      status: 'pending',
      appliedToDisk: true,
      createdAt: now,
      updatedAt: now,
    };
    state.diffs.push(diff);
    await this.store.writeDiffs(state.manifest.sessionId, state.diffs);
    this.emit(state, 'diff_proposed', diff as unknown as Record<string, unknown>);
  }

  private async finishTurn(state: SessionState, failed = false): Promise<void> {
    this.activeTurns.delete(this.clientKey(state));
    const { text, thinking, toolCalls, timeline } = state.turn;
    const producedContent = Boolean(text || thinking || toolCalls.length > 0);
    let failureMessage = state.lastTurnError;
    state.lastTurnError = undefined;

    if (producedContent) {
      const message: SessionMessage = {
        id: `msg_${crypto.randomUUID()}`,
        sessionId: state.manifest.sessionId,
        role: 'assistant',
        content: text,
        sequence: state.messages.length + 1,
        timestamp: new Date().toISOString(),
        thinking: thinking || undefined,
        timeline: timeline.length > 0 ? timeline : undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      };
      state.messages.push(message);
      state.manifest.lastSequence = Math.max(state.manifest.lastSequence, message.sequence);
    } else if (!failed) {
      // A turn that completes without any model output is almost always a
      // provider failure (bad key, model id, unsupported streaming) that the
      // kernel swallowed after its retries. Surface it instead of staying silent.
      failed = true;
      failureMessage =
        failureMessage ||
        '模型没有返回任何内容（内核已重试多次）。常见原因：API Key 无效或过期、模型名不存在、网关不支持流式响应。' +
          '请在「设置 → 测试连通性」验证，或查看网关日志。';
    }
    state.turn = this.emptyTurn();
    state.streamedThisTurn = false;
    state.startedAtByCall.clear();
    state.pendingDiffByCall.clear();

    state.manifest.status = failed ? 'error' : 'completed';
    state.manifest.updatedAt = new Date().toISOString();
    await this.persist(state);

    if (failed) {
      if (failureMessage) this.emit(state, 'error', { message: failureMessage });
      this.emit(state, 'session_state', { status: 'error' });
    } else {
      this.emit(state, 'text_done', {});
      this.emit(state, 'session_state', { status: 'completed' });
      // Keep the manifest status idle for the UI session list.
      state.manifest.status = 'idle';
      await this.store.writeManifest(state.manifest);
    }
  }

  private emptyTurn(): TurnBuffer {
    return { text: '', thinking: '', toolCalls: [], timeline: [] };
  }

  private emit(state: SessionState, type: ClineRuntimeEvent['type'], payload: Record<string, unknown>): void {
    const event: ClineRuntimeEvent = {
      type,
      sessionId: state.manifest.sessionId,
      payload,
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // isolate listener failures
      }
    }
  }

  private emitError(state: SessionState, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.emit(state, 'error', { message });
  }

  private async persist(state: SessionState): Promise<void> {
    await this.store.writeManifest(state.manifest).catch(() => {});
    await this.store.writeMessages(state.manifest.sessionId, state.messages).catch(() => {});
  }

  private requireState(sessionId: string): SessionState {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error(`Unknown DSH session: ${sessionId}`);
    return state;
  }

  private async requireStateLazy(sessionId: string): Promise<SessionState | null> {
    const live = this.sessions.get(sessionId);
    if (live) return live;
    const record = await this.store.readRecord(sessionId);
    if (!record) return null;
    const state: SessionState = {
      manifest: record.manifest,
      messages: record.messages,
      diffs: record.diffs,
      busy: false,
      queue: [],
      turn: this.emptyTurn(),
      pendingDiffByCall: new Map(),
      startedAtByCall: new Map(),
      dshSessionReady: false,
    };
    this.sessions.set(sessionId, state);
    return state;
  }
}
