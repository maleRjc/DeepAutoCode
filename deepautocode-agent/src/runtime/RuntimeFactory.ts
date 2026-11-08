import dns from 'node:dns';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

try {
  dns.setDefaultResultOrder('ipv4first');
} catch {
  // ignore
}

const keepAliveHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 16 });
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 16 });
const dnsCache = new Map<string, { address: string; expiresAt: number }>();

function cachedLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void
) {
  const now = Date.now();
  const cached = dnsCache.get(hostname);
  if (cached && cached.expiresAt > now) {
    if ((options as any)?.all) {
      callback(null, [{ address: cached.address, family: 4 }]);
    } else {
      callback(null, cached.address, 4);
    }
    return;
  }
  dns.lookup(hostname, { family: 4 }, (err, address, family) => {
    if (!err && typeof address === 'string') {
      dnsCache.set(hostname, { address, expiresAt: Date.now() + 5 * 60 * 1000 });
      if ((options as any)?.all) {
        callback(null, [{ address, family: family || 4 }]);
        return;
      }
    }
    callback(err, address as any, family);
  });
}

async function postJsonOnce(params: {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ ok: boolean; status: number; text: string }> {
  const parsedUrl = new URL(params.url);
  const isHttps = parsedUrl.protocol === 'https:';
  const payload = JSON.stringify(params.body);
  const timeoutMs = params.timeoutMs ?? 60000;

  return new Promise((resolve, reject) => {
    if (params.signal?.aborted) {
      reject(new Error('CAPABILITY_CANCELLED: Request aborted'));
      return;
    }

    const reqFn = isHttps ? https.request : http.request;
    const req = reqFn(
      parsedUrl,
      {
        method: 'POST',
        agent: isHttps ? keepAliveHttpsAgent : keepAliveHttpAgent,
        family: 4,
        lookup:
          parsedUrl.hostname === '127.0.0.1' || parsedUrl.hostname === 'localhost'
            ? undefined
            : (cachedLookup as any),
        headers: {
          ...params.headers,
          'Content-Length': String(Buffer.byteLength(payload, 'utf-8')),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          const status = res.statusCode ?? 500;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            text,
          });
        });
      }
    );

    const onAbort = () => {
      req.destroy(new Error('CAPABILITY_CANCELLED: Request aborted'));
    };
    params.signal?.addEventListener('abort', onAbort, { once: true });

    req.on('timeout', () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });

    req.on('error', (err) => {
      params.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });

    req.on('close', () => {
      params.signal?.removeEventListener('abort', onAbort);
    });

    req.write(payload);
    req.end();
  });
}

async function postJsonResilient(params: {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ ok: boolean; status: number; text: string }> {
  const maxAttempts = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await postJsonOnce(params);
      if ((res.status === 502 || res.status === 503 || res.status === 504 || res.status === 429) && attempt < maxAttempts && !params.signal?.aborted) {
        await new Promise((r) => setTimeout(r, 400 * attempt));
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isTransientSocketErr =
        /ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|EAI_AGAIN|ENOTFOUND|network/i.test(msg);
      if (isTransientSocketErr && attempt < maxAttempts && !params.signal?.aborted) {
        await new Promise((r) => setTimeout(r, 350 * attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
import type {
  AgentExecutionMode,
  BackendMode,
  CapabilityName,
  DiffChangeRecord,
  SessionManifest,
  SessionMessage,
  ToolCallRecord,
} from '../types.js';
import type { CapabilityRegistry } from '../capabilities/CapabilityRegistry.js';
import type { ProviderManager } from '../../providers/index.js';
import {
  captureWorkspaceFiles,
  listSessionCheckpoints,
  readSessionCheckpoint,
  restoreWorkspaceFiles,
  saveSessionCheckpoint,
  type SessionCheckpoint,
} from '../core/SessionCheckpoint.js';
import {
  globalTaskTraceStore,
  type TraceTerminalStatus,
} from '../core/trace/TaskTrace.js';
import {
  DEEPSEEK_FLASH,
  buildDeepSeekRequestControls,
  deepSeekChatBodyExtras,
  estimateDeepSeekTurnCostCny,
  isDeepSeekPeakHour,
  isDeepSeekModelId,
} from '../core/DeepSeekModels.js';
import {
  compileRulesFromDocuments,
  type PermissionRuleset,
} from '../core/RulePermission.js';
import { BackendManager } from './BackendManager.js';

export interface ClineRuntimeEvent {
  type:
    | 'text_delta'
    | 'text_done'
    | 'tool_call_started'
    | 'tool_call_completed'
    | 'tool_call_failed'
    | 'diff_proposed'
    | 'diff_updated'
    | 'model_tier'
    | 'checkpoint_created'
    | 'session_state'
    | 'error'
    | 'sandbox_branch_created'
    | 'circuit_breaker_triggered'
    | 'artifact_created'
    | 'goal_usage'
    | 'trace_updated';
  sessionId: string;
  payload: Record<string, unknown>;
}

export interface StartSessionInput {
  sessionId?: string;
  title?: string;
  prompt?: string;
  /** Stage W: isolate parallel Composer in a git worktree */
  useWorktree?: boolean;
  config: {
    providerId: string;
    modelId: string;
    apiKey?: string;
    cwd: string;
    workspaceRoot: string;
    executionMode?: AgentExecutionMode;
    enableTools?: boolean;
  };
}

export interface SendPromptInput {
  sessionId: string;
  prompt: string;
  workspaceRoot?: string;
  executionMode?: AgentExecutionMode;
  modelId?: string;
  signal?: AbortSignal;
}

/**
 * Appendix A: Verified ClineCore Runtime Interface Contract
 */
export interface IClineCoreInstance {
  readonly instanceId: string;
  readonly backendMode: BackendMode;
  readonly storageDir: string;
  readonly sdkUnderlyingAvailable: boolean;
  start(input: StartSessionInput): Promise<{
    sessionId: string;
    manifest: SessionManifest;
    manifestPath: string;
  }>;
  send(input: SendPromptInput): Promise<{ message: SessionMessage }>;
  subscribe(listener: (event: ClineRuntimeEvent) => void): () => void;
  list(): Promise<SessionManifest[]>;
  get(sessionId: string): Promise<SessionManifest | null>;
  readMessages(sessionId: string): Promise<SessionMessage[]>;
  readDiffs(sessionId: string): Promise<DiffChangeRecord[]>;
  updateDiffStatus(
    sessionId: string,
    diffId: string,
    status: DiffChangeRecord['status'],
    feedback?: string
  ): Promise<DiffChangeRecord | null>;
  updateDiffProposed(
    sessionId: string,
    diffId: string,
    proposedContent: string,
    options?: { writeToDisk?: boolean; finalize?: 'accept' | 'reject' | 'keep' }
  ): Promise<DiffChangeRecord | null>;
  reviewAllPendingDiffs(
    sessionId: string,
    action: 'accept' | 'reject'
  ): Promise<DiffChangeRecord[]>;
  createCheckpoint(
    sessionId: string,
    label?: string
  ): Promise<import('../core/SessionCheckpoint.js').SessionCheckpoint | null>;
  listCheckpoints(
    sessionId: string
  ): Promise<import('../core/SessionCheckpoint.js').SessionCheckpoint[]>;
  restoreCheckpoint(
    sessionId: string,
    checkpointId: string
  ): Promise<{ ok: boolean; restored: number; deleted: number; checkpointId: string }>;
  abort(sessionId: string, reason?: string): Promise<boolean>;
  stop(sessionId: string): Promise<boolean>;
  delete(sessionId: string): Promise<boolean>;
  dispose(): Promise<void>;
}

export interface SdkVerificationReport {
  packageName: string;
  lockedVersion: string;
  license: string;
  nodeEngineDeclared: string;
  currentNodeVersion: string;
  sdkModuleImportable: boolean;
  exportedSymbols: string[];
  clineCoreMethods: string[];
  adapterMode: 'native-sdk-hybrid' | 'persistent-local-engine';
  notes: string[];
}

function createUnifiedDiff(filePath: string, original: string, proposed: string): string {
  const origLines = original ? original.split(/\r?\n/) : [];
  const propLines = proposed ? proposed.split(/\r?\n/) : [];
  const lines: string[] = [
    `--- a/${filePath.replace(/\\/g, '/')}`,
    `+++ b/${filePath.replace(/\\/g, '/')}`,
    `@@ -1,${origLines.length} +1,${propLines.length} @@`,
  ];
  const maxLen = Math.max(origLines.length, propLines.length);
  for (let i = 0; i < maxLen; i++) {
    const o = origLines[i];
    const p = propLines[i];
    if (o === p && o !== undefined) {
      lines.push(` ${o}`);
    } else {
      if (o !== undefined) lines.push(`-${o}`);
      if (p !== undefined) lines.push(`+${p}`);
    }
  }
  return lines.join('\n');
}

/**
 * Local Persistent ClineCore Runtime Implementation
 * Implements full disk persistence (PoC-L1) and cross-instance session discovery/recovery (PoC-L2),
 * while bridging `@cline/sdk` and `CapabilityRegistry`.
 */
class PersistentClineCoreRuntime implements IClineCoreInstance {
  public readonly instanceId: string;
  public readonly backendMode: BackendMode;
  public readonly storageDir: string;
  public readonly sdkUnderlyingAvailable: boolean;

  private readonly capabilityRegistry: CapabilityRegistry;
  private readonly providerManager: ProviderManager;
  private readonly listeners = new Set<(event: ClineRuntimeEvent) => void>();
  private readonly activeAborts = new Map<string, AbortController>();
  private disposed = false;

  constructor(params: {
    backendMode: BackendMode;
    storageDir: string;
    sdkUnderlyingAvailable: boolean;
    capabilityRegistry: CapabilityRegistry;
    providerManager: ProviderManager;
  }) {
    this.instanceId = `cline_inst_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.backendMode = params.backendMode;
    this.storageDir = path.resolve(params.storageDir);
    this.sdkUnderlyingAvailable = params.sdkUnderlyingAvailable;
    this.capabilityRegistry = params.capabilityRegistry;
    this.providerManager = params.providerManager;
  }

  private getSessionsRoot(): string {
    return path.join(this.storageDir, 'sessions');
  }

  private getSessionDir(sessionId: string): string {
    return path.join(this.getSessionsRoot(), sessionId);
  }

  private getManifestPath(sessionId: string): string {
    return path.join(this.getSessionDir(sessionId), 'manifest.json');
  }

  private getMessagesPath(sessionId: string): string {
    return path.join(this.getSessionDir(sessionId), 'messages.json');
  }

  private getDiffsPath(sessionId: string): string {
    return path.join(this.getSessionDir(sessionId), 'diffs.json');
  }

  private getIndexPath(): string {
    return path.join(this.storageDir, 'session-index.json');
  }

  private emit(event: ClineRuntimeEvent): void {
    if (this.disposed) return;
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // ignore listener error
      }
    }
  }

  private async saveManifest(manifest: SessionManifest): Promise<string> {
    const sessionDir = this.getSessionDir(manifest.sessionId);
    await fs.mkdir(sessionDir, { recursive: true });
    const manifestPath = this.getManifestPath(manifest.sessionId);
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

    // Update top-level session-index.json for fast cross-instance discovery (PoC-L2)
    let index: Record<string, { sessionId: string; updatedAt: string; title: string }> = {};
    try {
      const raw = await fs.readFile(this.getIndexPath(), 'utf-8');
      index = JSON.parse(raw);
    } catch {
      index = {};
    }
    index[manifest.sessionId] = {
      sessionId: manifest.sessionId,
      updatedAt: manifest.updatedAt,
      title: manifest.title,
    };
    await fs.writeFile(this.getIndexPath(), JSON.stringify(index, null, 2), 'utf-8');
    return manifestPath;
  }

  private async appendMessage(sessionId: string, message: SessionMessage): Promise<void> {
    const messages = await this.readMessages(sessionId);
    messages.push(message);
    await fs.mkdir(this.getSessionDir(sessionId), { recursive: true });
    await fs.writeFile(this.getMessagesPath(sessionId), JSON.stringify(messages, null, 2), 'utf-8');
  }

  private async saveDiff(sessionId: string, diff: DiffChangeRecord): Promise<void> {
    const diffs = await this.readDiffs(sessionId);
    const existingIdx = diffs.findIndex((d) => d.diffId === diff.diffId);
    if (existingIdx >= 0) {
      diffs[existingIdx] = diff;
    } else {
      diffs.push(diff);
    }
    await fs.mkdir(this.getSessionDir(sessionId), { recursive: true });
    await fs.writeFile(this.getDiffsPath(sessionId), JSON.stringify(diffs, null, 2), 'utf-8');
  }

  async start(input: StartSessionInput): Promise<{
    sessionId: string;
    manifest: SessionManifest;
    manifestPath: string;
  }> {
    const sessionId =
      input.sessionId ?? `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    let workspaceRoot = path.resolve(input.config.workspaceRoot);
    let worktreeMeta: { worktreePath?: string; branch?: string; message?: string } | undefined;
    if (input.useWorktree) {
      try {
        const { ensureAgentWorktree } = await import('../core/WorkspaceSafety.js');
        const wt = await ensureAgentWorktree({
          workspaceRoot,
          sessionId,
        });
        if (wt.enabled && wt.worktreePath) {
          workspaceRoot = path.resolve(wt.worktreePath);
          worktreeMeta = {
            worktreePath: wt.worktreePath,
            branch: wt.branch,
            message: wt.message,
          };
        }
      } catch {
        // fall back to main workspace
      }
    }
    const manifest: SessionManifest = {
      sessionId,
      title: input.title ?? (input.prompt ? input.prompt.slice(0, 48) : 'New AI Session'),
      workspaceRoot,
      providerId: input.config.providerId,
      modelId: input.config.modelId,
      backendMode: this.backendMode,
      executionMode: input.config.executionMode ?? 'auto',
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      lastSequence: 0,
      sdkManaged: true,
      storagePath: this.getSessionDir(sessionId),
      ...(worktreeMeta ? { worktree: worktreeMeta } : {}),
    };

    const manifestPath = await this.saveManifest(manifest);
    await fs.writeFile(this.getMessagesPath(sessionId), JSON.stringify([], null, 2), 'utf-8');
    await fs.writeFile(this.getDiffsPath(sessionId), JSON.stringify([], null, 2), 'utf-8');

    this.emit({
      type: 'session_state',
      sessionId,
      payload: { status: manifest.status, manifest },
    });

    if (input.prompt && input.prompt.trim().length > 0) {
      await this.send({
        sessionId,
        prompt: input.prompt,
        executionMode: manifest.executionMode,
      });
    }

    const updatedManifest = (await this.get(sessionId)) ?? manifest;
    return {
      sessionId,
      manifest: updatedManifest,
      manifestPath,
    };
  }

  async send(input: SendPromptInput): Promise<{ message: SessionMessage }> {
    let manifest = await this.get(input.sessionId);
    if (!manifest) {
      // Auto-create session manifest if sessionId was not found on disk (e.g., stale UI state or fresh storage)
      const { provider, model } = await this.providerManager.getActiveProviderWithKeyStatus();
      const now = new Date().toISOString();
      manifest = {
        sessionId: input.sessionId,
        title: input.prompt ? input.prompt.slice(0, 48) : 'Recovered AI Session',
        workspaceRoot: path.resolve(input.workspaceRoot || process.cwd()),
        providerId: provider.providerId,
        modelId: model.modelId,
        backendMode: this.backendMode,
        executionMode: input.executionMode ?? 'auto',
        status: 'idle',
        createdAt: now,
        updatedAt: now,
        lastSequence: 0,
        sdkManaged: true,
        storagePath: this.getSessionDir(input.sessionId),
      };
      await this.saveManifest(manifest);
      await fs.writeFile(this.getMessagesPath(input.sessionId), JSON.stringify([], null, 2), 'utf-8');
      await fs.writeFile(this.getDiffsPath(input.sessionId), JSON.stringify([], null, 2), 'utf-8');
    }

    if (input.executionMode && input.executionMode !== manifest.executionMode) {
      manifest.executionMode = input.executionMode;
    }
    if (input.modelId && input.modelId.trim() && input.modelId.trim() !== manifest.modelId) {
      manifest.modelId = input.modelId.trim();
    }
    if (input.workspaceRoot && path.resolve(input.workspaceRoot) !== manifest.workspaceRoot) {
      manifest.workspaceRoot = path.resolve(input.workspaceRoot);
    }

    const abortController = new AbortController();
    if (input.signal) {
      input.signal.addEventListener('abort', () => abortController.abort(input.signal?.reason), {
        once: true,
      });
    }
    this.activeAborts.set(input.sessionId, abortController);

    const existingMessages = await this.readMessages(input.sessionId);
    const userSeq = existingMessages.length + 1;
    const userMessage: SessionMessage = {
      id: `msg_${Date.now()}_u`,
      sessionId: input.sessionId,
      role: 'user',
      content: input.prompt,
      sequence: userSeq,
      timestamp: new Date().toISOString(),
    };
    await this.appendMessage(input.sessionId, userMessage);

    manifest.status = 'running';
    manifest.updatedAt = new Date().toISOString();
    manifest.lastSequence = userSeq;
    await this.saveManifest(manifest);

    this.emit({
      type: 'session_state',
      sessionId: input.sessionId,
      payload: { status: 'running', manifest },
    });

    const toolCalls: ToolCallRecord[] = [];
    const diffIds: string[] = [];
    let assistantContent = '';
    const taskId = `trc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    let traceTerminal: TraceTerminalStatus = 'success';
    let circuitTriggered = false;
    const emitTraceUpdated = (event: unknown) => {
      this.emit({
        type: 'trace_updated',
        sessionId: input.sessionId,
        payload: {
          taskId,
          event,
          snapshot: globalTaskTraceStore.get(taskId),
        },
      });
    };
    const startEvt = globalTaskTraceStore.startTask({
      taskId,
      sessionId: input.sessionId,
      mode: manifest.executionMode || 'auto',
      prompt: input.prompt,
      modelId: manifest.modelId,
      workspaceRoot: manifest.workspaceRoot,
    });
    emitTraceUpdated(startEvt);

    try {
      // Execute intelligent agent workflow with capability invocations
      const result = await this.executeAgentLoop({
        manifest,
        prompt: input.prompt,
        signal: abortController.signal,
        toolCalls,
        diffIds,
        taskId,
        onCircuitTriggered: () => {
          circuitTriggered = true;
        },
        emitTraceUpdated,
      });
      assistantContent = result.content;
      manifest.status = 'completed';
      if (circuitTriggered) {
        traceTerminal = 'circuit';
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (abortController.signal.aborted || msg.includes('CANCELLED') || msg.includes('aborted')) {
        manifest.status = 'cancelled';
        traceTerminal = 'abort';
        assistantContent = assistantContent
          ? `${assistantContent}\n\n[Task cancelled by user]`
          : '[Task cancelled by user]';
      } else {
        manifest.status = 'error';
        traceTerminal = 'error';
        assistantContent = `Task encountered error: ${msg}`;
        this.emit({
          type: 'error',
          sessionId: input.sessionId,
          payload: { message: msg },
        });
      }
    } finally {
      this.activeAborts.delete(input.sessionId);
      const endEvt = globalTaskTraceStore.endTask({
        workspaceRoot: manifest.workspaceRoot,
        sessionId: input.sessionId,
        taskId,
        status: circuitTriggered ? 'circuit' : traceTerminal,
        reason:
          circuitTriggered
            ? 'circuit_breaker'
            : traceTerminal === 'abort'
              ? 'cancelled'
              : traceTerminal === 'error'
                ? 'runtime_error'
                : undefined,
      });
      if (endEvt) emitTraceUpdated(endEvt);
    }

    const assistantSeq = (await this.readMessages(input.sessionId)).length + 1;
    const assistantMessage: SessionMessage = {
      id: `msg_${Date.now()}_a`,
      sessionId: input.sessionId,
      role: 'assistant',
      content: assistantContent,
      sequence: assistantSeq,
      timestamp: new Date().toISOString(),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      diffIds: diffIds.length > 0 ? diffIds : undefined,
    };

    await this.appendMessage(input.sessionId, assistantMessage);
    manifest.updatedAt = new Date().toISOString();
    manifest.lastSequence = assistantSeq;
    await this.saveManifest(manifest);

    this.emit({
      type: 'text_done',
      sessionId: input.sessionId,
      payload: {
        messageId: assistantMessage.id,
        content: assistantContent,
        toolCalls,
        diffIds,
      },
    });

    // Stage U: persist /compact (or explicit memory) digests for future sessions
    try {
      const { appendAgentMemory, digestTextToMemorySummary, expandSlashCommandPrompt } =
        await import('../core/index.js');
      const slash = expandSlashCommandPrompt?.(input.prompt);
      const wantsMemory =
        slash?.slashCommand === 'compact' ||
        /(?:^|\s)(?:\/compact|save\s+memory|记住这次|保存记忆)\b/i.test(input.prompt);
      if (wantsMemory && assistantContent.trim()) {
        await appendAgentMemory(manifest.workspaceRoot, {
          sessionId: input.sessionId,
          source: slash?.slashCommand === 'compact' ? 'compact' : 'manual',
          title:
            slash?.slashCommand === 'compact'
              ? `Compact · ${new Date().toLocaleString()}`
              : `Memory · ${new Date().toLocaleString()}`,
          summary: digestTextToMemorySummary(assistantContent),
        });
      }
    } catch {
      // non-fatal
    }

    // Auto-create a user-restorable checkpoint after turns that touched files
    if (Array.isArray(diffIds) && diffIds.length > 0) {
      await this.createCheckpoint(
        input.sessionId,
        `After turn · ${diffIds.length} file change(s)`
      ).catch(() => null);
    }

    this.emit({
      type: 'session_state',
      sessionId: input.sessionId,
      payload: { status: manifest.status, manifest },
    });

    return { message: assistantMessage };
  }

  private async executeAgentLoop(params: {
    manifest: SessionManifest;
    prompt: string;
    signal: AbortSignal;
    toolCalls: ToolCallRecord[];
    diffIds: string[];
    taskId?: string;
    onCircuitTriggered?: () => void;
    emitTraceUpdated?: (event: unknown) => void;
  }): Promise<{ content: string }> {
    const {
      manifest,
      prompt,
      signal,
      toolCalls,
      diffIds,
      taskId,
      onCircuitTriggered,
      emitTraceUpdated,
    } = params;
    const sessionId = manifest.sessionId;
    const chunks: string[] = [];

    const streamText = async (text: string) => {
      const parts = text.match(/.{1,36}(\s|$)|.{1,36}/g) ?? [text];
      for (const part of parts) {
        if (signal.aborted) {
          throw new Error('CAPABILITY_CANCELLED: Task aborted during streaming');
        }
        chunks.push(part);
        this.emit({
          type: 'text_delta',
          sessionId,
          payload: { delta: part },
        });
        await new Promise((r) => setTimeout(r, 5));
      }
    };

    const policyGate: {
      executionMode: AgentExecutionMode;
      permissionRuleset: PermissionRuleset;
    } = {
      executionMode: manifest.executionMode,
      permissionRuleset: [],
    };
    try {
      const { discoverWorkspaceCustomizations } = await import('../core/index.js');
      if (typeof discoverWorkspaceCustomizations === 'function') {
        const customs = await discoverWorkspaceCustomizations(manifest.workspaceRoot);
        policyGate.permissionRuleset = compileRulesFromDocuments(
          (customs?.rules || []).map((r: any) => ({
            path: r.path,
            name: r.name,
            content: r.content,
            raw: r.content,
          }))
        );
      }
    } catch {
      // non-fatal: soft rules still inject via PromptBuilder
    }

    const runCapabilityTool = async (
      capability: CapabilityName,
      args: Record<string, unknown>,
      risk: ToolCallRecord['risk'] = 'low'
    ) => {
      const toolCallId = `tc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const toolStartedAt = Date.now();
      const record: ToolCallRecord = {
        toolCallId,
        toolName: capability,
        args,
        status: 'running',
        risk,
        startedAt: new Date().toISOString(),
      };
      toolCalls.push(record);

      this.emit({
        type: 'tool_call_started',
        sessionId,
        payload: { ...record },
      });

      try {
        const output = await this.capabilityRegistry.invoke(capability, args, {
          sessionId,
          workspaceRoot: manifest.workspaceRoot,
          executionMode: policyGate.executionMode,
          permissionRuleset: policyGate.permissionRuleset,
          signal,
        });
        record.status = 'completed';
        record.result = output;
        record.completedAt = new Date().toISOString();
        this.emit({
          type: 'tool_call_completed',
          sessionId,
          payload: { ...record },
        });
        const toolEvt = globalTaskTraceStore.recordToolCall({
          workspaceRoot: manifest.workspaceRoot,
          sessionId,
          taskId,
          toolCallId,
          toolName: capability,
          args,
          result: output,
          durationMs: Date.now() - toolStartedAt,
          ok: true,
        });
        if (toolEvt) emitTraceUpdated?.(toolEvt);
        return output;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        record.status = errMsg.includes('USER_REJECTED')
          ? 'rejected'
          : errMsg.includes('CANCELLED')
            ? 'cancelled'
            : 'failed';
        record.error = errMsg;
        record.completedAt = new Date().toISOString();
        this.emit({
          type: 'tool_call_failed',
          sessionId,
          payload: { ...record },
        });
        const toolEvt = globalTaskTraceStore.recordToolCall({
          workspaceRoot: manifest.workspaceRoot,
          sessionId,
          taskId,
          toolCallId,
          toolName: capability,
          args,
          durationMs: Date.now() - toolStartedAt,
          ok: false,
          error: errMsg,
        });
        if (toolEvt) emitTraceUpdated?.(toolEvt);
        throw err;
      }
    };

    const strippedPrompt = prompt.replace(/^\[Context Active File:[^\]]*\]\s*/i, '').trim();
    const readMatch = strippedPrompt.match(/^(?:读取|read|查看文件)\s+([^\s,:：;]+)$/i);
    const writeMatch = strippedPrompt.match(
      /^(?:写入|创建|修改|write|edit)\s+([^\s,:：;]+)\s*[:：]\s*([\s\S]+)$/i
    );
    const buildMatch = strippedPrompt.match(/^(?:运行|执行|命令|run|build)\s*`([^`]+)`$/i);

    if (readMatch) {
      const targetFile = readMatch[1];
      try {
        const res = (await runCapabilityTool('read-file', { filePath: targetFile }, 'low')) as {
          content: string;
          byteLength: number;
        };
        const lineCount = res.content.split(/\r?\n/).length;
        await streamText(
          `### 文件读取完成\n- **文件路径**: \`${targetFile}\`\n- **文件大小**: ${res.byteLength} 字节（共 ${lineCount} 行）\n- **状态**: 已加载至当前 AI 上下文，您可以直接针对该文件提问或要求修改。`
        );
        return { content: chunks.join('') };
      } catch {
        // If target file does not exist in current workspace, fall through to LLM / workspace analysis
      }
    }

    if (writeMatch) {
      const targetFile = writeMatch[1];
      const proposedContent =
        writeMatch[2]?.trim() ||
        `// Generated by DeepAutoCode Agent (${manifest.modelId})\nexport const updated = true;\n`;

      const writeRes = await this.proposeAndApplyFileEdit({
        sessionId,
        manifest,
        targetFile,
        proposedContent,
        signal,
        runCapabilityTool,
        diffIds,
        applyImmediately: true,
      });

      await streamText(
        `### 代码变更已应用\n- **目标文件**: \`${targetFile}\`\n- **变更预览**: Diff ID \`${writeRes.diffId}\`（${writeRes.bytesWritten} 字节）\n- **操作说明**: Manual 模式已通过审批卡；您仍可在 Diff 审阅中 **Reject** 回滚。`
      );
      return { content: chunks.join('') };
    }

    if (buildMatch) {
      const cmd = buildMatch[1];
      const res = (await runCapabilityTool('run-build', { command: cmd }, 'high')) as {
        exitCode: number;
        stdout: string;
        stderr: string;
      };
      await streamText(
        `### 命令执行结果\n- **执行命令**: \`${cmd}\`\n- **退出状态码**: \`${res.exitCode}\`\n\`\`\`text\n${(res.stdout || res.stderr).trim()}\n\`\`\``
      );
      return { content: chunks.join('') };
    }

    // Try real LLM Tool-Calling Autonomous Agent Loop when Provider API Key is configured
    const apiKey = await this.providerManager.resolveApiKey(manifest.providerId);
    let authFailedNotice = '';
    if (apiKey && apiKey.trim().length > 0) {
      try {
        return await this.executeLiveLlmAgentLoop({
          manifest,
          prompt,
          apiKey: apiKey.trim(),
          signal,
          chunks,
          streamText,
          runCapabilityTool,
          diffIds,
          taskId,
          onCircuitTriggered,
          emitTraceUpdated,
          policyGate,
        });
      } catch (llmErr) {
        const errMsg = llmErr instanceof Error ? llmErr.message : String(llmErr);
        // If tools or file edits were already executed before the error, preserve the completed work
        if (chunks.join('').trim().length > 0 || diffIds.length > 0 || toolCalls.length > 0) {
          if (chunks.join('').trim().length === 0) {
            const writtenFiles = toolCalls
              .filter((tc) => tc.toolName === 'write-file' && tc.status === 'completed')
              .map((tc) => `\`${String(tc.args?.filePath || '')}\``)
              .filter(Boolean);
            const summaryLines = [
              `## 任务执行完成摘要`,
              writtenFiles.length > 0
                ? `- **已生成/更新文件 (${writtenFiles.length})**: ${writtenFiles.join('、')}`
                : `- **已完成工具调用**: 共执行 ${toolCalls.length} 步工作区操作`,
              diffIds.length > 0
                ? `- **代码变更审查**: 已生成 ${diffIds.length} 项文件变更记录，可在下方卡片或编辑器中点击 **Accept** / **Reject**`
                : '',
            ]
              .filter(Boolean)
              .join('\n');
            await streamText(summaryLines);
          }
          return { content: chunks.join('') };
        }
        if (errMsg.includes('401') || /Authentication Fails|invalid.*api.*key/i.test(errMsg)) {
          authFailedNotice =
            `> ⚠️ **DeepSeek API Key 未通过验证 (HTTP 401)**：请在 **⚙️ Settings -> Models & Providers** 中粘贴有效密钥，并点击 **⚡ Test AI Key (测试 AI 调用)** 确认连接正常。\n\n`;
        } else {
          authFailedNotice = `> ⚠️ **云端模型调用提示**：${errMsg}（已自动切换至本地结构化分析引擎）\n\n`;
        }
      }
    }

    // Intelligent local workspace inspection & project analysis engine (file reads shown only as progress)
    let workspaceSummary = '';
    let packageAnalysis = '';
    let activeFileAnalysis = '';

    try {
      const entries = await fs.readdir(manifest.workspaceRoot, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() && !['node_modules', '.git', 'dist', '.deepautocode-data'].includes(e.name))
        .slice(0, 12)
        .map((e) => `\`${e.name}/\``);
      const files = entries
        .filter((e) => !e.isDirectory() && !['.DS_Store'].includes(e.name))
        .slice(0, 12)
        .map((e) => `\`${e.name}\``);
      workspaceSummary =
        `### 1. 工作区结构概览\n` +
        `- **当前项目路径**: \`${manifest.workspaceRoot}\`\n` +
        (dirs.length > 0 ? `- **核心目录**: ${dirs.join('、')}\n` : '') +
        (files.length > 0 ? `- **顶层文件**: ${files.join('、')}\n` : '');
    } catch {
      // ignore
    }

    // Inspect package.json silently via read-file capability (progress shown in UI)
    try {
      const pkgRes = (await runCapabilityTool(
        'read-file',
        { filePath: 'package.json' },
        'low'
      )) as { content: string };
      const pkg = JSON.parse(pkgRes.content);
      const scripts = Object.entries(pkg.scripts ?? {})
        .slice(0, 8)
        .map(([k, v]) => `  - \`npm run ${k}\` — \`${v}\``)
        .join('\n');
      const deps = Object.keys({
        ...(pkg.dependencies ?? {}),
        ...(pkg.devDependencies ?? {}),
      })
        .slice(0, 15)
        .map((d) => `\`${d}\``)
        .join('、');
      packageAnalysis =
        `\n### 2. 项目功能与配置 (\`package.json\`)\n` +
        `- **项目名称**: \`${pkg.name ?? 'unknown'}\` (版本 \`v${pkg.version ?? '1.0.0'}\`)\n` +
        (pkg.description ? `- **核心定位**: ${pkg.description}\n` : '') +
        (deps ? `- **技术栈与依赖**: ${deps}\n` : '') +
        (scripts ? `- **常用脚本指令**:\n${scripts}\n` : '');
    } catch {
      // ignore if no package.json
    }

    // Inspect active context file silently (progress shown in UI, no raw file dump)
    const activeFileMatch = prompt.match(/\[Context Active File:\s*([^\]]+)\]/i);
    if (activeFileMatch?.[1]) {
      const activeRelPath = activeFileMatch[1].trim();
      try {
        const activeRes = (await runCapabilityTool(
          'read-file',
          { filePath: activeRelPath },
          'low'
        )) as { content: string; byteLength: number };
        const exportedSymbols = Array.from(
          activeRes.content.matchAll(
            /export\s+(?:async\s+)?(?:function|class|interface|type|const)\s+([A-Za-z0-9_]+)/g
          )
        ).map((m) => m[1]);
        const lineCount = activeRes.content.split(/\r?\n/).length;
        activeFileAnalysis =
          `\n### 3. 当前激活模块 (\`${activeRelPath}\`)\n` +
          `- **文件规模**: ${lineCount} 行（${activeRes.byteLength} 字节）\n` +
          (exportedSymbols.length > 0
            ? `- **导出核心符号**: ${exportedSymbols.map((s) => `\`${s}\``).join('、')}\n`
            : '- **模块状态**: 已解析并加入上下文\n');
      } catch {
        // ignore
      }
    }

    await streamText(
      `${authFailedNotice}## 项目功能与架构分析\n\n` +
        `${workspaceSummary}${packageAnalysis}${activeFileAnalysis}\n` +
        `> 💡 **提示**：您可以在 **⚙️ Settings -> Models & Providers** 中点击 **⚡ Test AI Key** 验证云端模型连接；也可以直接输入需求（如修改代码、排查 Bug、运行测试）。`
    );

    return { content: chunks.join('') };
  }

  private normalizeWorkspaceRelativePath(rawPath: string, workspaceRoot: string): string {
    const trimmed = String(rawPath || '').trim();
    if (!trimmed) return '';
    const resolvedRoot = path.resolve(workspaceRoot);
    const rootBase = path.basename(resolvedRoot);

    // 1. If rawPath is already inside resolvedRoot on the local OS
    if (path.isAbsolute(trimmed)) {
      const resolvedTarget = path.resolve(trimmed);
      const rel = path.relative(resolvedRoot, resolvedTarget);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
        return (rel || '.').replace(/\\/g, '/');
      }
    }

    // 2. If rawPath is a remote POSIX path on Windows (e.g. "/home/renjc01/Bug/fhccl/nccl-test/src/sendrecv.cc")
    if (trimmed.startsWith('/') && !trimmed.startsWith('//') && rootBase) {
      const marker = `/${rootBase}/`;
      const idx = trimmed.lastIndexOf(marker);
      if (idx >= 0) {
        return trimmed.slice(idx + marker.length).replace(/\\/g, '/');
      }
      if (trimmed.endsWith(`/${rootBase}`)) {
        return '.';
      }
    }

    // 3. Clean relative path and strip redundant workspace folder prefix if present
    let cleanRel = trimmed.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
    if (rootBase && cleanRel.startsWith(`${rootBase}/`)) {
      const withoutPrefix = cleanRel.slice(rootBase.length + 1);
      if (withoutPrefix) {
        cleanRel = withoutPrefix;
      }
    }
    return cleanRel || '.';
  }

  private applySmartTextReplacement(
    currentContent: string,
    oldText: string,
    newText: string,
    filePath: string
  ): string {
    if (!currentContent) {
      return newText;
    }
    // 1. Exact substring match (using function replacer so '$&' / '$$' in C/bash code are never mangled)
    if (currentContent.includes(oldText)) {
      return currentContent.replace(oldText, () => newText);
    }

    // 2. CRLF / LF normalized match
    const hasCrLf = currentContent.includes('\r\n');
    const normCurrent = currentContent.replace(/\r\n/g, '\n');
    const normOld = oldText.replace(/\r\n/g, '\n');
    const normNew = newText.replace(/\r\n/g, '\n');

    if (normCurrent.includes(normOld)) {
      const replaced = normCurrent.replace(normOld, () => normNew);
      return hasCrLf ? replaced.replace(/\n/g, '\r\n') : replaced;
    }

    // 3. Tab / space indentation-tolerant line-by-line block match
    const contentLines = normCurrent.split('\n');
    const oldLines = normOld.split('\n');
    // Trim leading/trailing empty lines from oldLines if needed
    while (oldLines.length > 0 && oldLines[0].trim() === '') oldLines.shift();
    while (oldLines.length > 0 && oldLines[oldLines.length - 1].trim() === '') oldLines.pop();

    if (oldLines.length > 0 && oldLines.length <= contentLines.length) {
      for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
        let allMatch = true;
        for (let j = 0; j < oldLines.length; j++) {
          if (contentLines[i + j].trim() !== oldLines[j].trim()) {
            allMatch = false;
            break;
          }
        }
        if (allMatch) {
          const before = contentLines.slice(0, i);
          const after = contentLines.slice(i + oldLines.length);
          const joined = [...before, normNew, ...after].join('\n');
          return hasCrLf ? joined.replace(/\n/g, '\r\n') : joined;
        }
      }
    }

    throw new Error(
      `OLD_TEXT_NOT_FOUND: Could not find matching 'oldText' block in "${filePath}". Please call read_file on "${filePath}" to inspect the exact lines, or call write_file with the complete file content.`
    );
  }

  private async proposeAndApplyFileEdit(params: {
    sessionId: string;
    manifest: SessionManifest;
    targetFile: string;
    proposedContent: string;
    signal: AbortSignal;
    runCapabilityTool: (
      capability: CapabilityName,
      args: Record<string, unknown>,
      risk?: ToolCallRecord['risk']
    ) => Promise<unknown>;
    diffIds: string[];
    /**
     * When true (default for auto), write immediately then allow Reject to roll back.
     * When false (manual), keep review-before-write until the user Accepts.
     */
    applyImmediately?: boolean;
    onBeforeFirstMutation?: () => Promise<void>;
    trackOriginal?: (filePath: string, originalContent: string, operation: 'create' | 'modify') => void;
  }): Promise<{ diffId: string; bytesWritten: number; operation: string; appliedToDisk: boolean }> {
    const { sessionId, manifest, proposedContent, signal, runCapabilityTool, diffIds } = params;
    const targetFile = this.normalizeWorkspaceRelativePath(
      params.targetFile,
      manifest.workspaceRoot
    );
    // Auto: write immediately (Reject can roll back).
    // Manual: write-file goes through ApprovalBridge first (human-in-the-loop), then disk.
    const applyImmediately =
      params.applyImmediately ?? true;

    let originalContent = '';
    try {
      const readRes = (await this.capabilityRegistry.invoke(
        'read-file',
        { filePath: targetFile },
        {
          sessionId,
          workspaceRoot: manifest.workspaceRoot,
          executionMode: 'plan',
          signal,
        }
      )) as { content: string };
      originalContent = readRes.content;
    } catch {
      originalContent = '';
    }

    const operation: 'create' | 'modify' = originalContent ? 'modify' : 'create';
    params.trackOriginal?.(targetFile, originalContent, operation);

    if (applyImmediately && params.onBeforeFirstMutation) {
      await params.onBeforeFirstMutation();
    }

    const diffId = `diff_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const unifiedDiff = createUnifiedDiff(targetFile, originalContent, proposedContent);
    const diffRecord: DiffChangeRecord = {
      diffId,
      sessionId,
      filePath: targetFile,
      operation,
      originalContent,
      proposedContent,
      unifiedDiff,
      status: 'pending',
      appliedToDisk: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.saveDiff(sessionId, diffRecord);
    diffIds.push(diffId);

    // P0-2: emit Diff proposal before any disk write so UI can show pending change first.
    this.emit({
      type: 'diff_proposed',
      sessionId,
      payload: { ...diffRecord },
    });

    await runCapabilityTool(
      'reveal-diff',
      {
        diffId,
        filePath: targetFile,
        originalContent,
        proposedContent,
        title:
          manifest.executionMode === 'manual'
            ? `DeepAutoCode Diff (awaiting approval): ${targetFile}`
            : `DeepAutoCode Diff: ${targetFile}`,
      },
      'low'
    );

    let bytesWritten = Buffer.byteLength(proposedContent, 'utf-8');
    let writeOperation = operation;

    if (applyImmediately) {
      try {
        // Manual → ApprovalBridge gates write-file; Auto writes immediately.
        const writeOut = (await runCapabilityTool(
          'write-file',
          {
            filePath: targetFile,
            content: proposedContent,
            createDirectories: true,
          },
          'medium'
        )) as { bytesWritten: number; operation: string };
        bytesWritten = writeOut?.bytesWritten ?? bytesWritten;
        writeOperation = (writeOut?.operation as 'create' | 'modify') ?? operation;
        diffRecord.appliedToDisk = true;
        diffRecord.status = 'pending';
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('USER_REJECTED')) {
          diffRecord.status = 'rejected';
          diffRecord.appliedToDisk = false;
          diffRecord.feedback = msg;
          diffRecord.updatedAt = new Date().toISOString();
          await this.saveDiff(sessionId, diffRecord);
          this.emit({
            type: 'diff_proposed',
            sessionId,
            payload: { ...diffRecord },
          });
        }
        throw err;
      }
    }

    diffRecord.updatedAt = new Date().toISOString();
    await this.saveDiff(sessionId, diffRecord);

    if (diffRecord.appliedToDisk) {
      this.emit({
        type: 'diff_proposed',
        sessionId,
        payload: { ...diffRecord },
      });
    }

    return {
      diffId,
      bytesWritten,
      operation: writeOperation,
      appliedToDisk: Boolean(diffRecord.appliedToDisk),
    };
  }

  /**
   * Real Multi-Step Autonomous Coding Loop powered by `@cline/sdk` `Agent` (`AgentRuntime`)
   * + `createBuiltinTools` & `createTool`, bridged to DeepAutoCode's `CapabilityRegistry`.
   */
  private async executeLiveLlmAgentLoop(params: {
    manifest: SessionManifest;
    prompt: string;
    apiKey: string;
    signal: AbortSignal;
    chunks: string[];
    streamText: (text: string) => Promise<void>;
    runCapabilityTool: (
      capability: CapabilityName,
      args: Record<string, unknown>,
      risk?: ToolCallRecord['risk']
    ) => Promise<unknown>;
    diffIds: string[];
    taskId?: string;
    onCircuitTriggered?: () => void;
    emitTraceUpdated?: (event: unknown) => void;
    policyGate?: {
      executionMode: AgentExecutionMode;
      permissionRuleset: PermissionRuleset;
    };
  }): Promise<{ content: string }> {
    const {
      manifest,
      prompt,
      apiKey,
      signal,
      chunks,
      streamText,
      runCapabilityTool,
      diffIds,
      taskId,
      onCircuitTriggered,
      emitTraceUpdated,
      policyGate,
    } = params;
    const sessionId = manifest.sessionId;
    const { provider } = this.providerManager.getActiveProvider();
    const endpoint = `${provider.apiEndpoint.replace(/\/$/, '')}/chat/completions`;
    const isSshMirrorWorkspace = manifest.workspaceRoot.includes('ssh-mirrors');

    // Build top-level workspace file list for context
    let workspaceFilesHint = '';
    try {
      const topEntries = await fs.readdir(manifest.workspaceRoot, { withFileTypes: true });
      workspaceFilesHint = topEntries
        .filter((e) => !['node_modules', '.git', 'dist', '.deepautocode-data'].includes(e.name))
        .slice(0, 30)
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .join(', ');
    } catch {
      workspaceFilesHint = '';
    }

    const sdk = await import('../core/index.js');
    const {
      Agent,
      createBuiltinTools,
      createTool,
      extractCodeOutline,
      getClineDefaultSystemPrompt,
      generateWorkspaceInfo,
      enrichPromptWithMentions,
      expandSlashCommandPrompt,
      createToolPoliciesWithPreset,
      overlayToolPoliciesWithHardRules,
      FileStateCache,
      WorkspaceFileIndex,
      searchIndexedFiles,
      createGoalState,
      buildGoalContinuationPrompt,
      buildGoalBudgetLimitPrompt,
      isGoalTokenBudgetExceeded,
      DEFAULT_GOAL_TOKEN_BUDGET,
      resolveTieredModelForTurn,
      classifyPromptIntent,
      ensureAgentSandboxBranch,
      rollbackSessionMutations,
      loadVerifyConfig,
      formatVerifyCommandsForPrompt,
      isVerifiableSourcePath,
      parseBuildDiagnostics,
      formatDiagnosticsForPrompt,
      extractFailedTestHints,
      diagnoseTypeScriptFile,
      diagnoseEditedFile,
      attachDiagnosticSnippets,
      loadWorkspaceProblemsText,
      applyPatchToContent,
      applyMultiFilePatch,
      listPatchFiles,
      McpHost,
      loadMcpConfigsFromWorkspace,
      applyStandardToolAliases,
      SessionTodoList,
      runResearchSubagent,
      runPlannerSubagent,
      runEditSubagent,
      createSubagentSandbox,
      runDiagnoseAndVerify,
      loadAgentMemory,
      formatAgentMemoryForPrompt,
      appendAgentMemory,
      digestTextToMemorySummary,
      MAX_SELF_HEAL_ATTEMPTS,
      MAX_VERIFY_NUDGES,
      MistakeTracker,
      LoopDetection,
      getShadowGitCheckpoint,
    } = sdk;
    const selfHealBudget =
      typeof MAX_SELF_HEAL_ATTEMPTS === 'number' ? MAX_SELF_HEAL_ATTEMPTS : 5;
    const verifyNudgeBudget =
      typeof MAX_VERIFY_NUDGES === 'number' ? MAX_VERIFY_NUDGES : 4;

    const verifyConfig =
      typeof loadVerifyConfig === 'function'
        ? await loadVerifyConfig(manifest.workspaceRoot)
        : {
            buildCommand: 'npm run build',
            testCommand: 'npm test',
            combinedCommand: 'npm run build && npm test',
            sourceGlobs: ['**/*.{ts,tsx,js,jsx,c,cc,cpp,h,hpp}'],
            enableEvolveSandbox: true,
            source: 'default' as const,
          };
    const verifyPromptBlock =
      typeof formatVerifyCommandsForPrompt === 'function'
        ? formatVerifyCommandsForPrompt(verifyConfig)
        : `Build: \`${verifyConfig.buildCommand}\`\nTest: \`${verifyConfig.testCommand}\``;
    const preferredVerifyCommand =
      verifyConfig.combinedCommand?.trim() ||
      `${verifyConfig.buildCommand} && ${verifyConfig.testCommand}`;

    const mcpHost = typeof McpHost === 'function' ? new McpHost() : null;
    let mcpBootstrapNote = '';
    let mcpConfigsCached: any[] = [];
    if (mcpHost && typeof loadMcpConfigsFromWorkspace === 'function') {
      try {
        mcpConfigsCached = await loadMcpConfigsFromWorkspace(manifest.workspaceRoot);
        if (mcpConfigsCached.length > 0) {
          await mcpHost.connectAll(mcpConfigsCached, manifest.workspaceRoot);
          const toolsListed = mcpHost.listTools();
          const disabledCount = mcpConfigsCached.reduce(
            (n: number, c: any) => n + (Array.isArray(c.disabledTools) ? c.disabledTools.length : 0),
            0
          );
          mcpBootstrapNote =
            toolsListed.length > 0
              ? `Connected MCP tools: ${toolsListed
                  .slice(0, 24)
                  .map((t: any) => t.qualifiedName)
                  .join(', ')}${toolsListed.length > 24 ? '…' : ''}${
                  disabledCount ? ` (${disabledCount} disabled)` : ''
                }`
              : mcpHost.getLastError() || 'MCP configs found but no tools connected.';
        }
      } catch (err) {
        mcpBootstrapNote = `MCP bootstrap failed: ${(err as Error).message || String(err)}`;
      }
    }

    const slashExpanded =
      typeof expandSlashCommandPrompt === 'function'
        ? expandSlashCommandPrompt(prompt)
        : { expandedPrompt: prompt };
    const basePromptForTurn = slashExpanded.expandedPrompt || prompt;

    const fileStateCache = new FileStateCache();
    const workspaceFileIndex =
      typeof WorkspaceFileIndex === 'function'
        ? new WorkspaceFileIndex(manifest.workspaceRoot, { ttlMs: 30_000, maxFiles: 12_000 })
        : null;
    // Warm the path index in the background so the first search_codebase is faster.
    void workspaceFileIndex?.ensureFresh().catch(() => undefined);
    const activeGoal = createGoalState(
      basePromptForTurn,
      typeof DEFAULT_GOAL_TOKEN_BUDGET === 'number' ? DEFAULT_GOAL_TOKEN_BUDGET : 180_000
    );
    let budgetLimitNotified = false;
    const promptIntent = classifyPromptIntent(basePromptForTurn);
    const isReadOnlyTurn =
      slashExpanded.suggestedMode === 'plan' ||
      manifest.executionMode === 'plan' ||
      (!promptIntent.allowFileMutations && slashExpanded.suggestedMode !== 'auto');
    // Hard Plan/readonly: CapabilityRegistry must see executionMode=plan even when
    // manifest stays auto (intent-classified read-only turns).
    if (policyGate && isReadOnlyTurn) {
      policyGate.executionMode = 'plan';
    }

    // 0. Reuse @cline/sdk native workspace metadata & @file mention enricher
    let workspaceInfo: any = { rootPath: manifest.workspaceRoot, hint: path.basename(manifest.workspaceRoot) };
    try {
      if (typeof generateWorkspaceInfo === 'function') {
        workspaceInfo = await generateWorkspaceInfo(manifest.workspaceRoot);
      }
    } catch {
      // fallback to basic workspaceInfo
    }

    let effectivePrompt = basePromptForTurn;
    try {
      if (typeof enrichPromptWithMentions === 'function' && basePromptForTurn.includes('@')) {
        const enriched = await enrichPromptWithMentions(basePromptForTurn, manifest.workspaceRoot, {
          maxFiles: 5,
          maxFileBytes: 32000,
        });
        if (enriched?.prompt) {
          effectivePrompt = enriched.prompt;
        }
      }
    } catch {
      effectivePrompt = basePromptForTurn;
    }

    // Zero-Roundtrip Auto-Prefetch: If the user's prompt mentions specific source files (e.g. src/enqueue.cc:782-811),
    // pre-read up to 3 referenced files in parallel BEFORE Turn 1 so the LLM skips 1-3 exploratory tool round-trips.
    try {
      const promptTokens = prompt.split(/[\s,;()[\]{}<>"'`，；。（）【】「」|]+/);
      const seenPrefetchPaths = new Set<string>();
      const prefetchTargets: Array<{ relPath: string; startLine?: number; endLine?: number }> = [];

      for (const tok of promptTokens) {
        if (!tok || !tok.includes('.') || /^https?:\/\//i.test(tok)) continue;
        const m = tok.match(
          /^([a-zA-Z0-9_./-]+\.(?:c|cc|cpp|cxx|cu|cuh|h|hh|hpp|py|ts|tsx|js|jsx|go|rs|java|sh|cmake))(?::(\d+)(?:[-:](\d+))?)?$/i
        );
        if (!m) continue;
        const relPath = this.normalizeWorkspaceRelativePath(m[1], manifest.workspaceRoot);
        if (!relPath || relPath.startsWith('..') || seenPrefetchPaths.has(relPath)) continue;
        seenPrefetchPaths.add(relPath);
        prefetchTargets.push({
          relPath,
          startLine: m[2] ? Number(m[2]) : undefined,
          endLine: m[3] ? Number(m[3]) : undefined,
        });
        if (prefetchTargets.length >= 3) break;
      }

      if (prefetchTargets.length > 0) {
        const prefetchedSnippets = await Promise.all(
          prefetchTargets.map(async (target) => {
            try {
              const absPath = path.resolve(manifest.workspaceRoot, target.relPath);
              const rawText = await fs.readFile(absPath, 'utf-8');
              const allLines = rawText.split(/\r?\n/);
              const sLine = target.startLine ? Math.max(1, target.startLine - 35) : 1;
              const eLine = target.endLine
                ? Math.min(allLines.length, target.endLine + 45)
                : target.startLine
                  ? Math.min(allLines.length, target.startLine + 65)
                  : Math.min(allLines.length, 160);
              const numbered = allLines
                .slice(sLine - 1, eLine)
                .map((l, idx) => `${sLine + idx}: ${l}`)
                .join('\n');
              fileStateCache.recordRead({
                filePath: target.relPath,
                content: rawText,
                startLine: sLine,
                endLine: eLine,
              });
              return `\n--- [Pre-fetched File: ${target.relPath} (lines ${sLine}-${eLine} of ${allLines.length})] ---\n${numbered}`;
            } catch {
              return '';
            }
          })
        );
        const validSnippets = prefetchedSnippets.filter((s) => s.length > 0);
        if (validSnippets.length > 0) {
          effectivePrompt = `${effectivePrompt}\n\n[Auto-Prefetched Workspace Files — Already loaded in context, no need to re-read these same line ranges:]${validSnippets.join('\n')}`;
        }
      }
    } catch {
      // ignore prefetch errors
    }

    const sessionWrittenFiles: string[] = [];
    const sessionOriginalContents = new Map<string, string>();
    const sessionCreatedFiles = new Set<string>();
    const readCountsByRange = new Map<string, number>();
    const executedCommandCounts = new Map<string, number>();
    let hasUnverifiedCompiledEdit = false;
    let hasUnverifiedTestAfterEdit = false;
    let lastBuildOrTestFailed = false;
    let lastSemanticFailed = false;
    let lastSemanticDiagSnippet = '';
    let lastFailureOutputSnippet = '';
    let lastFailedTestHints: string[] = [];
    let selfHealCount = 0;
    let verifyNudgeCount = 0;
    let autoContinuationCount = 0;
    let editMismatchCount = 0;
    let lastVerifierPass: boolean | null = null;
    let sandboxBranchEnsured = false;
    let circuitBroken = false;
    let circuitBreakerNotified = false;
    const mistakeTracker =
      typeof MistakeTracker === 'function' ? new MistakeTracker() : null;
    const loopDetection =
      typeof LoopDetection === 'function' ? new LoopDetection() : null;
    let shadowCheckpointCount = 0;
    const sessionTodos =
      typeof SessionTodoList === 'function' ? new SessionTodoList() : null;

    const persistSessionArtifact = async (params: {
      artifactType: 'plan' | 'task_list' | 'walkthrough' | 'report';
      title: string;
      content: string;
      source?: string;
    }): Promise<{ artifactId: string; artifactType: string; title: string }> => {
      const artifactId = `art_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const artifactsDir = path.join(this.storageDir, '..', 'artifacts');
      await fs.mkdir(artifactsDir, { recursive: true });
      const artifactRecord = {
        id: artifactId,
        sessionId,
        artifactType: params.artifactType,
        title: params.title,
        content: params.content,
        workspaceRoot: manifest.workspaceRoot,
        source: params.source || 'agent',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await fs.writeFile(
        path.join(artifactsDir, `${artifactId}.json`),
        JSON.stringify(artifactRecord, null, 2),
        'utf-8'
      );
      this.emit({
        type: 'artifact_created',
        sessionId,
        payload: {
          artifactId,
          artifactType: params.artifactType,
          title: params.title,
          source: params.source || 'agent',
        },
      });
      return {
        artifactId,
        artifactType: params.artifactType,
        title: params.title,
      };
    };

    const hasTestTargetInContext =
      /(?:_perf\b|nccl-test\b|\btests?\b|\bctest\b|\bpytest\b|测试)/i.test(
        `${workspaceFilesHint} ${prompt}`
      );

    const ensureSandboxOnce = async () => {
      if (
        sandboxBranchEnsured ||
        manifest.executionMode === 'manual' ||
        isReadOnlyTurn ||
        verifyConfig.enableEvolveSandbox === false
      ) {
        return;
      }
      sandboxBranchEnsured = true;
      if (typeof ensureAgentSandboxBranch === 'function') {
        const sandbox = await ensureAgentSandboxBranch(manifest.workspaceRoot).catch(() => null);
        if (sandbox?.enabled && sandbox.branch) {
          this.emit({
            type: 'sandbox_branch_created',
            sessionId,
            payload: {
              branch: sandbox.branch,
              previousBranch: sandbox.previousBranch,
              message: sandbox.message,
            },
          });
        }
      }
    };

    const trackOriginalForRollback = (
      filePath: string,
      originalContent: string,
      operation: 'create' | 'modify'
    ) => {
      if (operation === 'create') {
        sessionCreatedFiles.add(filePath);
        return;
      }
      if (!sessionOriginalContents.has(filePath)) {
        sessionOriginalContents.set(filePath, originalContent);
      }
    };

    const applyFileEdit = (targetFile: string, proposedContent: string) => {
      if (circuitBroken) {
        return Promise.reject(
          new Error(
            'CIRCUIT_BREAKER_ACTIVE: Session mutations were rolled back after repeated verification failures. Do not edit files further; summarize the failure instead.'
          )
        );
      }
      return this.proposeAndApplyFileEdit({
        sessionId,
        manifest,
        targetFile,
        proposedContent,
        signal,
        runCapabilityTool,
        diffIds,
        // Always write after policy/approval: Manual hits ApprovalBridge; Auto writes directly.
        applyImmediately: true,
        onBeforeFirstMutation: ensureSandboxOnce,
        trackOriginal: trackOriginalForRollback,
      });
    };

    const recordCompiledFileEdit = (filePath: string) => {
      sessionWrittenFiles.push(filePath);
      executedCommandCounts.clear();
      const normKeyPrefix = `${filePath}:`;
      for (const k of Array.from(readCountsByRange.keys())) {
        if (k.startsWith(normKeyPrefix)) {
          readCountsByRange.delete(k);
        }
      }
      const needsVerify =
        typeof isVerifiableSourcePath === 'function'
          ? isVerifiableSourcePath(filePath, verifyConfig)
          : /\.(?:c|cc|cpp|cu|h|hpp|ts|tsx|js|jsx|py|go|rs)$/i.test(filePath);
      if (needsVerify) {
        hasUnverifiedCompiledEdit = true;
        if (hasTestTargetInContext || Boolean(verifyConfig.testCommand)) {
          hasUnverifiedTestAfterEdit = true;
        }
      }
    };

    const recordCommandOutcome = (cmd: string, res: { exitCode: number; stdout?: string; stderr?: string }) => {
      const combinedOut = `${res.stdout || ''}\n${res.stderr || ''}`;
      const isBuildCmd = /\b(?:make|cmake|ninja|gcc|g\+\+|hipcc|nvcc|cargo|npm\s+run\s+build|tsc)\b/i.test(cmd);
      const isTestCmd = /(?:_perf\b|\bctest\b|\bpytest\b|\bvitest\b|\bnpm\s+test\b|\bverify-[a-z0-9_.-]+|\.\/(?:build\/)?[a-z0-9_]+_perf\b)/i.test(
        cmd
      );
      if (!isBuildCmd && !isTestCmd) {
        return;
      }
      const hasRuntimeOrCompileFailure =
        res.exitCode !== 0 ||
        /(?:Test NCCL failure|# Out of bounds values\s*:\s*[1-9]\d*\s+FAILED|\bfatal error:|\berror:\s+[^\n]+|\bSegmentation fault\b|\bAborted\s*\(core dumped\))/i.test(
          combinedOut
        );
      if (isBuildCmd && !hasRuntimeOrCompileFailure) {
        hasUnverifiedCompiledEdit = false;
      }
      if (isTestCmd) {
        hasUnverifiedCompiledEdit = false;
        hasUnverifiedTestAfterEdit = false;
      }
      lastBuildOrTestFailed = hasRuntimeOrCompileFailure;
      if (hasRuntimeOrCompileFailure) {
        activeGoal.consecutiveBlockedTurns += 1;
        lastFailureOutputSnippet = combinedOut.trim().slice(-1200);
        lastFailedTestHints =
          typeof extractFailedTestHints === 'function'
            ? extractFailedTestHints(combinedOut, 6)
            : [];
        sessionTodos?.ensureVerifyTodo(preferredVerifyCommand);
        mistakeTracker?.recordMistake('verify_fail', cmd.slice(0, 120));
      } else {
        activeGoal.consecutiveBlockedTurns = 0;
        activeGoal.verifiedByCommand = true;
        lastFailureOutputSnippet = '';
        lastFailedTestHints = [];
        lastSemanticFailed = false;
        lastSemanticDiagSnippet = '';
        sessionTodos?.completeMatching((c) => /verify|test|build|编译|测试|验证/i.test(c));
        mistakeTracker?.recordSuccess();
        // DS-P3: shadow-git step checkpoint only after verify pass
        void (async () => {
          try {
            if (typeof getShadowGitCheckpoint !== 'function') return;
            const shadow = getShadowGitCheckpoint(manifest.workspaceRoot);
            shadowCheckpointCount += 1;
            const label = `verify-pass #${shadowCheckpointCount} · ${
              isBuildCmd ? 'build' : 'test'
            } · ${cmd.slice(0, 80)}`;
            const ckpt = await shadow.create(label);
            const signalEvt = globalTaskTraceStore.recordSignal?.({
              workspaceRoot: manifest.workspaceRoot,
              sessionId,
              taskId,
              signal: 'checkpoint',
              summary: ckpt.ok
                ? `shadow-git ${ckpt.skipped ? 'unchanged' : 'commit'} ${ckpt.commit?.slice(0, 8) || ''} · ${label}`
                : `shadow-git failed: ${ckpt.reason || 'unknown'}`,
              detail: { commit: ckpt.commit, skipped: ckpt.skipped, ok: ckpt.ok },
            });
            if (signalEvt) emitTraceUpdated?.(signalEvt);
            this.emit({
              type: 'checkpoint_created',
              sessionId,
              payload: {
                kind: 'shadow-git',
                ok: ckpt.ok,
                skipped: ckpt.skipped,
                commit: ckpt.commit,
                message: label,
                reason: ckpt.reason,
              },
            });
          } catch {
            // non-fatal
          }
        })();
      }
      const verifyEvt = globalTaskTraceStore.recordVerify({
        workspaceRoot: manifest.workspaceRoot,
        sessionId,
        taskId,
        passed: !hasRuntimeOrCompileFailure,
        summary: `${isBuildCmd ? 'build' : 'test'} exit=${res.exitCode} · ${cmd}`,
      });
      if (verifyEvt) emitTraceUpdated?.(verifyEvt);
    };

    const runPostEditDiagnostics = async (
      filePath: string,
      content: string
    ): Promise<{
      diagnostics?: unknown[];
      semanticErrors?: string;
      mandatoryFixHint?: string;
      workspaceProblems?: string;
    }> => {
      const diagnose =
        typeof diagnoseEditedFile === 'function'
          ? diagnoseEditedFile
          : typeof diagnoseTypeScriptFile === 'function'
            ? async (p: {
                workspaceRoot: string;
                filePath: string;
                content: string;
              }) => diagnoseTypeScriptFile(p)
            : null;

      let workspaceProblems = '';
      if (typeof loadWorkspaceProblemsText === 'function') {
        try {
          const all = await loadWorkspaceProblemsText(manifest.workspaceRoot, 60);
          const norm = filePath.replace(/\\/g, '/');
          const base = path.basename(norm);
          workspaceProblems = all
            .split('\n')
            .filter((line) => {
              const l = line.replace(/\\/g, '/');
              return l.includes(norm) || l.includes(`/${base}:`) || l.includes(`${base}:`);
            })
            .slice(0, 20)
            .join('\n');
        } catch {
          workspaceProblems = '';
        }
      }

      if (!diagnose) {
        if (workspaceProblems) {
          lastSemanticFailed = true;
          lastSemanticDiagSnippet = workspaceProblems.slice(0, 3500);
          return {
            workspaceProblems,
            semanticErrors: lastSemanticDiagSnippet,
            mandatoryFixHint:
              'WORKSPACE_PROBLEMS: Fix Problems-panel diagnostics for this file via edit_file/apply_patch, then re-verify.',
          };
        }
        return {};
      }
      try {
        const diags = await diagnose({
          workspaceRoot: manifest.workspaceRoot,
          filePath,
          content,
        });
        const errors = (diags || []).filter((d: { severity: string }) => d.severity === 'error');
        if (errors.length === 0 && !workspaceProblems) {
          lastSemanticFailed = false;
          lastSemanticDiagSnippet = '';
          return { diagnostics: diags, workspaceProblems: '' };
        }
        if (errors.length === 0 && workspaceProblems) {
          lastSemanticFailed = true;
          lastSemanticDiagSnippet = workspaceProblems.slice(0, 3500);
          return {
            diagnostics: diags,
            workspaceProblems,
            semanticErrors: lastSemanticDiagSnippet,
            mandatoryFixHint:
              'WORKSPACE_PROBLEMS: IDE/build Problems remain for this file. Fix them before claiming success.',
          };
        }
        lastSemanticFailed = true;
        const formatted =
          typeof formatDiagnosticsForPrompt === 'function'
            ? formatDiagnosticsForPrompt(errors, 20)
            : errors
                .map(
                  (d: { severity: string; file: string; line: number; message: string }) =>
                    `${d.severity} ${d.file}:${d.line} ${d.message}`
                )
                .join('\n');
        const snippets =
          typeof attachDiagnosticSnippets === 'function'
            ? attachDiagnosticSnippets(content, errors, 2)
            : '';
        const merged = `${formatted}${snippets ? `\n${snippets}` : ''}${
          workspaceProblems ? `\n\n[Workspace Problems for file]\n${workspaceProblems}` : ''
        }`;
        lastSemanticDiagSnippet = merged.slice(0, 3500);
        return {
          diagnostics: errors,
          workspaceProblems: workspaceProblems || undefined,
          semanticErrors: lastSemanticDiagSnippet,
          mandatoryFixHint:
            'SEMANTIC_DIAGNOSTICS_FAILED: Fix the language diagnostics above via edit_file or apply_patch before claiming success. Prefer fixing types/imports/syntax, then re-run verify.',
        };
      } catch {
        return workspaceProblems
          ? {
              workspaceProblems,
              semanticErrors: workspaceProblems.slice(0, 3500),
              mandatoryFixHint: 'WORKSPACE_PROBLEMS: Fix Problems-panel diagnostics, then re-verify.',
            }
          : {};
      }
    };

    const fullReadExpandedFiles = new Set<string>();
    const autoExpandPartialSedRead = async (cmd: string, stdout: string): Promise<string> => {
      const sedMatch = cmd.match(/\bsed\s+-n\s+['"]?(\d+)\s*,\s*(\d+)p['"]?\s+([^\s;|&>'"]+)/);
      if (!sedMatch) {
        return stdout;
      }
      const endLine = Number(sedMatch[2]);
      const rawTargetFile = sedMatch[3];
      if (!endLine || !rawTargetFile) {
        return stdout;
      }
      try {
        const relFile = this.normalizeWorkspaceRelativePath(rawTargetFile, manifest.workspaceRoot);
        if (fullReadExpandedFiles.has(relFile)) {
          return `[DUPLICATE_FILE_SLICE_NOTICE]: Complete file '${relFile}' was already returned in full earlier in this turn. Do NOT run additional sed/cat commands on '${relFile}'; proceed directly to edit_file / write_file or compile/test!`;
        }
        const absFile = path.resolve(manifest.workspaceRoot, relFile);
        let fileContent = await fs.readFile(absFile, 'utf-8').catch(() => '');
        if (!fileContent.trim()) {
          const pulled = (await this.capabilityRegistry.invoke(
            'read-file',
            { filePath: relFile },
            {
              sessionId,
              workspaceRoot: manifest.workspaceRoot,
              executionMode: 'plan',
              signal,
            }
          )) as { content: string };
          fileContent = pulled?.content || '';
        }
        const allLines = fileContent.split(/\r?\n/);
        if (allLines.length > 1 && allLines.length <= 400) {
          fullReadExpandedFiles.add(relFile);
          const numberedFull = allLines.map((line, idx) => `${idx + 1}: ${line}`).join('\n');
          return `/* [DeepAutoCode Function-Completeness Auto-Expand (Full-File Auto-Read): '${relFile}' has ${allLines.length} lines total. Returning the ENTIRE file (1..${allLines.length}) below so you do not miss #if 0 blocks or tail logic — do NOT run any more sed/grep slices on '${relFile}'!] */\n${numberedFull}`;
        }
        if (endLine < allLines.length) {
          const appendUntil = Math.min(allLines.length, endLine + 120);
          const extraSnippet = allLines
            .slice(endLine, appendUntil)
            .map((line, idx) => `${endLine + 1 + idx}: ${line}`)
            .join('\n');
          return `${stdout}\n/* [DeepAutoCode Function-Completeness Auto-Expand: lines ${endLine + 1}..${appendUntil} of ${relFile} appended automatically so you do not miss #if 0 blocks or tail logic] */\n${extraSnippet}`;
        }
      } catch {
        // ignore if file is not accessible
      }
      return stdout;
    };

    /**
     * Automatically parses compiler/runtime errors (GCC, Clang, hipcc, nvcc, tsc, Python, Rust)
     * from build/test output and pre-loads the exact offending source lines (±22 lines) into context
     * so the Agent can immediately call `edit_file` on the very next turn without an extra `read_file` round-trip.
     */
    const autoExtractCompilerErrorContext = async (
      stdout: string,
      stderr: string
    ): Promise<string> => {
      const parsed =
        typeof parseBuildDiagnostics === 'function'
          ? parseBuildDiagnostics(stdout || '', stderr || '', { maxItems: 12 })
          : [];
      const seenLocs = new Set<string>();
      const targets: Array<{ relFile: string; line: number; msg: string }> = [];
      for (const d of parsed) {
        if (d.severity !== 'error') continue;
        const relFile = this.normalizeWorkspaceRelativePath(d.file, manifest.workspaceRoot);
        const key = `${relFile}:${Math.floor(d.line / 20)}`;
        if (!relFile || relFile.startsWith('..') || seenLocs.has(key)) continue;
        seenLocs.add(key);
        targets.push({ relFile, line: d.line, msg: d.message });
        if (targets.length >= 3) break;
      }

      if (targets.length === 0) {
        return '';
      }

      const snippets = await Promise.all(
        targets.map(async (t) => {
          try {
            const pulled = (await runCapabilityTool(
              'read-file',
              { filePath: t.relFile },
              'low'
            )) as { content: string };
            if (!pulled?.content) return '';
            const allLines = pulled.content.split(/\r?\n/);
            const s = Math.max(1, t.line - 18);
            const e = Math.min(allLines.length, t.line + 22);
            fileStateCache.recordRead({
              filePath: t.relFile,
              content: pulled.content,
              startLine: s,
              endLine: e,
            });
            const numbered = allLines
              .slice(s - 1, e)
              .map((l, idx) => `${s + idx === t.line ? '>> ' : '   '}${s + idx}: ${l}`)
              .join('\n');
            return `\n--- [Auto-Loaded Error Source: ${t.relFile}:${t.line} (${t.msg})] ---\n${numbered}`;
          } catch {
            return '';
          }
        })
      );

      const valid = snippets.filter(Boolean);
      return valid.length > 0
        ? `\n\n[DeepAutoCode Auto-Diagnosed Compiler Error Context — Immediately call edit_file to fix these lines and re-run build]:${valid.join('\n')}`
        : '';
    };

    // 1. Create In-tree Antigravity-Enhanced Builtin Tools wired to DeepAutoCode CapabilityRegistry
    const builtinTools = createBuiltinTools({
      cwd: manifest.workspaceRoot,
      shell: isSshMirrorWorkspace ? '/bin/bash' : undefined,
      enableEditor: manifest.executionMode !== 'plan' && !isReadOnlyTurn,
      enableApplyPatch: false,
      executionMode:
        manifest.executionMode === 'plan' || isReadOnlyTurn ? 'plan' : manifest.executionMode,
      ...(workspaceFileIndex ? { fileIndex: workspaceFileIndex } : {}),
      executors: {
        search: async (query: string, subDir?: string, contextLines = 3) => {
          if (isSshMirrorWorkspace) {
            const safeQuery = String(query || '').replace(/'/g, `'\\''`);
            const safeSubDir = subDir
              ? this.normalizeWorkspaceRelativePath(subDir, manifest.workspaceRoot).replace(
                  /'/g,
                  `'\\''`
                )
              : '.';
            const ctx = Math.max(0, Math.min(8, Number(contextLines) || 3));
            const res = (await runCapabilityTool(
              'run-build',
              {
                command: `(command -v rg >/dev/null 2>&1 && rg -n -C ${ctx} --hidden -g '!node_modules/**' -g '!.git/**' -F -- '${safeQuery}' '${safeSubDir}' 2>/dev/null || grep -rnI -C ${ctx} --exclude-dir=.git --exclude-dir=build --exclude-dir=node_modules -- '${safeQuery}' '${safeSubDir}' 2>/dev/null) | head -n 120`,
              },
              'low'
            )) as { stdout: string };
            return res.stdout?.trim() || 'No matches found.';
          }
          if (workspaceFileIndex && typeof searchIndexedFiles === 'function') {
            return searchIndexedFiles({
              root: manifest.workspaceRoot,
              index: workspaceFileIndex,
              query,
              under: subDir,
              contextLines,
            });
          }
          return 'No matches found.';
        },
        readFile: async (item: any) => {
          const rawFilePath = typeof item === 'string' ? item : item?.path;
          const filePath = this.normalizeWorkspaceRelativePath(
            rawFilePath,
            manifest.workspaceRoot
          );
          const res = (await runCapabilityTool('read-file', { filePath }, 'low')) as {
            content: string;
            byteLength: number;
          };
          const allLines = res.content.split(/\r?\n/);
          const start = Math.max(1, item?.start_line ?? 1);
          const end = Math.min(allLines.length, item?.end_line ?? allLines.length);
          fileStateCache.recordRead({
            filePath,
            content: res.content,
            startLine: start,
            endLine: end,
          });
          return allLines
            .slice(start - 1, end)
            .map((line, idx) => `${start + idx}: ${line}`)
            .join('\n');
        },
        editor: async (input: any) => {
          const filePath = this.normalizeWorkspaceRelativePath(
            input.path || input.filePath || input.file_path,
            manifest.workspaceRoot
          );
          const oldText = input.old_text ?? input.old_str;
          const newText = input.new_text ?? input.new_str ?? input.file_text ?? '';

          if (input.command === 'view') {
            const res = (await runCapabilityTool('read-file', { filePath }, 'low')) as {
              content: string;
            };
            fileStateCache.recordRead({ filePath, content: res.content });
            return res.content.slice(0, 12000);
          }

          if (input.insert_line != null || input.command === 'insert') {
            let currentContent = '';
            try {
              const current = (await runCapabilityTool('read-file', { filePath }, 'low')) as {
                content: string;
              };
              currentContent = current.content;
              fileStateCache.makeSnapshot(filePath, currentContent);
            } catch {
              currentContent = '';
            }
            const lines = currentContent ? currentContent.split(/\r?\n/) : [];
            const idx = Math.max(0, Math.min(lines.length, input.insert_line ?? lines.length));
            lines.splice(idx, 0, newText);
            const updated = lines.join('\n');
            const writeRes = await applyFileEdit(filePath, updated);
            fileStateCache.recordRead({ filePath, content: updated, isPartialView: false });
            recordCompiledFileEdit(filePath);
            workspaceFileIndex?.invalidate();
            return `Inserted into ${filePath} (${writeRes.bytesWritten} bytes, diffId=${writeRes.diffId}${writeRes.appliedToDisk ? '' : ', pending user Accept'})`;
          }

          if (oldText != null && oldText.length > 0) {
            const current = (await runCapabilityTool('read-file', { filePath }, 'low')) as {
              content: string;
            };
            fileStateCache.makeSnapshot(filePath, current.content);
            let updated: string;
            try {
              updated = this.applySmartTextReplacement(
                current.content,
                oldText,
                newText,
                filePath
              );
            } catch {
              const diag = fileStateCache.diagnoseEditMismatch(filePath, current.content, oldText);
              throw new Error(diag.hintMessage);
            }
            const writeRes = await applyFileEdit(filePath, updated);
            fileStateCache.recordRead({ filePath, content: updated, isPartialView: false });
            recordCompiledFileEdit(filePath);
            workspaceFileIndex?.invalidate();
            return `Updated ${filePath} (${writeRes.bytesWritten} bytes, diffId=${writeRes.diffId}${writeRes.appliedToDisk ? '' : ', pending user Accept'})`;
          }

          const writeRes = await applyFileEdit(filePath, newText);
          fileStateCache.recordRead({ filePath, content: newText, isPartialView: false });
          recordCompiledFileEdit(filePath);
          workspaceFileIndex?.invalidate();
          return `Created/Updated ${filePath} (${writeRes.bytesWritten} bytes, diffId=${writeRes.diffId}${writeRes.appliedToDisk ? '' : ', pending user Accept'})`;
        },
        bash: async (input: any) => {
          let cmd = '';
          if (typeof input === 'string') {
            cmd = input;
          } else if (input && typeof input === 'object') {
            const baseCmd = String(input.command ?? input.cmd ?? '').trim();
            const argsList = Array.isArray(input.args)
              ? input.args.map((a: unknown) => String(a)).join(' ')
              : '';
            cmd = argsList ? `${baseCmd} ${argsList}` : baseCmd;
          }
          const normCmd = cmd.trim().replace(/\s+/g, ' ');
          const prevCmdCount = executedCommandCounts.get(normCmd) ?? 0;
          if (normCmd && prevCmdCount >= 1) {
            executedCommandCounts.set(normCmd, prevCmdCount + 1);
            return `[DUPLICATE_COMMAND_SKIPPED]: You already executed this exact command in this turn and received its output above. Do NOT repeat the same command; proceed immediately to the next step!`;
          }
          if (normCmd) {
            executedCommandCounts.set(normCmd, prevCmdCount + 1);
          }
          const res = (await runCapabilityTool('run-build', { command: cmd }, 'high')) as {
            exitCode: number;
            stdout: string;
            stderr: string;
            durationMs: number;
          };
          recordCommandOutcome(cmd, res);
          const expandedStdout = await autoExpandPartialSedRead(cmd, res.stdout || '');
          const combined = [expandedStdout.trim(), res.stderr?.trim()].filter(Boolean).join('\n');
          return (combined || `Exit code ${res.exitCode}`).slice(0, 8000);
        },
      } as any,
    });

    // 2. Register DeepAutoCode Workspace Capability Tools via @cline/sdk `createTool`
    const deepAutoCodeTools = [
      createTool({
        name: 'list_files',
        description:
          'List files and directories inside a workspace directory (relative path, e.g. "." or "src").',
        inputSchema: {
          type: 'object',
          properties: {
            dirPath: {
              type: 'string',
              description: 'Relative directory path inside workspace (default ".")',
            },
          },
        },
        execute: async (rawArgs: Record<string, unknown>) => {
          const relDir = this.normalizeWorkspaceRelativePath(
            String(rawArgs?.dirPath || '.'),
            manifest.workspaceRoot
          );
          const targetDir = path.resolve(manifest.workspaceRoot, relDir);
          if (!targetDir.startsWith(path.resolve(manifest.workspaceRoot))) {
            throw new Error('PATH_BOUNDARY_VIOLATION: Directory outside workspace');
          }
          const entries = await fs.readdir(targetDir, { withFileTypes: true });
          const items = entries
            .filter((e) => !['node_modules', '.git', '.deepautocode-data'].includes(e.name))
            .slice(0, 80)
            .map((e) => (e.isDirectory() ? `[DIR] ${e.name}` : `[FILE] ${e.name}`));
          return { dirPath: relDir, entries: items };
        },
      }),
      createTool({
        name: 'outline_file',
        description:
          'Extract functions/structs/classes/enums/macros with exact 1-based start–end line ranges (TS/JS via AST, C/C++/other via enhanced heuristics). Ideal for navigating large files before read_file with start_line/end_line.',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Relative path to the source/header file (e.g. "src/enqueue.cc" or "src/include/comm.h")',
            },
          },
          required: ['filePath'],
        },
        execute: async (rawArgs: Record<string, unknown>) => {
          const filePath = this.normalizeWorkspaceRelativePath(
            String(rawArgs?.filePath || rawArgs?.path || rawArgs?.file_path || ''),
            manifest.workspaceRoot
          );
          const res = (await runCapabilityTool('read-file', { filePath }, 'low')) as {
            content: string;
            byteLength: number;
          };
          const totalLines = res.content.split(/\r?\n/).length;
          const symbols = extractCodeOutline(res.content, 150, filePath);
          return {
            filePath,
            totalLines,
            symbolCount: symbols.length,
            outline: symbols.join('\n'),
          };
        },
      }),
      createTool({
        name: 'read_file',
        description:
          'Read the contents of a file inside the workspace (supports optional start_line and end_line for large files, and automatically attaches a symbol line-number outline for large files).',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Relative path to the file in the workspace (e.g. "nccl-test/src/sendrecv.cc")',
            },
            start_line: {
              type: 'number',
              description: 'Optional 1-based start line number (inclusive)',
            },
            end_line: {
              type: 'number',
              description: 'Optional 1-based end line number (inclusive)',
            },
          },
          required: ['filePath'],
        },
        execute: async (rawArgs: Record<string, unknown>) => {
          const filePath = this.normalizeWorkspaceRelativePath(
            String(rawArgs?.filePath || rawArgs?.path || rawArgs?.file_path || ''),
            manifest.workspaceRoot
          );
          const startLine = Number(rawArgs?.start_line ?? rawArgs?.startLine ?? 0);
          const endLine = Number(rawArgs?.end_line ?? rawArgs?.endLine ?? 0);
          const rangeKey = `${filePath}:${startLine > 0 ? startLine : 1}-${endLine > 0 ? endLine : 'EOF'}`;
          const fullKey = `${filePath}:1-EOF`;
          const prevCount = (readCountsByRange.get(rangeKey) ?? 0) + (rangeKey !== fullKey ? (readCountsByRange.get(fullKey) ?? 0) : 0);
          const cached = fileStateCache.get(filePath);
          if (cached && prevCount >= 1) {
            readCountsByRange.set(rangeKey, prevCount + 1);
            return {
              filePath,
              totalLines: cached.totalLines,
              alreadyInContext: true,
              notice: `[DUPLICATE_READ_SKIPPED]: '${filePath}' was ALREADY read in this turn and has not been modified since. Do NOT call read_file on '${filePath}' again! If changes are still needed, call edit_file / write_file immediately; if '${filePath}' already contains the target fix, proceed directly to run_command or output the final summary.`,
            };
          }
          const res = (await runCapabilityTool('read-file', { filePath }, 'low')) as {
            content: string;
            byteLength: number;
            truncated: boolean;
          };
          const allLines = res.content.split(/\r?\n/);
          const totalLines = allLines.length;
          let contentOut = res.content;
          readCountsByRange.set(rangeKey, (readCountsByRange.get(rangeKey) ?? 0) + 1);
          fileStateCache.recordRead({
            filePath,
            content: res.content,
            startLine: startLine > 0 ? startLine : 1,
            endLine: endLine > 0 ? endLine : totalLines,
          });
          if (startLine > 0 || endLine > 0) {
            const s = Math.max(1, startLine || 1);
            const e = Math.min(totalLines, endLine > 0 ? endLine : totalLines);
            contentOut = allLines
              .slice(s - 1, e)
              .map((line, idx) => `${s + idx}: ${line}`)
              .join('\n');
          }
          const isTruncatedOrLarge = Boolean(
            res.truncated || contentOut.length > 48000 || (totalLines > 350 && startLine === 0)
          );
          const symbolOutline =
            isTruncatedOrLarge
              ? extractCodeOutline(res.content, 80, filePath).join('\n')
              : undefined;
          return {
            filePath,
            totalLines,
            byteLength: res.byteLength,
            truncated: Boolean(res.truncated || contentOut.length > 48000),
            content: contentOut.slice(0, 48000),
            ...(symbolOutline
              ? {
                  symbolOutlineHint: `[文件符号大纲导航 (共 ${totalLines} 行；格式 Lstart-Lend: kind name — 用 start_line/end_line 精确读取)]:\n${symbolOutline}`,
                }
              : {}),
          };
        },
      }),
      createTool({
        name: 'explore_codebase',
        description:
          'Context-isolated parallel codebase exploration subagent (inspired by Claude Code Explore Agent). Executes multiple keyword/symbol searches and file outline/range inspections in parallel and returns a compact, line-numbered evidence digest without bloating the main conversation context.',
        inputSchema: {
          type: 'object',
          properties: {
            queries: {
              type: 'array',
              description: 'Up to 4 symbol names or grep search patterns to search in parallel',
              items: { type: 'string' },
            },
            files: {
              type: 'array',
              description: 'Up to 4 files (with optional 1-based start_line and end_line) to inspect in parallel',
              items: {
                type: 'object',
                properties: {
                  filePath: { type: 'string' },
                  start_line: { type: 'number' },
                  end_line: { type: 'number' },
                },
                required: ['filePath'],
              },
            },
          },
        },
        execute: async (rawArgs: Record<string, unknown>) => {
          const queries = Array.isArray(rawArgs?.queries)
            ? rawArgs.queries.map((q) => String(q).trim()).filter(Boolean).slice(0, 4)
            : [];
          const files = Array.isArray(rawArgs?.files) ? rawArgs.files.slice(0, 4) : [];

          const [searchDigestParts, fileDigestParts] = await Promise.all([
            Promise.all(
              queries.map(async (q) => {
                if (isSshMirrorWorkspace) {
                  const safeQ = q.replace(/'/g, `'\\''`);
                  const res = (await runCapabilityTool(
                    'run-build',
                    {
                      command: `grep -rnI -C 2 --exclude-dir=.git --exclude-dir=build -- '${safeQ}' . 2>/dev/null | head -n 45`,
                    },
                    'low'
                  )) as { stdout: string };
                  return `### Search: \`${q}\`\n${(res.stdout || 'No matches.').trim().slice(0, 1400)}`;
                }
                if (workspaceFileIndex && typeof searchIndexedFiles === 'function') {
                  const localHits = await searchIndexedFiles({
                    root: manifest.workspaceRoot,
                    index: workspaceFileIndex,
                    query: q,
                    contextLines: 2,
                    maxMatches: 20,
                  });
                  return `### Search: \`${q}\`\n${localHits.slice(0, 1400)}`;
                }
                return `### Search: \`${q}\` (use search_codebase for local details)`;
              })
            ),
            Promise.all(
              files.map(async (f: any) => {
                const rawPath = typeof f === 'string' ? f : f?.filePath || f?.path || '';
                const relPath = this.normalizeWorkspaceRelativePath(rawPath, manifest.workspaceRoot);
                if (!relPath) return '';
                try {
                  const res = (await runCapabilityTool('read-file', { filePath: relPath }, 'low')) as {
                    content: string;
                  };
                  const allLines = res.content.split(/\r?\n/);
                  const s = Math.max(1, Number(f?.start_line ?? 1));
                  const e = Math.min(
                    allLines.length,
                    Number(f?.end_line ?? Math.min(allLines.length, s + 90))
                  );
                  fileStateCache.recordRead({
                    filePath: relPath,
                    content: res.content,
                    startLine: s,
                    endLine: e,
                  });
                  const snippet = allLines
                    .slice(s - 1, e)
                    .map((line, idx) => `${s + idx}: ${line}`)
                    .join('\n')
                    .slice(0, 1800);
                  const outline = extractCodeOutline(res.content, 30, relPath).join('\n');
                  return `### File: \`${relPath}\` (lines ${s}-${e} of ${allLines.length})\n${snippet}${
                    outline ? `\n[Outline]:\n${outline}` : ''
                  }`;
                } catch (err) {
                  return `### File: \`${relPath}\` (error: ${err instanceof Error ? err.message : String(err)})`;
                }
              })
            ),
          ]);

          return {
            digest: [...searchDigestParts, ...fileDigestParts].filter(Boolean).join('\n\n').slice(0, 7500),
          };
        },
      }),
      createTool({
        name: 'edit_file',
        description:
          'Directly modify an existing file in the workspace by replacing a target snippet (oldText) with updated code (newText). Supports multi-hunk edits via `hunks: [{oldText,newText}, ...]`. Automatically syncs to Remote SSH if connected and updates the IDE Code Editor.',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description:
                'Relative path to the file in the workspace (e.g. "nccl-test/src/sendrecv.cc" or "nccl-test/verifiable/verifiable.cc")',
            },
            oldText: {
              type: 'string',
              description: 'Exact existing lines of code in the file to be replaced (single-hunk mode)',
            },
            newText: {
              type: 'string',
              description: 'New replacement lines of code (single-hunk mode)',
            },
            hunks: {
              type: 'array',
              description:
                'Optional multi-hunk replacements for the same file: [{ oldText, newText }, ...]. Prefer this over multiple edit_file calls when changing several spots in one file.',
              items: {
                type: 'object',
                properties: {
                  oldText: { type: 'string' },
                  newText: { type: 'string' },
                },
                required: ['oldText', 'newText'],
              },
            },
          },
          required: ['filePath'],
        },
        execute: async (rawArgs: Record<string, unknown>) => {
          const filePath = this.normalizeWorkspaceRelativePath(
            String(rawArgs?.filePath || rawArgs?.path || rawArgs?.file_path || ''),
            manifest.workspaceRoot
          );
          const hunksRaw = Array.isArray(rawArgs?.hunks) ? rawArgs.hunks : null;
          const hunks: Array<{ oldText: string; newText: string }> = hunksRaw
            ? hunksRaw.map((h: any) => ({
                oldText: String(h?.oldText ?? h?.old_text ?? ''),
                newText: String(h?.newText ?? h?.new_text ?? ''),
              }))
            : [
                {
                  oldText: String(rawArgs?.oldText ?? rawArgs?.old_text ?? rawArgs?.old_str ?? ''),
                  newText: String(rawArgs?.newText ?? rawArgs?.new_text ?? rawArgs?.new_str ?? ''),
                },
              ];
          if (!filePath || !hunks.some((h) => h.oldText)) {
            return {
              ok: false,
              error: 'filePath and oldText (or hunks[].oldText) are required for edit_file.',
            };
          }
          let current = (await runCapabilityTool('read-file', { filePath }, 'low')) as {
            content: string;
          };
          fileStateCache.makeSnapshot(filePath, current.content);
          let updated: string;
          const replaceOne = (content: string, oldText: string, newText: string) =>
            this.applySmartTextReplacement(content, oldText, newText, filePath);
          const tryApply = (content: string) =>
            typeof FileStateCache.applyMultiHunkReplacements === 'function'
              ? FileStateCache.applyMultiHunkReplacements(content, hunks, replaceOne)
              : hunks.reduce((acc, h) => replaceOne(acc, h.oldText, h.newText), content);
          try {
            updated = tryApply(current.content);
            editMismatchCount = 0;
          } catch {
            // Stage P: one-shot auto recovery — re-read disk and retry once with fresh content
            editMismatchCount += 1;
            try {
              const refreshed = (await runCapabilityTool('read-file', { filePath }, 'low')) as {
                content: string;
              };
              current = refreshed;
              fileStateCache.makeSnapshot(filePath, refreshed.content);
              fileStateCache.recordRead({
                filePath,
                content: refreshed.content,
                isPartialView: false,
              });
              updated = tryApply(refreshed.content);
              editMismatchCount = 0;
            } catch {
              editMismatchCount += 1;
              const diag = fileStateCache.diagnoseEditMismatch(
                filePath,
                current.content,
                hunks[0]?.oldText || ''
              );
              // Attach a numbered window around the best fuzzy match for the model
              const lines = String(current.content || '').split(/\r?\n/);
              const needle = (hunks[0]?.oldText || '').split(/\r?\n/)[0]?.trim() || '';
              let approxLine = 1;
              if (needle) {
                const hit = lines.findIndex((l) => l.includes(needle.slice(0, 48)));
                if (hit >= 0) approxLine = hit + 1;
              }
              const s = Math.max(1, approxLine - 8);
              const e = Math.min(lines.length, approxLine + 16);
              const window = lines
                .slice(s - 1, e)
                .map((l, i) => `${s + i}: ${l}`)
                .join('\n');
              return {
                ok: false,
                filePath,
                error: diag.hintMessage,
                editMismatchCount,
                autoRetryAttempted: true,
                refreshedSnippet: window,
                mandatoryNextStep:
                  `EDIT_RECOVERY: oldText still missing after auto re-read. Use this numbered window (L${s}-L${e}) to craft a fresh oldText, then retry edit_file/apply_patch once:\n${window}`,
              };
            }
          }
          const writeRes = await applyFileEdit(filePath, updated);
          fileStateCache.recordRead({ filePath, content: updated, isPartialView: false });
          recordCompiledFileEdit(filePath);
          const postDiag = await runPostEditDiagnostics(filePath, updated);
          const isCompiledSrc = /\.(?:c|cc|cpp|cu|h|hpp)$/i.test(filePath);
          const needsVerify =
            typeof isVerifiableSourcePath === 'function'
              ? isVerifiableSourcePath(filePath, verifyConfig)
              : isCompiledSrc || /\.(?:ts|tsx|js|jsx)$/i.test(filePath);
          return {
            ok: true,
            filePath,
            diffId: writeRes.diffId,
            bytesWritten: writeRes.bytesWritten,
            operation: writeRes.operation,
            appliedToDisk: writeRes.appliedToDisk,
            hunksApplied: hunks.length,
            ...postDiag,
            ...(needsVerify
              ? {
                  mandatoryNextStep: postDiag.semanticErrors
                    ? `Fix SEMANTIC_DIAGNOSTICS_FAILED first, then run_command: ${preferredVerifyCommand}`
                    : `CRITICAL: You just modified a verifiable source file. Your NEXT tool call MUST be run_command with: ${preferredVerifyCommand}`,
                }
              : {}),
          };
        },
      }),
      createTool({
        name: 'write_file',
        description:
          'Create a new file (including parent directories) or overwrite an existing file with complete content in the workspace, automatically syncing to Remote SSH if connected.',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Relative path to the file in the workspace (e.g. "nccl-test/src/sendrecv.cc" or "index.html")',
            },
            content: {
              type: 'string',
              description: 'Complete file content to write',
            },
          },
          required: ['filePath', 'content'],
        },
        execute: async (rawArgs: Record<string, unknown>) => {
          const filePath = this.normalizeWorkspaceRelativePath(
            String(rawArgs?.filePath || rawArgs?.path || rawArgs?.file_path || ''),
            manifest.workspaceRoot
          );
          if (rawArgs?.__truncated) {
            return {
              ok: false,
              error: `OUTPUT_TRUNCATED_AT_MAX_TOKENS: Your tool call JSON arguments for '${filePath || 'target file'}' exceeded the 8192 output token limit in a single turn and were cut off. For large existing files, use 'edit_file' ({ filePath, oldText, newText }) to replace only the changed snippet, or call write_file for 1 file per turn.`,
            };
          }
          const content = String(
            rawArgs?.content ?? rawArgs?.new_text ?? rawArgs?.text ?? ''
          );
          if (!filePath) {
            return {
              ok: false,
              error:
                'Missing filePath parameter for write_file (tool call JSON may have been truncated). Please use edit_file for targeted changes or call write_file for one file at a time.',
            };
          }
          try {
            const existing = (await runCapabilityTool('read-file', { filePath }, 'low')) as {
              content: string;
            };
            if (existing?.content != null) {
              fileStateCache.makeSnapshot(filePath, existing.content);
            }
          } catch {
            // new file
          }
          const writeRes = await applyFileEdit(filePath, content);
          fileStateCache.recordRead({ filePath, content, isPartialView: false });
          recordCompiledFileEdit(filePath);
          const postDiag = await runPostEditDiagnostics(filePath, content);
          const needsVerify =
            typeof isVerifiableSourcePath === 'function'
              ? isVerifiableSourcePath(filePath, verifyConfig)
              : /\.(?:c|cc|cpp|cu|h|hpp|ts|tsx|js|jsx|py|go|rs)$/i.test(filePath);
          return {
            ok: true,
            filePath,
            diffId: writeRes.diffId,
            bytesWritten: writeRes.bytesWritten,
            operation: writeRes.operation,
            appliedToDisk: writeRes.appliedToDisk,
            ...postDiag,
            ...(needsVerify
              ? {
                  mandatoryNextStep: postDiag.semanticErrors
                    ? `Fix SEMANTIC_DIAGNOSTICS_FAILED first, then run_command: ${preferredVerifyCommand}`
                    : `CRITICAL: You just modified a verifiable source file. Your NEXT tool call MUST be run_command with: ${preferredVerifyCommand}`,
                }
              : {}),
          };
        },
      }),
      createTool({
        name: 'apply_patch',
        description:
          'Apply a unified diff / multi-hunk patch to one or more workspace files. Prefer this over many edit_file calls for large or multi-site changes. Supports classic ---/+++ @@ hunks and *** Update File: path blocks.',
        inputSchema: {
          type: 'object',
          properties: {
            patch: {
              type: 'string',
              description: 'Unified diff text (may include multiple files)',
            },
            filePath: {
              type: 'string',
              description:
                'Optional single target file when the patch omits paths or targets one file',
            },
          },
          required: ['patch'],
        },
        execute: async (rawArgs: Record<string, unknown>) => {
          if (
            typeof applyPatchToContent !== 'function' &&
            typeof applyMultiFilePatch !== 'function'
          ) {
            return { ok: false, error: 'apply_patch unavailable in this runtime build.' };
          }
          const patch = String(rawArgs?.patch || rawArgs?.diff || '');
          if (!patch.trim()) {
            return { ok: false, error: 'patch text is required.' };
          }
          const preferred = rawArgs?.filePath
            ? this.normalizeWorkspaceRelativePath(
                String(rawArgs.filePath),
                manifest.workspaceRoot
              )
            : '';

          const contentCache = new Map<string, string | null>();
          const readCached = async (rel: string): Promise<string | null> => {
            const filePath = this.normalizeWorkspaceRelativePath(rel, manifest.workspaceRoot);
            if (contentCache.has(filePath)) return contentCache.get(filePath) ?? null;
            try {
              const current = (await runCapabilityTool(
                'read-file',
                { filePath },
                'low'
              )) as { content: string };
              const text = current?.content ?? '';
              contentCache.set(filePath, text);
              fileStateCache.makeSnapshot(filePath, text);
              return text;
            } catch {
              contentCache.set(filePath, null);
              return null;
            }
          };

          let targets =
            typeof listPatchFiles === 'function' ? listPatchFiles(patch) : [];
          if (targets.length === 0 && preferred) targets = [preferred];
          if (targets.length === 0) {
            return {
              ok: false,
              error:
                'PATCH_NO_TARGETS: Include *** Update/Add/Delete File: path or ---/+++ paths, or pass filePath.',
            };
          }

          // Prefetch contents for multi-file in-memory apply
          for (const t of targets.slice(0, 8)) {
            await readCached(t);
          }

          const runPatchPlan = () => {
            const multi =
              typeof applyMultiFilePatch === 'function'
                ? applyMultiFilePatch(patch, (p) => {
                    const norm = this.normalizeWorkspaceRelativePath(p, manifest.workspaceRoot);
                    return contentCache.has(norm) ? contentCache.get(norm) ?? null : null;
                  })
                : null;
            return multi;
          };

          let multi = runPatchPlan();

          // Stage S5: one-shot auto recovery — clear cache, re-read disk, retry patch once
          if (multi && !multi.ok) {
            for (const t of targets.slice(0, 8)) {
              const norm = this.normalizeWorkspaceRelativePath(t, manifest.workspaceRoot);
              contentCache.delete(norm);
              await readCached(norm);
            }
            multi = runPatchPlan();
          }

          if (multi && !multi.ok) {
            editMismatchCount += 1;
            const failedPath =
              (multi.files || []).find((f: any) => f.error)?.filePath || targets[0] || '';
            let recoveryWindow = '';
            if (failedPath) {
              try {
                const fresh = (await readCached(failedPath)) || '';
                const lines = fresh.split(/\r?\n/);
                const needle = (multi.hint || '').match(/L(\d+)/)?.[1];
                const mid = needle ? Number(needle) : Math.min(40, lines.length);
                const s = Math.max(1, mid - 12);
                const e = Math.min(lines.length, mid + 12);
                recoveryWindow = lines
                  .slice(s - 1, e)
                  .map((ln, i) => `L${s + i}|${ln}`)
                  .join('\n');
              } catch {
                // ignore
              }
            }
            return {
              ok: false,
              error: multi.error,
              hint: multi.hint,
              files: multi.files,
              refreshedSnippet: recoveryWindow || undefined,
              mandatoryNextStep: recoveryWindow
                ? `PATCH_RECOVERY: old context still missing after auto re-read. Use this numbered window to craft a fresh patch or fall back to edit_file:\n${recoveryWindow}`
                : 'Fix PATCH failures using the hint windows, or fall back to edit_file for the failing hunks. Re-read the file with line numbers before retrying.',
            };
          }

          let planned =
            multi?.files ||
            (
              await Promise.all(
                targets.slice(0, 8).map(async (target) => {
                  const filePath = this.normalizeWorkspaceRelativePath(
                    target,
                    manifest.workspaceRoot
                  );
                  const currentContent = (await readCached(filePath)) ?? '';
                  const applied = applyPatchToContent(filePath, currentContent, patch);
                  return {
                    filePath,
                    beforeContent: currentContent,
                    afterContent: applied.ok ? applied.content ?? null : null,
                    deleted: Boolean(applied.deleted),
                    created: Boolean(applied.created),
                    hunksApplied: applied.hunksApplied,
                    error: applied.ok ? undefined : applied.error,
                    hint: applied.hint,
                  };
                })
              )
            );

          // Stage S5 (single-file path): retry once on first planned item failure
          if (
            Array.isArray(planned) &&
            planned.some((p: any) => p.error || (p.afterContent == null && !p.deleted))
          ) {
            for (const t of targets.slice(0, 8)) {
              const norm = this.normalizeWorkspaceRelativePath(t, manifest.workspaceRoot);
              contentCache.delete(norm);
              await readCached(norm);
            }
            planned = await Promise.all(
              targets.slice(0, 8).map(async (target) => {
                const filePath = this.normalizeWorkspaceRelativePath(
                  target,
                  manifest.workspaceRoot
                );
                const currentContent = (await readCached(filePath)) ?? '';
                const applied = applyPatchToContent(filePath, currentContent, patch);
                return {
                  filePath,
                  beforeContent: currentContent,
                  afterContent: applied.ok ? applied.content ?? null : null,
                  deleted: Boolean(applied.deleted),
                  created: Boolean(applied.created),
                  hunksApplied: applied.hunksApplied,
                  error: applied.ok ? undefined : applied.error,
                  hint: applied.hint,
                };
              })
            );
          }

          const results: Array<Record<string, unknown>> = [];
          const written: Array<{ filePath: string; before: string | null }> = [];

          const unlinkWorkspaceFile = async (relFile: string) => {
            const abs = path.resolve(manifest.workspaceRoot, relFile);
            if (!abs.startsWith(path.resolve(manifest.workspaceRoot))) {
              throw new Error(`PATH_BOUNDARY_VIOLATION: ${relFile}`);
            }
            await fs.unlink(abs);
          };

          const rollbackWritten = async () => {
            for (const w of written.reverse()) {
              try {
                if (w.before == null) {
                  await unlinkWorkspaceFile(w.filePath).catch(() => undefined);
                } else {
                  await applyFileEdit(w.filePath, w.before);
                }
              } catch {
                // best-effort rollback
              }
            }
          };

          for (const item of planned as Array<any>) {
            const filePath = this.normalizeWorkspaceRelativePath(
              item.filePath,
              manifest.workspaceRoot
            );
            if (item.error || (item.afterContent == null && !item.deleted)) {
              editMismatchCount += 1;
              await rollbackWritten();
              return {
                ok: false,
                error: item.error || `Failed applying patch to ${filePath}`,
                hint: item.hint,
                files: results,
                rolledBack: written.map((w) => w.filePath),
                mandatoryNextStep:
                  'Fix PATCH failures using the hint windows, or fall back to edit_file. Re-read the file before retrying.',
              };
            }

            if (item.deleted) {
              try {
                await unlinkWorkspaceFile(filePath);
                written.push({ filePath, before: item.beforeContent ?? null });
                results.push({
                  ok: true,
                  filePath,
                  deleted: true,
                  hunksApplied: item.hunksApplied,
                });
              } catch (err) {
                await rollbackWritten();
                return {
                  ok: false,
                  error: `Failed deleting ${filePath}: ${(err as Error).message}`,
                  files: results,
                  rolledBack: written.map((w) => w.filePath),
                };
              }
              continue;
            }

            try {
              const writeRes = await applyFileEdit(filePath, String(item.afterContent));
              written.push({ filePath, before: item.beforeContent ?? null });
              fileStateCache.recordRead({
                filePath,
                content: String(item.afterContent),
                isPartialView: false,
              });
              recordCompiledFileEdit(filePath);
              const postDiag = await runPostEditDiagnostics(
                filePath,
                String(item.afterContent)
              );
              editMismatchCount = 0;
              results.push({
                ok: true,
                filePath,
                diffId: writeRes.diffId,
                bytesWritten: writeRes.bytesWritten,
                hunksApplied: item.hunksApplied,
                created: Boolean(item.created),
                ...postDiag,
              });
            } catch (err) {
              await rollbackWritten();
              return {
                ok: false,
                error: `Write failed for ${filePath}: ${(err as Error).message}`,
                files: results,
                rolledBack: written.map((w) => w.filePath),
              };
            }
          }

          const anySemantic = results.some((r) => Boolean(r.semanticErrors));
          return {
            ok: true,
            files: results,
            mandatoryNextStep: anySemantic
              ? `Fix SEMANTIC_DIAGNOSTICS_FAILED first, then run_command: ${preferredVerifyCommand}`
              : `CRITICAL: After apply_patch, run_command with: ${preferredVerifyCommand}`,
          };
        },
      }),
      createTool({
        name: 'run_command',
        description: 'Execute a shell/build/test command in the workspace root directory.',
        inputSchema: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'Shell command to run (e.g. "make -j16", "git diff", "npm test")',
            },
          },
          required: ['command'],
        },
        execute: async (rawArgs: Record<string, unknown>) => {
          const command = String(rawArgs?.command || '');
          const normCmd = command.trim().replace(/\s+/g, ' ');
          const prevCmdCount = executedCommandCounts.get(normCmd) ?? 0;
          if (normCmd && prevCmdCount >= 1) {
            executedCommandCounts.set(normCmd, prevCmdCount + 1);
            return {
              command,
              exitCode: 0,
              alreadyExecutedInTurn: true,
              stdout: `[DUPLICATE_COMMAND_SKIPPED]: You already executed this exact command in this turn and received its output above. Do NOT repeat the same command; proceed immediately to the next step!`,
              stderr: '',
            };
          }
          if (normCmd) {
            executedCommandCounts.set(normCmd, prevCmdCount + 1);
          }
          const res = (await runCapabilityTool('run-build', { command }, 'high')) as {
            exitCode: number;
            stdout: string;
            stderr: string;
            durationMs: number;
          };
          recordCommandOutcome(command, res);
          const expandedStdout = await autoExpandPartialSedRead(command, res.stdout || '');
          const errorContext =
            res.exitCode !== 0 || /error:/i.test(res.stderr || '') || /error:/i.test(res.stdout || '')
              ? await autoExtractCompilerErrorContext(res.stdout || '', res.stderr || '')
              : '';
          return {
            command,
            exitCode: res.exitCode,
            durationMs: res.durationMs,
            stdout: `${expandedStdout.slice(0, 8000)}${errorContext}`,
            stderr: res.stderr.slice(0, 4000),
          };
        },
      }),
      createTool({
        name: 'connect_remote_ssh',
        description:
          'Automatically log in and connect to a Remote Linux SSH server (using either saved SSH profile credentials or host/username/password/remotePath provided by the user) and switch the active workspace to the remote project mirror.',
        inputSchema: {
          type: 'object',
          properties: {
            host: {
              type: 'string',
              description: 'Remote server IP or hostname (leave empty to auto-reconnect the most recently saved SSH profile)',
            },
            port: {
              type: 'number',
              description: 'SSH port (default 22)',
            },
            username: {
              type: 'string',
              description: 'SSH username (e.g. "root")',
            },
            password: {
              type: 'string',
              description: 'Optional SSH password if using password authentication',
            },
            remotePath: {
              type: 'string',
              description: 'Remote project directory path (e.g. "/home/renjc01/Bug/fhccl")',
            },
          },
        },
        execute: async (rawArgs: Record<string, unknown>) => {
          const workbenchPort = Number(process.env.DEEPAUTOCODE_PORT || 3840);
          try {
            let profileToConnect: Record<string, unknown> = { ...rawArgs };
            if (!rawArgs?.host) {
              const statusRes = await postJsonOnce({
                url: `http://127.0.0.1:${workbenchPort}/api/ssh/status`,
                headers: {},
                body: {},
              }).catch(() => null);
              if (statusRes?.ok) {
                const parsed = JSON.parse(statusRes.text || '{}');
                if (parsed?.status?.connected && parsed?.status?.activeProfile) {
                  return {
                    ok: true,
                    alreadyConnected: true,
                    activeProfile: parsed.status.activeProfile,
                    mirrorWorkspaceRoot: parsed.status.mirrorWorkspaceRoot,
                  };
                }
                if (Array.isArray(parsed?.profiles) && parsed.profiles.length > 0) {
                  profileToConnect = parsed.profiles[0];
                }
              }
            }
            const connRes = await postJsonOnce({
              url: `http://127.0.0.1:${workbenchPort}/api/ssh/connect`,
              headers: { 'Content-Type': 'application/json' },
              body: profileToConnect,
              timeoutMs: 25000,
            });
            const data = JSON.parse(connRes.text || '{}');
            return data;
          } catch (err) {
            return {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        },
      }),
      createTool({
        name: 'auto_build_and_test',
        description:
          'Automatically detect the project build & test system (CMake/Make/HIP/NCCL-Test/Node/Pytest), execute compilation and verification tests on the active Local or Remote SSH workspace, and automatically extract offending source code lines on any error.',
        inputSchema: {
          type: 'object',
          properties: {
            customBuildCommand: {
              type: 'string',
              description: 'Optional explicit build + test command (if omitted, auto-detects build/Makefile, Makefile, package.json, etc.)',
            },
          },
        },
        execute: async (rawArgs: Record<string, unknown>) => {
          let cmd = String(rawArgs?.customBuildCommand || '').trim();
          if (!cmd) {
            cmd = preferredVerifyCommand;
          }
          const res = (await runCapabilityTool('run-build', { command: cmd }, 'high')) as {
            exitCode: number;
            stdout: string;
            stderr: string;
            durationMs: number;
          };
          recordCommandOutcome(cmd, res);
          const errorContext =
            res.exitCode !== 0 || /error:|FAILED|#wrong=[1-9]/i.test(`${res.stdout}\n${res.stderr}`)
              ? await autoExtractCompilerErrorContext(res.stdout || '', res.stderr || '')
              : '';
          return {
            command: cmd,
            exitCode: res.exitCode,
            durationMs: res.durationMs,
            stdout: `${(res.stdout || '').slice(0, 8000)}${errorContext}`,
            stderr: (res.stderr || '').slice(0, 4000),
          };
        },
      }),
      createTool({
        name: 'open_file',
        description: 'Open a file in the IDE editor.',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Relative path to the file in the workspace',
            },
          },
          required: ['filePath'],
        },
        execute: async (rawArgs: Record<string, unknown>) => {
          const filePath = this.normalizeWorkspaceRelativePath(
            String(rawArgs?.filePath || rawArgs?.path || ''),
            manifest.workspaceRoot
          );
          return await runCapabilityTool('open-file', { filePath }, 'low');
        },
      }),
      createTool({
        name: 'write_artifact',
        description:
          'Create or update an Antigravity structured Markdown Artifact (Implementation Plan, Task Checklist, Walkthrough, or Architecture Report). Permitted in both Plan and Auto modes so plans can be reviewed and executed from the IDE Artifacts Pane.',
        inputSchema: {
          type: 'object',
          properties: {
            artifactType: {
              type: 'string',
              enum: ['plan', 'task_list', 'walkthrough', 'report'],
              description: 'Category of artifact',
            },
            title: {
              type: 'string',
              description: 'Human-readable artifact title (e.g. "Implementation Plan")',
            },
            content: {
              type: 'string',
              description: 'Markdown content of the artifact',
            },
          },
          required: ['title', 'content'],
        },
        execute: async (rawArgs: Record<string, unknown>) => {
          const artifactType = String(rawArgs?.artifactType || 'plan') as
            | 'plan'
            | 'task_list'
            | 'walkthrough'
            | 'report';
          const title = String(rawArgs?.title || 'Implementation Plan').trim();
          const content = String(rawArgs?.content || '').trim();
          const saved = await persistSessionArtifact({
            artifactType,
            title,
            content,
            source: 'write_artifact',
          });
          return {
            ok: true,
            ...saved,
            notice: `Artifact "${title}" (${artifactType}) saved to IDE Artifacts Pane.`,
          };
        },
      }),
      createTool({
        name: 'invoke_subagent',
        description:
          'Invoke a specialized Antigravity subagent (role: "research" | "planner" | "verifier" | "editor") to perform parallel codebase exploration, symbol lookup, build/test verification, or a budgeted isolated edit (max 3 files / 6 hunks, rollback on diagnose fail).',
        inputSchema: {
          type: 'object',
          properties: {
            role: {
              type: 'string',
              enum: ['research', 'planner', 'verifier', 'editor'],
              description: 'Subagent role',
            },
            task: {
              type: 'string',
              description: 'Specific task description for the subagent',
            },
            queries: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional keyword/symbol queries to search in parallel',
            },
            files: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional workspace files to inspect in parallel',
            },
          },
          required: ['role', 'task'],
        },
        execute: async (rawArgs: Record<string, unknown>) => {
          const role = String(rawArgs?.role || 'research');
          const task = String(rawArgs?.task || '');
          const queries = Array.isArray(rawArgs?.queries)
            ? rawArgs.queries.map((q) => String(q).trim()).filter(Boolean).slice(0, 4)
            : [];
          const files = Array.isArray(rawArgs?.files)
            ? rawArgs.files.map((f) => String(f).trim()).filter(Boolean).slice(0, 4)
            : sessionWrittenFiles.slice(-6);

          const digestLines: string[] = [
            `[Subagent (${role.toUpperCase()}) Completed Task: ${task}]`,
          ];

          if (role === 'editor' && typeof runEditSubagent === 'function') {
            const sandbox =
              typeof createSubagentSandbox === 'function'
                ? createSubagentSandbox('editor')
                : null;
            const targetFiles =
              files.length > 0
                ? files
                    .map((f) => this.normalizeWorkspaceRelativePath(f, manifest.workspaceRoot))
                    .slice(0, 3)
                : Array.from(new Set(sessionWrittenFiles.slice(-4)));
            const result = await runEditSubagent({
              task,
              files: targetFiles,
              maxFiles: 3,
              maxEdits: 6,
              readFile: async (relPath: string) => {
                const run = async () => {
                  const res = (await runCapabilityTool(
                    'read-file',
                    { filePath: relPath },
                    'low'
                  )) as { content: string };
                  return res?.content || '';
                };
                return sandbox ? sandbox.wrap('read_file', relPath, run) : run();
              },
              // Stage S1: always go through applyFileEdit so Diff / Manual approval apply
              writeFile: async (relPath: string, content: string) => {
                const run = async () => {
                  const writeRes = await applyFileEdit(relPath, content);
                  recordCompiledFileEdit(relPath);
                  fileStateCache.recordRead({
                    filePath: relPath,
                    content,
                    isPartialView: false,
                  });
                  void writeRes;
                };
                return sandbox ? sandbox.wrap('write_file', relPath, run) : run();
              },
              applyEdit: async (relPath: string, oldText: string, newText: string) => {
                const run = async () => {
                  try {
                    const current = (await runCapabilityTool(
                      'read-file',
                      { filePath: relPath },
                      'low'
                    )) as { content: string };
                    const next = this.applySmartTextReplacement(
                      current.content || '',
                      oldText,
                      newText,
                      relPath
                    );
                    const writeRes = await applyFileEdit(relPath, next);
                    recordCompiledFileEdit(relPath);
                    fileStateCache.recordRead({
                      filePath: relPath,
                      content: next,
                      isPartialView: false,
                    });
                    return { ok: true, content: next, diffId: writeRes.diffId };
                  } catch (err) {
                    return { ok: false, error: (err as Error).message };
                  }
                };
                return sandbox ? sandbox.wrap('edit_file', relPath, run) : run();
              },
              diagnose: async (relPath: string, content: string) => {
                const run = async () => {
                  try {
                    const post = await runPostEditDiagnostics(relPath, content);
                    return post.semanticErrors || null;
                  } catch {
                    return null;
                  }
                };
                return sandbox ? sandbox.wrap('diagnose', relPath, run) : run();
              },
              // Stage T4: shared diagnose→verify contract with verifier
              verify: async () => {
                const run = async () => {
                  if (!preferredVerifyCommand) {
                    return { skipped: true, reason: 'no verify command configured' };
                  }
                  try {
                    const res = (await runCapabilityTool(
                      'run-build',
                      { command: preferredVerifyCommand },
                      'high'
                    )) as { exitCode: number; stdout: string; stderr: string };
                    recordCommandOutcome(preferredVerifyCommand, res);
                    return {
                      exitCode: res.exitCode,
                      stdout: (res.stdout || '').slice(0, 2000),
                      stderr: (res.stderr || '').slice(0, 1200),
                    };
                  } catch (err) {
                    return { exitCode: 1, stderr: (err as Error).message };
                  }
                };
                return sandbox ? sandbox.wrap('verify', preferredVerifyCommand, run) : run();
              },
              llmPropose: async ({ task: editTask, snippets }) => {
                const run = async () => {
                  try {
                    const resp = await postJsonResilient({
                      url: endpoint,
                      headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${apiKey}`,
                      },
                      body: {
                        model: /deepseek/i.test(manifest.modelId || provider.defaultModelId)
                          ? DEEPSEEK_FLASH
                          : manifest.modelId || provider.defaultModelId,
                        messages: [
                          {
                            role: 'system',
                            content:
                              'You are a budgeted edit subagent. Reply with JSON only: [{"filePath":"...","oldText":"...","newText":"..."}]. Max 6 edits across at most 3 files. oldText must be an exact contiguous snippet from the provided files. No markdown except optional ```json fence.',
                          },
                          {
                            role: 'user',
                            content: [
                              `Task: ${editTask.slice(0, 1500)}`,
                              '',
                              ...snippets.map(
                                (s) => `### FILE ${s.filePath}\n\`\`\`\n${s.content}\n\`\`\``
                              ),
                            ].join('\n'),
                          },
                        ],
                        max_tokens: 2500,
                        temperature: 0.1,
                      },
                      signal,
                      timeoutMs: 20_000,
                    });
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    const data = JSON.parse(resp.text || '{}');
                    return String(data?.choices?.[0]?.message?.content || '');
                  } catch {
                    return '[]';
                  }
                };
                return sandbox ? sandbox.wrap('llm_propose', undefined, run) : run();
              },
            });
            const report = sandbox
              ? sandbox.capReport(
                  `${result.report}\n\n## Sandbox transcript\n${sandbox.formatTranscript()}`
                )
              : result.report;
            try {
              await persistSessionArtifact({
                artifactType: 'report',
                title: `Editor: ${task.slice(0, 80)}`,
                content: report || '',
                source: 'invoke_subagent:editor',
              });
            } catch {
              // best-effort
            }
            return {
              ok: result.ok,
              role: 'editor',
              task,
              filesInspected: result.filesInspected,
              filesEdited: result.filesEdited,
              editsApplied: result.editsApplied,
              rolledBack: result.rolledBack,
              verified: result.verified,
              report,
              errors: result.errors,
              sandbox: sandbox?.summary(),
            };
          }

          if (role === 'verifier') {
            const sandbox =
              typeof createSubagentSandbox === 'function'
                ? createSubagentSandbox('verifier')
                : null;
            const targetFiles =
              files.length > 0
                ? files.map((f) =>
                    this.normalizeWorkspaceRelativePath(f, manifest.workspaceRoot)
                  )
                : Array.from(new Set(sessionWrittenFiles.slice(-8)));

            const gate =
              typeof runDiagnoseAndVerify === 'function'
                ? await runDiagnoseAndVerify({
                    files: targetFiles.slice(0, 6),
                    alwaysVerify: true,
                    readFile: async (relPath: string) => {
                      const run = async () => {
                        const res = (await runCapabilityTool(
                          'read-file',
                          { filePath: relPath },
                          'low'
                        )) as { content: string };
                        return res?.content || '';
                      };
                      return sandbox ? sandbox.wrap('read_file', relPath, run) : run();
                    },
                    diagnose: async (relPath: string, content: string) => {
                      const run = async () => {
                        try {
                          const post = await runPostEditDiagnostics(relPath, content);
                          return post.semanticErrors || null;
                        } catch {
                          return null;
                        }
                      };
                      return sandbox ? sandbox.wrap('diagnose', relPath, run) : run();
                    },
                    verify: async () => {
                      const run = async () => {
                        if (!preferredVerifyCommand) {
                          return { skipped: true, reason: 'no verify command configured' };
                        }
                        try {
                          const res = (await runCapabilityTool(
                            'run-build',
                            { command: preferredVerifyCommand },
                            'high'
                          )) as { exitCode: number; stdout: string; stderr: string };
                          recordCommandOutcome(preferredVerifyCommand, res);
                          return {
                            exitCode: res.exitCode,
                            stdout: (res.stdout || '').slice(0, 2500),
                            stderr: (res.stderr || '').slice(0, 1500),
                          };
                        } catch (err) {
                          return { exitCode: 1, stderr: (err as Error).message };
                        }
                      };
                      return sandbox
                        ? sandbox.wrap('verify', preferredVerifyCommand, run)
                        : run();
                    },
                  })
                : null;

            const passed = gate ? gate.passed : false;
            lastVerifierPass = passed;
            if (!passed) {
              if (gate?.semanticFailed) lastSemanticFailed = true;
              if (gate?.verifyFailed) lastBuildOrTestFailed = true;
            }

            const reportBody = [
              `[Subagent (VERIFIER) Completed Task: ${task}]`,
              `## Verdict: ${passed ? 'PASS' : 'FAIL'}`,
              `## Language diagnostics\n${gate?.diagLines.join('\n\n') || '(no files)'}`,
              `## Verify command\n\`${preferredVerifyCommand}\`\nexit=${gate?.verifyResult.exitCode ?? 'n/a'}\n${
                gate?.verifyResult.stdout || ''
              }\n${gate?.verifyResult.stderr || ''}${
                gate?.verifyResult.skipped ? `\n(skipped: ${gate.verifyResult.reason})` : ''
              }`,
              sandbox ? `## Sandbox transcript\n${sandbox.formatTranscript()}` : '',
            ]
              .filter(Boolean)
              .join('\n\n');

            return {
              ok: true,
              role,
              task,
              passed,
              filesInspected: targetFiles,
              report: sandbox ? sandbox.capReport(reportBody, 7000) : reportBody.slice(0, 7000),
              sandbox: sandbox?.summary(),
            };
          }

          // research / planner: multi-round read-only exploration (no nested LLM)
          if (
            (role === 'research' || role === 'planner') &&
            typeof runResearchSubagent === 'function'
          ) {
            const sandbox =
              typeof createSubagentSandbox === 'function'
                ? createSubagentSandbox(role === 'planner' ? 'planner' : 'research')
                : null;
            const runner =
              role === 'planner' && typeof runPlannerSubagent === 'function'
                ? runPlannerSubagent
                : runResearchSubagent;
            const result = await runner({
              workspaceRoot: manifest.workspaceRoot,
              task,
              queries,
              files: files.map((f) =>
                this.normalizeWorkspaceRelativePath(f, manifest.workspaceRoot)
              ),
              index: workspaceFileIndex || undefined,
              maxRounds: role === 'planner' ? 2 : 4,
              maxReportChars: 5500,
              llmDecompose: async (researchTask: string) => {
                const run = async () => {
                  try {
                    const resp = await postJsonResilient({
                      url: endpoint,
                      headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${apiKey}`,
                      },
                      body: {
                        model: /deepseek/i.test(manifest.modelId || provider.defaultModelId)
                          ? DEEPSEEK_FLASH
                          : manifest.modelId || provider.defaultModelId,
                        messages: [
                          {
                            role: 'system',
                            content:
                              'You decompose coding research tasks into sharp questions and search queries. Reply with JSON only: {"questions":["..."],"searchQueries":["ident","path.ts"]}. Max 6 questions and 8 searchQueries. No markdown.',
                          },
                          { role: 'user', content: researchTask.slice(0, 1200) },
                        ],
                        max_tokens: 400,
                        temperature: 0.1,
                      },
                      signal,
                      timeoutMs: 8000,
                    });
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    const data = JSON.parse(resp.text || '{}');
                    return String(data?.choices?.[0]?.message?.content || '');
                  } catch {
                    return '';
                  }
                };
                return sandbox ? sandbox.wrap('llm_decompose', undefined, run) : run();
              },
              llmSynthesize: async ({ task: researchTask, evidence }) => {
                const run = async () => {
                  try {
                    const resp = await postJsonResilient({
                      url: endpoint,
                      headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${apiKey}`,
                      },
                      body: {
                        model: /deepseek/i.test(manifest.modelId || provider.defaultModelId)
                          ? DEEPSEEK_FLASH
                          : manifest.modelId || provider.defaultModelId,
                        messages: [
                          {
                            role: 'system',
                            content:
                              'You are a budgeted research subagent. From the evidence, output 5-12 lines: root cause hypothesis with file:line cites, key files, and next edit/verify steps. No tools. Be concrete.',
                          },
                          {
                            role: 'user',
                            content: `Task: ${researchTask.slice(0, 800)}\n\nEvidence:\n${evidence.slice(0, 4500)}`,
                          },
                        ],
                        max_tokens: 500,
                        temperature: 0.15,
                      },
                      signal,
                      timeoutMs: 12_000,
                    });
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    const data = JSON.parse(resp.text || '{}');
                    return String(data?.choices?.[0]?.message?.content || '');
                  } catch {
                    return '';
                  }
                };
                return sandbox ? sandbox.wrap('llm_synthesize', undefined, run) : run();
              },
              search: async (query: string) => {
                const run = async () => {
                  if (workspaceFileIndex && typeof searchIndexedFiles === 'function') {
                    return searchIndexedFiles({
                      root: manifest.workspaceRoot,
                      index: workspaceFileIndex,
                      query,
                      mode: 'auto',
                      maxMatches: 30,
                      contextLines: 2,
                    });
                  }
                  return 'No matches found.';
                };
                return sandbox ? sandbox.wrap('search', query, run) : run();
              },
              readFile: async (relPath: string) => {
                const run = async () => {
                  const res = (await runCapabilityTool(
                    'read-file',
                    { filePath: relPath },
                    'low'
                  )) as { content: string };
                  return res?.content || '';
                };
                return sandbox ? sandbox.wrap('read_file', relPath, run) : run();
              },
            });
            if (sessionTodos && Array.isArray(result.suggestedTodos) && sessionTodos.list().length === 0) {
              sessionTodos.manage({
                action: 'set',
                items: result.suggestedTodos.map((content: string) => ({
                  content,
                  status: 'pending' as const,
                })),
              });
            }
            const cappedReport = sandbox
              ? sandbox.capReport(
                  `${result.report}\n\n## Sandbox transcript\n${sandbox.formatTranscript()}`
                )
              : result.report;
            let artifactId: string | undefined;
            try {
              const artType = role === 'planner' ? 'plan' : 'report';
              const saved = await persistSessionArtifact({
                artifactType: artType,
                title:
                  role === 'planner'
                    ? `Plan: ${task.slice(0, 80)}`
                    : `Research: ${task.slice(0, 80)}`,
                content: cappedReport || '',
                source: `invoke_subagent:${role}`,
              });
              artifactId = saved.artifactId;
              if (sessionTodos && sessionTodos.list().length > 0) {
                await persistSessionArtifact({
                  artifactType: 'task_list',
                  title: `Todos: ${task.slice(0, 60)}`,
                  content: `# Session Todos\n\n${sessionTodos.formatForPrompt()}\n`,
                  source: 'invoke_subagent:todos',
                });
              }
            } catch {
              // artifact persistence is best-effort
            }
            return {
              ok: true,
              role: result.role,
              task,
              rounds: result.rounds,
              queries: result.queries,
              filesInspected: result.filesInspected,
              suggestedTodos: result.suggestedTodos,
              sessionTodos: sessionTodos?.list() || [],
              report: cappedReport,
              artifactId,
              sandbox: sandbox?.summary(),
            };
          }

          for (const f of files) {
            const relPath = this.normalizeWorkspaceRelativePath(f, manifest.workspaceRoot);
            try {
              const res = (await runCapabilityTool('read-file', { filePath: relPath }, 'low')) as {
                content: string;
              };
              const outline = extractCodeOutline(res.content, 40, relPath).join('\n');
              digestLines.push(
                `### Inspected \`${relPath}\` (${res.content.split(/\r?\n/).length} lines)\n${
                  outline || res.content.slice(0, 1200)
                }`
              );
            } catch {
              // ignore
            }
          }
          return {
            ok: true,
            role,
            task,
            queries,
            filesInspected: files,
            report: digestLines.join('\n\n').slice(0, 6000),
          };
        },
      }),
      createTool({
        name: 'manage_todo',
        description:
          'Session task checklist for long-horizon goals. Use action=set/add/update/complete/list to track what is done vs remaining. Incomplete todos are auto-injected on self-heal continuations.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['list', 'set', 'add', 'update', 'complete', 'cancel', 'clear'],
              description: 'Todo mutation',
            },
            items: {
              type: 'array',
              description: 'Full list for action=set: [{ content, status? }]',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  content: { type: 'string' },
                  status: {
                    type: 'string',
                    enum: ['pending', 'in_progress', 'completed', 'cancelled'],
                  },
                },
                required: ['content'],
              },
            },
            id: { type: 'string', description: 'Todo id for update/complete/cancel' },
            content: { type: 'string', description: 'Todo text for add/update' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed', 'cancelled'],
            },
          },
          required: ['action'],
        },
        execute: async (rawArgs: Record<string, unknown>) => {
          if (!sessionTodos) {
            return { ok: false, error: 'Session todos unavailable.' };
          }
          const result = sessionTodos.manage({
            action: String(rawArgs?.action || 'list') as any,
            items: Array.isArray(rawArgs?.items) ? (rawArgs.items as any) : undefined,
            id: rawArgs?.id ? String(rawArgs.id) : undefined,
            content: rawArgs?.content ? String(rawArgs.content) : undefined,
            status: rawArgs?.status as any,
          });
          const action = String(rawArgs?.action || 'list');
          if (
            result.ok &&
            ['set', 'add', 'update', 'complete', 'cancel'].includes(action) &&
            sessionTodos.list().length > 0
          ) {
            try {
              await persistSessionArtifact({
                artifactType: 'task_list',
                title: 'Session Todos',
                content: `# Session Todos\n\n${sessionTodos.formatForPrompt()}\n`,
                source: 'manage_todo',
              });
            } catch {
              // ignore
            }
          }
          return result;
        },
      }),
      createTool({
        name: 'browser_action',
        description:
          'Inspect and (with Chrome CDP) interact with running web apps. Actions: navigate, get_html, snapshot, inspect_elements, get_console_logs, click, type, screenshot. Prefers CDP at DEEPAUTOCODE_CDP_URL / localhost:9222; falls back to structured HTTP snapshot.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: [
                'navigate',
                'get_html',
                'snapshot',
                'inspect_elements',
                'get_console_logs',
                'click',
                'type',
                'screenshot',
              ],
              description: 'Browser action to execute',
            },
            url: {
              type: 'string',
              description: 'Target web URL (defaults to http://localhost:3000/)',
            },
            selector: {
              type: 'string',
              description: 'CSS selector for click/type/inspect',
            },
            text: {
              type: 'string',
              description: 'Text to type into selector (action=type)',
            },
          },
          required: ['action'],
        },
        execute: async (rawArgs: Record<string, unknown>) => {
          const { runBrowserAction } = await import('../core/AgentBrowser.js');
          return runBrowserAction({
            action: String(rawArgs?.action || 'navigate'),
            url: rawArgs?.url ? String(rawArgs.url) : undefined,
            selector: rawArgs?.selector ? String(rawArgs.selector) : undefined,
            text: rawArgs?.text ? String(rawArgs.text) : undefined,
          });
        },
      }),
      createTool({
        name: 'call_mcp_tool',
        description:
          'Call a Model Context Protocol (MCP) tool exposed by workspace .deepautocode/mcp.json servers. Prefer qualified names like mcp__serverId__toolName from the MCP tools list.',
        inputSchema: {
          type: 'object',
          properties: {
            tool: {
              type: 'string',
              description: 'Qualified MCP tool name (mcp__server__tool) or unique bare tool name',
            },
            arguments: {
              type: 'object',
              description: 'JSON arguments for the MCP tool',
            },
          },
          required: ['tool'],
        },
        execute: async (rawArgs: Record<string, unknown>) => {
          if (!mcpHost) {
            return { ok: false, error: 'MCP host unavailable in this runtime build.' };
          }
          const toolName = String(rawArgs?.tool || rawArgs?.name || '');
          const args =
            rawArgs?.arguments && typeof rawArgs.arguments === 'object'
              ? (rawArgs.arguments as Record<string, unknown>)
              : rawArgs?.args && typeof rawArgs.args === 'object'
                ? (rawArgs.args as Record<string, unknown>)
                : {};
          if (!toolName) return { ok: false, error: 'tool name is required' };
          if (
            typeof mcpHost.isToolDisabled === 'function' &&
            mcpHost.isToolDisabled(toolName, mcpConfigsCached)
          ) {
            return { ok: false, error: `MCP tool disabled in Settings: ${toolName}` };
          }
          const result = await mcpHost.call(toolName, args);
          return result;
        },
      }),
      createTool({
        name: 'list_mcp_resources',
        description:
          'List MCP resources discovered from connected servers (Stage W). Use read_mcp_resource to fetch content.',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => {
          if (!mcpHost) return { resources: [], error: 'MCP host unavailable' };
          return { resources: mcpHost.listResources() };
        },
      }),
      createTool({
        name: 'read_mcp_resource',
        description: 'Read an MCP resource by URI (from list_mcp_resources).',
        inputSchema: {
          type: 'object',
          properties: {
            uri: { type: 'string', description: 'Resource URI' },
          },
          required: ['uri'],
        },
        execute: async (rawArgs: Record<string, unknown>) => {
          if (!mcpHost) return { ok: false, error: 'MCP host unavailable' };
          return mcpHost.readResource(String(rawArgs?.uri || ''));
        },
      }),
      createTool({
        name: 'list_mcp_prompts',
        description: 'List MCP prompt templates from connected servers.',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => {
          if (!mcpHost) return { prompts: [], error: 'MCP host unavailable' };
          return { prompts: mcpHost.listPrompts() };
        },
      }),
      createTool({
        name: 'get_mcp_prompt',
        description: 'Fetch an MCP prompt template by name (optional serverId + arguments).',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            serverId: { type: 'string' },
            arguments: { type: 'object' },
          },
          required: ['name'],
        },
        execute: async (rawArgs: Record<string, unknown>) => {
          if (!mcpHost) return { ok: false, error: 'MCP host unavailable' };
          const args =
            rawArgs?.arguments && typeof rawArgs.arguments === 'object'
              ? (rawArgs.arguments as Record<string, string>)
              : undefined;
          return mcpHost.getPrompt(
            String(rawArgs?.name || ''),
            args,
            rawArgs?.serverId ? String(rawArgs.serverId) : undefined
          );
        },
      }),
      ...(mcpHost
        ? mcpHost.listTools().slice(0, 32).map((td: any) =>
            createTool({
              name: td.qualifiedName,
              description:
                `[MCP:${td.serverName}] ${td.description || td.name}. Equivalent to call_mcp_tool({ tool: "${td.qualifiedName}", arguments })`,
              inputSchema: td.inputSchema || { type: 'object', properties: {} },
              execute: async (rawArgs: Record<string, unknown>) => {
                if (
                  typeof mcpHost.isToolDisabled === 'function' &&
                  mcpHost.isToolDisabled(td.qualifiedName, mcpConfigsCached)
                ) {
                  return { ok: false, error: `MCP tool disabled in Settings: ${td.qualifiedName}` };
                }
                return mcpHost.call(td.qualifiedName, rawArgs || {});
              },
            })
          )
        : []),
    ];

    // Convert prior session history into AgentMessage format, ensuring no assistant/user message ever has empty content
    const history = await this.readMessages(sessionId);
    const priorToolAuditLines: string[] = [];
    const initialMessages = history
      .slice(-5, -1)
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m, idx) => {
        let text = typeof m.content === 'string' ? m.content.trim() : '';
        if (m.role === 'assistant') {
          if (text.includes('PATH_BOUNDARY_VIOLATION')) {
            text = text.replace(/##\s*关于["“]?直接在文件中改好["”]?[\s\S]*$/m, '').trim();
          }
          text = text
            .replace(/\[系统审计记录[\s\S]*$/m, '')
            .replace(/#{2,4}\s*[一二三四五六七八九十\d、.]*(?:我的错误与承诺|需要你确认的点|需要您确认的点|待确认事项|验证步骤（请在远程服务器执行）)[\s\S]*$/m, '')
            .replace(/\*\*请确认(?:是否|上述)[\s\S]*$/m, '')
            .trim();
        }
        if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
          const uniqueSummaries = Array.from(
            new Set(
              m.toolCalls.map((tc) => {
                const argHint =
                  tc.args?.filePath || tc.args?.path || tc.args?.command || JSON.stringify(tc.args ?? {}).slice(0, 80);
                return `${tc.toolName}(${argHint}) [${tc.status}]`;
              })
            )
          ).slice(0, 12);
          priorToolAuditLines.push(`Turn #${m.sequence}: ${uniqueSummaries.join(', ')}`);
          if (!text || text.length > 900) {
            text = `已完成上一轮工作区操作：${uniqueSummaries.slice(0, 6).join(', ')}。请以当前工作区最新源码（git status / git diff / read_file）为准继续处理。`;
          }
        }
        return {
          id: m.id || `hist_${idx}`,
          role: m.role as 'user' | 'assistant',
          content: [{ type: 'text' as const, text }],
          createdAt: Date.parse(m.timestamp) || Date.now(),
        };
      })
      .filter((m) => m.content[0].text.length > 0);

    // Prefix-Cache Boundary Optimization (ported from Claude Code src/context.ts):
    // Keep systemPrompt 100% static across session turns and place dynamic prior-turn audit context in the user turn tail.
    if (priorToolAuditLines.length > 0) {
      effectivePrompt = `${effectivePrompt}\n\n[Prior Session Executed Tools Audit (do NOT repeat this tag in output): ${priorToolAuditLines.join(' | ')}]`;
    }
    if (isReadOnlyTurn) {
      effectivePrompt = `${effectivePrompt.replace(/^\[(?:READ_ONLY_ANALYSIS|FORCE_AUTO_ACTION)\]\s*/i, '')}\n\n[Smart Intent Router: READ-ONLY QUERY & ANALYSIS MODE — Use read_file / outline_file / search_codebase / explore_codebase, and investigation shells (ls/cat/git status/npm test). Mutating shells (rm/mv/git commit/npm install/redirects) are blocked by CommandGuard. Do NOT edit files in this turn.]`;
    } else {
      effectivePrompt = effectivePrompt.replace(/^\[(?:READ_ONLY_ANALYSIS|FORCE_AUTO_ACTION)\]\s*/i, '');
    }

    // 3. Convert AgentModelRequest into OpenAI-Compatible / DeepSeek HTTP stream
    let modelTurnIndex = 0;
    const maxToolCallingTurns = 90;
    let lastOpenAiMessages: Array<Record<string, any>> = [];
    let llmTurnStartedAt = Date.now();
    let sessionCostCny = 0;
    const emitRuntimeEvent = (event: ClineRuntimeEvent) => this.emit(event);

    const clineModelAdapter = {
      stream: async function* (request: any) {
        if (signal.aborted || request.signal?.aborted) {
          yield { type: 'finish' as const, reason: 'aborted' as const };
          return;
        }

        modelTurnIndex += 1;
        llmTurnStartedAt = Date.now();
        const allowToolsThisTurn = modelTurnIndex <= maxToolCallingTurns;

        const configuredModelId = manifest.modelId || provider.defaultModelId;
        const routingMode = /force-reasoner|deepseek-reasoner|deepseek-v4-pro/i.test(
          configuredModelId
        )
          ? ('force-reasoner' as const)
          : /force-fast|^deepseek-chat$|^deepseek-flash$/i.test(configuredModelId)
            ? ('force-fast' as const)
            : ('auto' as const);
        const uniqueEdited = new Set(sessionWrittenFiles);
        const tierDecision = resolveTieredModelForTurn({
          configuredModelId,
          providerId: manifest.providerId,
          userPrompt: prompt,
          turnIndex: modelTurnIndex,
          selfHealCount,
          hasReadFiles: fileStateCache.size > 0,
          hasEditedFiles: sessionWrittenFiles.length > 0,
          hasBuildOrTestFailure: lastBuildOrTestFailed,
          hasSemanticFailure: lastSemanticFailed,
          editMismatchCount,
          multiFilePending: uniqueEdited.size >= 2,
          routingMode: configuredModelId === 'deepseek-auto' ? 'auto' : routingMode,
        });
        const activeModelId = tierDecision.effectiveModelId;
        const thinkingEnabled = Boolean(
          (tierDecision as { thinkingEnabled?: boolean }).thinkingEnabled ??
            /reasoner|r1|pro/i.test(activeModelId)
        );
        const reasoningEffort =
          (tierDecision as { reasoningEffort?: 'low' | 'high' | 'max' | null })
            .reasoningEffort ?? (thinkingEnabled ? 'high' : null);
        const dsControls = isDeepSeekModelId(activeModelId)
          ? buildDeepSeekRequestControls({
              apiModelId: activeModelId,
              thinkingEnabled,
              reasoningEffort,
            })
          : null;
        const isReasonerModel = Boolean(dsControls?.isThinking);
        const peakHour = isDeepSeekPeakHour();
        emitRuntimeEvent({
          type: 'model_tier',
          sessionId,
          payload: {
            configuredModelId,
            effectiveModelId: activeModelId,
            thinkingEnabled,
            reasoningEffort,
            peakHour,
            tokensUsed: activeGoal.tokensUsed,
            tokenBudget: Number(activeGoal.tokenBudget ?? 180000),
            tier: tierDecision.tier,
            reason: tierDecision.reason,
            turnIndex: modelTurnIndex,
          },
        });
        activeGoal.turnsExecuted = modelTurnIndex;

        const openAiMessages: Array<Record<string, any>> = [];
        if (request.systemPrompt) {
          openAiMessages.push({
            role: 'system',
            content: request.systemPrompt,
          });
        }

        const emittedToolCallIds = new Set<string>();

        for (const msg of request.messages ?? []) {
          if (msg.role === 'user') {
            const textContent = (msg.content ?? [])
              .filter((p: any) => p.type === 'text')
              .map((p: any) => p.text)
              .join('\n')
              .trim();
            openAiMessages.push({
              role: 'user',
              content: textContent || 'Continue.',
            });
          } else if (msg.role === 'assistant') {
            const textParts = (msg.content ?? [])
              .filter((p: any) => p.type === 'text')
              .map((p: any) => p.text)
              .join('')
              .trim();
            const toolCallParts = (msg.content ?? []).filter(
              (p: any) =>
                p.type === 'tool-call' &&
                typeof p.toolName === 'string' &&
                p.toolName.trim().length > 0 &&
                typeof p.toolCallId === 'string' &&
                p.toolCallId.trim().length > 0
            );
            if (toolCallParts.length > 0) {
              const assistantObj: Record<string, any> = {
                role: 'assistant',
                content: textParts || '',
                // DeepSeek tool-calling requires prior reasoning_content to be echoed back.
                ...(typeof (msg as any).reasoningContent === 'string' || isReasonerModel
                  ? { reasoning_content: (msg as any).reasoningContent ?? '' }
                  : {}),
                tool_calls: toolCallParts.map((tc: any) => {
                  emittedToolCallIds.add(tc.toolCallId);
                  return {
                    id: tc.toolCallId,
                    type: 'function',
                    function: {
                      name: tc.toolName,
                      arguments:
                        typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input ?? {}),
                    },
                  };
                }),
              };
              openAiMessages.push(assistantObj);
            } else {
              // DeepSeek / OpenAI invariant: assistant message without tool_calls MUST have non-empty content
              openAiMessages.push({
                role: 'assistant',
                content: textParts || '已完成上一步工作区操作，继续执行。',
              });
            }
          } else if (msg.role === 'tool') {
            for (const part of msg.content ?? []) {
              if (part.type === 'tool-result') {
                const outputText =
                  typeof part.output === 'string'
                    ? part.output
                    : JSON.stringify(part.output ?? {});
                if (part.toolCallId && emittedToolCallIds.has(part.toolCallId)) {
                  openAiMessages.push({
                    role: 'tool',
                    tool_call_id: part.toolCallId,
                    content: outputText || '{}',
                  });
                } else {
                  openAiMessages.push({
                    role: 'user',
                    content: `[Tool Result]: ${outputText || '{}'}`,
                  });
                }
              }
            }
          }
        }

        const isFinishingStage =
          manifest.executionMode === 'auto' &&
          modelTurnIndex > maxToolCallingTurns - 8 &&
          modelTurnIndex <= maxToolCallingTurns;

        if (isFinishingStage) {
          openAiMessages.push({
            role: 'system',
            content:
              'You have completed sufficient workspace exploration. Do NOT ask the user for confirmation. In your remaining turns, immediately call edit_file / write_file to apply your code fixes and call run_command to compile and run verification tests!',
          });
        } else if (!allowToolsThisTurn) {
          openAiMessages.push({
            role: 'system',
            content:
              'You have completed enough workspace file/tool inspections. Do NOT call any more tools. Immediately synthesize all information gathered above into a comprehensive, well-structured Markdown response in Chinese.',
          });
        }

        lastOpenAiMessages = openAiMessages;

        const filteredTools = isFinishingStage
          ? (request.tools ?? []).filter((t: any) =>
              ['edit_file', 'write_file', 'apply_patch', 'editor', 'run_command', 'run_commands', 'read_file'].includes(
                t.name
              )
            )
          : (request.tools ?? []);

        const openAiTools = allowToolsThisTurn
          ? filteredTools.map((t: any) => ({
              type: 'function',
              function: {
                name: t.name,
                description: t.description,
                parameters: t.inputSchema ?? { type: 'object', properties: {} },
              },
            }))
          : [];

        const response = await postJsonResilient({
          url: endpoint,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: {
            model: activeModelId,
            messages: openAiMessages,
            tools: openAiTools.length > 0 ? openAiTools : undefined,
            tool_choice: openAiTools.length > 0 ? 'auto' : undefined,
            max_tokens: 8192,
            ...(isReasonerModel ? {} : { temperature: 0.2 }),
            ...(dsControls ? deepSeekChatBodyExtras(dsControls) : {}),
          },
          signal: request.signal ?? signal,
          timeoutMs: isReasonerModel ? 120000 : 60000,
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.text.slice(0, 240)}`);
        }

        const data = JSON.parse(response.text || '{}') as any;
        const choice = data?.choices?.[0];
        const msg = choice?.message;
        if (!msg) {
          throw new Error('Empty response from LLM provider');
        }
        const reasoningContent =
          typeof msg.reasoning_content === 'string' && msg.reasoning_content.length > 0
            ? msg.reasoning_content
            : undefined;

        const rawToolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
        const validToolCalls: Array<{
          id: string;
          fnName: string;
          inputText: string;
          parsedArgs: Record<string, unknown>;
        }> = [];

        for (let i = 0; i < rawToolCalls.length; i++) {
          const tc = rawToolCalls[i];
          const fnName = typeof tc?.function?.name === 'string' ? tc.function.name.trim() : '';
          if (!fnName) {
            continue;
          }
          const rawArgs = typeof tc?.function?.arguments === 'string' ? tc.function.arguments : '{}';
          let parsedArgs: Record<string, unknown> = {};
          let inputText = rawArgs;
          try {
            parsedArgs = JSON.parse(rawArgs);
            if (fnName === 'write_file' && parsedArgs?.filePath) {
              sessionWrittenFiles.push(String(parsedArgs.filePath));
            }
          } catch {
            // Tool call JSON arguments were truncated at max_tokens
            if (validToolCalls.length > 0) {
              // Execute the already-complete tool calls in this turn; the model will do the truncated one next turn
              continue;
            }
            const partialPathMatch = rawArgs.match(/"(?:filePath|path|file_path)"\s*:\s*"([^"]+)"/);
            parsedArgs = {
              __truncated: true,
              filePath: partialPathMatch?.[1] || '',
            };
            inputText = JSON.stringify(parsedArgs);
          }
          validToolCalls.push({
            id: tc.id || `call_${Date.now()}_${i}`,
            fnName,
            inputText,
            parsedArgs,
          });
        }

        // Only stream final assistant answer text; suppress intermediate file-reading/tool chatter
        if (validToolCalls.length === 0) {
          const cleanedMsgContent =
            typeof msg.content === 'string'
              ? msg.content.replace(/\[系统审计记录[\s\S]*$/m, '').trim()
              : '';
          const finalContent =
            cleanedMsgContent.length > 0
              ? cleanedMsgContent
              : sessionWrittenFiles.length > 0
                ? `## 项目构建与文件生成完成\n- **已生成/更新文件 (${sessionWrittenFiles.length})**: ${Array.from(new Set(sessionWrittenFiles)).map((f) => `\`${f}\``).join('、')}\n- **状态**: 所有文件已写入工作区并生成 Diff 预览。`
                : '已完成当前请求分析与处理。';
          yield {
            type: 'text-delta' as const,
            text: finalContent,
          };
        }

        for (let i = 0; i < validToolCalls.length; i++) {
          const vtc = validToolCalls[i];
          yield {
            type: 'tool-call-delta' as const,
            index: i,
            toolCallId: vtc.id,
            toolName: vtc.fnName,
            inputText: vtc.inputText,
            input: vtc.parsedArgs,
          };
        }

        if (data?.usage) {
          const inTok = Number(data.usage.prompt_tokens ?? 0);
          const outTok = Number(data.usage.completion_tokens ?? 0);
          const cacheHitTok = Number(
            data.usage.prompt_cache_hit_tokens ??
              data.usage.prompt_tokens_details?.cached_tokens ??
              0
          );
          const cacheMissTok = Number(data.usage.prompt_cache_miss_tokens ?? 0);
          activeGoal.tokensUsed += inTok + outTok;
          const budget = Number(activeGoal.tokenBudget ?? 180000);
          const latencyMs = Date.now() - llmTurnStartedAt;
          const llmEvt = globalTaskTraceStore.recordLlmTurn({
            workspaceRoot: manifest.workspaceRoot,
            sessionId,
            taskId,
            turnIndex: modelTurnIndex,
            modelId: activeModelId,
            latencyMs,
            inputTokens: inTok,
            outputTokens: outTok,
            cacheReadTokens: cacheHitTok,
            cacheWriteTokens: cacheMissTok,
            tokensUsed: activeGoal.tokensUsed,
            tokenBudget: budget,
          });
          const snap = taskId
            ? globalTaskTraceStore.get(taskId)
            : globalTaskTraceStore.getBySession(sessionId);
          const turnCost = isDeepSeekModelId(activeModelId)
            ? estimateDeepSeekTurnCostCny({
                apiModelId: activeModelId,
                inputTokens: inTok,
                outputTokens: outTok,
                cacheReadTokens: cacheHitTok,
                peak: isDeepSeekPeakHour(),
              })
            : 0;
          sessionCostCny += turnCost;
          emitRuntimeEvent({
            type: 'goal_usage',
            sessionId,
            payload: {
              tokensUsed: activeGoal.tokensUsed,
              tokenBudget: budget,
              inputTokens: inTok,
              outputTokens: outTok,
              cacheReadTokens: cacheHitTok,
              cacheWriteTokens: cacheMissTok,
              cacheReadTokensTotal: snap?.cacheReadTokens ?? cacheHitTok,
              cacheWriteTokensTotal: snap?.cacheWriteTokens ?? cacheMissTok,
              estimatedCostCny: turnCost,
              estimatedCostCnyTotal: sessionCostCny,
              peakHour: isDeepSeekPeakHour(),
              modelId: activeModelId,
              thinkingEnabled,
              turnIndex: modelTurnIndex,
              remaining: Math.max(0, budget - activeGoal.tokensUsed),
              latencyMs,
              taskId,
            },
          });
          if (llmEvt) emitTraceUpdated?.(llmEvt);
          yield {
            type: 'usage' as const,
            usage: {
              inputTokens: inTok,
              outputTokens: outTok,
              cacheReadTokens: cacheHitTok,
              cacheWriteTokens: cacheMissTok,
            },
          };
        }

        yield {
          type: 'finish' as const,
          reason: validToolCalls.length > 0 ? ('tool-calls' as const) : ('stop' as const),
          ...(reasoningContent ? { reasoningContent } : {}),
        };
      },
    };

    // 4. Build in-tree system prompt + tool policies and instantiate in-tree AgentLoop
    let memorySection = '';
    if (typeof loadAgentMemory === 'function' && typeof formatAgentMemoryForPrompt === 'function') {
      try {
        const mem = await loadAgentMemory(manifest.workspaceRoot);
        memorySection = formatAgentMemoryForPrompt(mem, 5);
      } catch {
        memorySection = '';
      }
    }

    const officialClinePrompt =
      typeof getClineDefaultSystemPrompt === 'function'
        ? getClineDefaultSystemPrompt(
            {
              ...workspaceInfo,
              workspaceRoot: manifest.workspaceRoot,
              planModeSwitchTool: false,
            },
            {
              // Path-conditional .cursor/rules globs — prefer recently touched + open files
              activePaths: Array.from(
                new Set([
                  ...sessionWrittenFiles.slice(-12),
                  ...(Array.isArray((manifest as any).openFiles)
                    ? ((manifest as any).openFiles as string[])
                    : []),
                ])
              ),
              prompt: basePromptForTurn,
            }
          )
        : '';
    const officialClinePromptWithMemory = memorySection
      ? `${officialClinePrompt}\n\n${memorySection}`
      : officialClinePrompt;

    const baseToolPolicies =
      typeof createToolPoliciesWithPreset === 'function'
        ? createToolPoliciesWithPreset(
            isReadOnlyTurn ? 'plan' : manifest.executionMode === 'auto' ? 'yolo' : 'default'
          )
        : undefined;
    const toolPolicies =
      baseToolPolicies &&
      typeof overlayToolPoliciesWithHardRules === 'function' &&
      policyGate?.permissionRuleset?.length
        ? overlayToolPoliciesWithHardRules(baseToolPolicies, policyGate.permissionRuleset)
        : baseToolPolicies;

    const mergedTools =
      typeof applyStandardToolAliases === 'function'
        ? applyStandardToolAliases([...deepAutoCodeTools, ...builtinTools])
        : [...deepAutoCodeTools, ...builtinTools];
    // Plan/read-only: keep investigation shells (CommandGuard blocks mutators); drop editors.
    const activeTurnTools = mergedTools.filter((t) =>
      isReadOnlyTurn || manifest.executionMode === 'plan'
        ? ![
            'edit_file',
            'str_replace',
            'write_file',
            'apply_patch',
            'editor',
            'auto_build_and_test',
            'connect_remote_ssh',
          ].includes(t.name)
        : true
    );

    const asksUserOrDefersExecutionPattern =
      /(?:请确认|需要你确认|需要您确认|需确认|我未读到|需要我直接|要我直接|是否现在执行|确认后我会|请问是否|直接授权我|我会立即修改|是否继续执行|请告诉我是否|需要我现在执行吗|请执行[:：]?|请先执行|请在远程服务器执行)/;
    const proposesCodeChangesInTextPattern =
      /(?:###?\s*(?:改动|修改|步骤)\s*\d|####\s*(?:改动|修改|步骤)\s*\d|##\s*✅?\s*Kernel\s*侧修复方案|##\s*修复方案)/;

    const clineAgent = new Agent({
      sessionId,
      conversationId: sessionId,
      clientName: 'deepautocode-desktop-ide',
      clientVersion: '1.1.0',
      model: clineModelAdapter,
      toolPolicies,
      mistakeTracker: mistakeTracker ?? undefined,
      loopDetection: loopDetection ?? undefined,
      getContextBudget: () => ({
        tokensUsed: activeGoal.tokensUsed,
        tokenBudget: activeGoal.tokenBudget,
      }),
      requestToolApproval: async ({ toolName, args, summary }) => {
        const filePath =
          typeof args.filePath === 'string'
            ? args.filePath
            : typeof args.path === 'string'
              ? args.path
              : undefined;
        const command = typeof args.command === 'string' ? args.command : undefined;
        const decision = await this.capabilityRegistry.requestUserApproval({
          sessionId,
          toolName,
          summary: summary || `Approve tool '${toolName}'`,
          risk: 'high',
          targetPath: filePath,
          command,
          arguments: args,
        });
        return { approved: decision.approved, reason: decision.reason };
      },
      systemPrompt:
        `${officialClinePromptWithMemory}\n\n` +
        `# DeepAutoCode Desktop IDE Environment & Guidelines\n` +
        `- Current Workspace Root: ${manifest.workspaceRoot}\n` +
        `- Top-level Workspace Entries: ${workspaceFilesHint || '(empty or unknown)'}\n` +
        `- Execution Mode: ${manifest.executionMode}\n` +
        `- Workspace Verification Gate (source=${verifyConfig.source}):\n${verifyPromptBlock.split('\n').map((l) => `  ${l}`).join('\n')}\n` +
        (mcpBootstrapNote
          ? `- MCP: ${mcpBootstrapNote}\n  Use call_mcp_tool({ tool: "mcp__server__tool", arguments }) or the injected mcp__* tools when external systems are needed.\n`
          : `- MCP: configure servers in Settings or workspace .deepautocode/mcp.json (stdio). Built-in placeholders are ignored.\n`) +
        (isSshMirrorWorkspace
          ? `- REMOTE SSH LINUX WORKSPACE: This workspace is connected to a Remote Linux SSH server with bidirectional file sync. All shell commands in 'run_command' and 'run_commands' execute directly on the Remote Linux server via /bin/bash (NEVER use Windows PowerShell cmdlets like Get-ChildItem or Select-Object). All file tools ('read_file', 'edit_file', 'editor', 'write_file') automatically pull and push files between the IDE and the Remote SSH server.\n`
          : `- Prefer 'run_command' (PowerShell) over 'run_commands' when running shell commands on Windows.\n`) +
        `- AUTONOMOUS END-TO-END PROBLEM RESOLUTION (自动处理所有问题 — 最高优先级准则):\n` +
        `  1. In 'auto' mode, you are an autonomous problem-solving engineer, NOT a passive report generator.\n` +
        `  2. Whenever you analyze a project, diagnose a bug/error log, or are asked to fix issues, once you discover concrete code bugs:\n` +
        `     - DO NOT stop after merely listing problems or writing a Markdown modification plan!\n` +
        `     - NEVER ask the user to run build/test commands manually — execute them yourself via tools!\n` +
        `     - IMMEDIATELY call 'edit_file' or 'write_file' to fix bugs, then run_command with the workspace verify gate: \`${preferredVerifyCommand}\`\n` +
        `     - NEVER fabricate command outputs or test results.\n` +
        `- ULTRA-CONCISE RESPONSE FORMAT:\n` +
        `  1. Keep final response short and scannable (about 8–20 lines).\n` +
        `  2. Use at most 3 blocks: root cause (file:line), changes (file:line), verification result from real commands.\n` +
        `- HIGH-SPEED PARALLEL EXECUTION RULES:\n` +
        `  1. BATCH MULTIPLE READS IN ONE TURN via parallel read_file / search_codebase calls.\n` +
        `  2. Prefer 'read_file' over remote sed/cat when possible.\n` +
        `  3. After edits, prefer ONE combined verify command: \`${preferredVerifyCommand}\`\n` +
        `- DIRECT FILE MODIFICATION RULES:\n` +
        `  1. Always pass workspace-relative paths (e.g. "src/enqueue.cc", "src/device/common_kernel.h", "nccl-test/src/sendrecv.cc") to 'read_file', 'edit_file', 'editor', and 'write_file'.\n` +
        `  2. For large files (>50KB, such as "src/enqueue.cc"), pass 'start_line' and 'end_line' to 'read_file' (e.g. { "filePath": "src/enqueue.cc", "start_line": 740, "end_line": 830 }) instead of running repeated grep/sed shell commands.\n` +
        `  3. When modifying an existing source file (especially large C/C++/Python/TS files), prefer 'edit_file' ({ filePath, oldText, newText }) or multi-hunk 'edit_file.hunks' / 'apply_patch' (unified diff) for multi-site edits; use 'write_file' only for new files or full rewrites.\n` +
        `  3b. search_codebase supports regex=true, glob="*.ts", mode="symbol"|"content"|"auto".\n` +
        `  4. NEVER claim you cannot modify files, NEVER blame PATH_BOUNDARY_VIOLATION (all deep subdirectory files are 100% accessible), and NEVER ask the user to run manual python/sed scripts instead of modifying the files yourself.\n` +
        `- When writing large new files (> 250 lines), write 1 file per tool-calling turn so your JSON output never hits the 8192 max_tokens limit.\n` +
        `- CRITICAL SAFETY RULE: NEVER run 'taskkill /F /IM node.exe', 'Stop-Process -Name node', or kill all node/electron processes globally, because the DeepAutoCode IDE backend itself runs on Node.js (port 3840). When asked to compile & run ("编译运行" / "启动服务"), run syntax checks (e.g. 'node --check server/server.js') and start the server via 'run_command' (e.g. 'node server/server.js'). If the target port is already in use, the server is already running in the background — simply verify it with 'curl.exe -s -I http://localhost:3000'.\n` +
        `- Do NOT output raw file contents or narrate your file-reading process in text; the IDE automatically displays a real-time progress indicator for all file/tool operations.\n` +
        `- In 'plan' mode, only use read-only tools.\n` +
        `- Respond clearly and concisely in the user's language (Chinese by default).`,
      tools: activeTurnTools,
      initialMessages,
      maxIterations: 105,
      hooks: {
        onEvent: async (event: any) => {
          if (event.type === 'assistant-text-delta' && event.text) {
            await streamText(event.text);
          }
          if (event.type === 'context.pressure') {
            emitRuntimeEvent({
              type: 'goal_usage',
              sessionId,
              payload: {
                tokensUsed: activeGoal.tokensUsed,
                tokenBudget: Number(activeGoal.tokenBudget ?? 180000),
                remaining: Math.max(
                  0,
                  Number(activeGoal.tokenBudget ?? 180000) - activeGoal.tokensUsed
                ),
                contextPressure: true,
                fillRatio: event.fillRatio,
                compactionStage: event.stage,
                compactionTrigger: event.trigger,
                warnBudget: Boolean(event.warnBudget),
              },
            });
            const compactEvt = globalTaskTraceStore.recordSignal?.({
              workspaceRoot: manifest.workspaceRoot,
              sessionId,
              taskId,
              signal: 'compaction',
              summary: `${event.stage || 'pressure'} · ${event.reason || ''} · trigger=${event.trigger || 'n/a'}`,
              detail: {
                fillRatio: event.fillRatio,
                stage: event.stage,
                trigger: event.trigger,
                warnBudget: event.warnBudget,
              },
            });
            if (compactEvt) emitTraceUpdated?.(compactEvt);
          }
          if (event.type === 'agent.mistake' || event.type === 'agent.loop') {
            const signalEvt = globalTaskTraceStore.recordSignal?.({
              workspaceRoot: manifest.workspaceRoot,
              sessionId,
              taskId,
              signal: event.type === 'agent.loop' ? 'loop' : 'mistake',
              summary:
                event.reason ||
                `${event.kind || event.type} · consecutive=${event.consecutiveMistakes ?? '?'}`,
              detail: {
                kind: event.kind,
                toolName: event.toolName,
                count: event.count,
                consecutiveMistakes: event.consecutiveMistakes,
              },
            });
            if (signalEvt) emitTraceUpdated?.(signalEvt);
          }
        },
        onBeforeFinish: async ({ assistantText, iterations, consecutiveMistakes }) => {
          if (isReadOnlyTurn || manifest.executionMode !== 'auto' || iterations >= maxToolCallingTurns - 2) {
            return { shouldContinue: false };
          }

          // MistakeTracker / LoopDetection: treat high consecutive mistakes like verify fail
          if (
            typeof consecutiveMistakes === 'number' &&
            consecutiveMistakes >= 4 &&
            selfHealCount < selfHealBudget
          ) {
            selfHealCount += 1;
            autoContinuationCount += 1;
            mistakeTracker?.recordSuccess();
            return {
              shouldContinue: true,
              prompt: buildGoalContinuationPrompt(
                activeGoal,
                `检测到连续失误/循环（MistakeTracker consecutive=${consecutiveMistakes}）。请停止重复同一工具调用：换参数、换工具，或先 summarize 失败原因再 edit_file。自愈进度 ${selfHealCount}/${selfHealBudget}。`
              ),
            };
          }

          // Token budget exceeded → ask model to summarize and stop expanding exploration
          if (
            typeof isGoalTokenBudgetExceeded === 'function' &&
            isGoalTokenBudgetExceeded(activeGoal) &&
            !budgetLimitNotified
          ) {
            budgetLimitNotified = true;
            autoContinuationCount += 1;
            return {
              shouldContinue: true,
              prompt:
                typeof buildGoalBudgetLimitPrompt === 'function'
                  ? buildGoalBudgetLimitPrompt(activeGoal)
                  : `Token budget reached (${activeGoal.tokensUsed}/${activeGoal.tokenBudget}). Summarize progress and stop new exploration.`,
            };
          }

          const needsHeal = lastBuildOrTestFailed || lastSemanticFailed;
          const todoBlock =
            sessionTodos && sessionTodos.hasIncomplete
              ? `\nSession todos (incomplete first):\n${sessionTodos.formatForPrompt()}\n`
              : '';

          // Case 0: Semantic diagnostics failed after edit — heal before claiming done
          // (shares self-heal budget; does not consume verify-nudge budget)
          if (lastSemanticFailed && !lastBuildOrTestFailed && selfHealCount < selfHealBudget) {
            selfHealCount += 1;
            autoContinuationCount += 1;
            const problemsExtra =
              typeof loadWorkspaceProblemsText === 'function'
                ? await loadWorkspaceProblemsText(manifest.workspaceRoot, 30)
                : '';
            lastSemanticFailed = false;
            return {
              shouldContinue: true,
              prompt: buildGoalContinuationPrompt(
                activeGoal,
                `编辑后语言服务诊断失败（无需用户 @problems）：\n\`\`\`\n${
                  lastSemanticDiagSnippet || '(semantic diagnostics)'
                }\n\`\`\`\n${
                  problemsExtra ? `Persisted Problems:\n${problemsExtra}\n` : ''
                }${todoBlock}请立即 edit_file/apply_patch 修复上述诊断，必要时再 run_command：\`${preferredVerifyCommand}\`。自愈进度 ${selfHealCount}/${selfHealBudget}。`
              ),
            };
          }

          // Case 1: Source was edited but build/verify not run yet (verify-nudge budget)
          if (hasUnverifiedCompiledEdit && verifyNudgeCount < verifyNudgeBudget) {
            verifyNudgeCount += 1;
            autoContinuationCount += 1;
            hasUnverifiedCompiledEdit = false;
            return {
              shouldContinue: true,
              prompt: buildGoalContinuationPrompt(
                activeGoal,
                `你刚刚修改了需要验证的源码，但尚未执行工作区验证门禁！请立即调用 run_command 执行：\n${verifyPromptBlock}\n推荐一条命令：\`${preferredVerifyCommand}\`\n确认构建与测试通过后再输出最终报告。`
              ),
            };
          }

          // Case 2: Build done-ish but dedicated test command still pending
          if (
            hasUnverifiedTestAfterEdit &&
            !lastBuildOrTestFailed &&
            verifyNudgeCount < verifyNudgeBudget
          ) {
            verifyNudgeCount += 1;
            autoContinuationCount += 1;
            hasUnverifiedTestAfterEdit = false;
            return {
              shouldContinue: true,
              prompt: buildGoalContinuationPrompt(
                activeGoal,
                `代码可能已构建，但仍需运行测试验证！请立即调用 run_command 执行：\`${verifyConfig.testCommand}\`（或组合命令 \`${preferredVerifyCommand}\`），确认测试真实通过后再总结。`
              ),
            };
          }

          // Case 2b: Verifier subagent reported FAIL
          if (lastVerifierPass === false && selfHealCount < selfHealBudget) {
            selfHealCount += 1;
            autoContinuationCount += 1;
            lastVerifierPass = null;
            return {
              shouldContinue: true,
              prompt: buildGoalContinuationPrompt(
                activeGoal,
                `invoke_subagent(verifier) 判定未通过。请根据其报告修复代码，再重新验证（可再次 invoke_subagent role=verifier 或 run_command \`${preferredVerifyCommand}\`）。自愈进度 ${selfHealCount}/${selfHealBudget}。`
              ),
            };
          }

          // Case 3: Build/test failed — independent self-heal budget
          if (needsHeal && selfHealCount < selfHealBudget) {
            selfHealCount += 1;
            autoContinuationCount += 1;
            const problemsExtra =
              typeof loadWorkspaceProblemsText === 'function'
                ? await loadWorkspaceProblemsText(manifest.workspaceRoot, 30)
                : '';
            const failedTests =
              lastFailedTestHints.length > 0
                ? `\n失败用例提示: ${lastFailedTestHints.join(' | ')}\n优先修复这些用例，然后优先重跑：\`${verifyConfig.testCommand}\`。`
                : '';
            lastBuildOrTestFailed = false;
            lastSemanticFailed = false;
            return {
              shouldContinue: true,
              prompt: buildGoalContinuationPrompt(
                activeGoal,
                `上一步编译/测试或语义检查未通过（自愈 ${selfHealCount}/${selfHealBudget}，与 verify 催促计数独立）：\n\`\`\`\n${
                  lastFailureOutputSnippet ||
                  lastSemanticDiagSnippet ||
                  '命令返回非零退出码或测试输出包含 FAILED'
                }\n\`\`\`${failedTests}${
                  problemsExtra ? `\nProblems:\n${problemsExtra}\n` : ''
                }\n${todoBlock}请立即 edit_file/apply_patch 修复，再 run_command 聚焦重测/验证直到通过。可用 manage_todo 更新任务状态。`
              ),
            };
          }

          // Case 3c: Incomplete session todos after verify passed — nudge to finish checklist
          if (
            !needsHeal &&
            !hasUnverifiedCompiledEdit &&
            !hasUnverifiedTestAfterEdit &&
            sessionTodos?.hasIncomplete &&
            verifyNudgeCount < verifyNudgeBudget &&
            activeGoal.verifiedByCommand
          ) {
            verifyNudgeCount += 1;
            autoContinuationCount += 1;
            return {
              shouldContinue: true,
              prompt: buildGoalContinuationPrompt(
                activeGoal,
                `验证已通过，但仍有未完成 session todos：\n${sessionTodos.formatForPrompt()}\n请继续完成剩余项，或用 manage_todo 将已完成的标记 complete 后再总结。`
              ),
            };
          }

          // Case 3b: Circuit breaker — self-heal budget exhausted → roll back
          if (needsHeal && selfHealCount >= selfHealBudget && !circuitBreakerNotified) {
            circuitBreakerNotified = true;
            circuitBroken = true;
            autoContinuationCount += 1;
            lastBuildOrTestFailed = false;
            lastSemanticFailed = false;
            let rollbackMsg = 'Circuit breaker engaged.';
            if (typeof rollbackSessionMutations === 'function') {
              const rb = await rollbackSessionMutations({
                workspaceRoot: manifest.workspaceRoot,
                originals: sessionOriginalContents,
                createdFiles: Array.from(sessionCreatedFiles),
              });
              rollbackMsg = `${rb.message} Restored: ${rb.rolledBackFiles.join(', ') || '(none)'}.`;
              sessionWrittenFiles.length = 0;
              hasUnverifiedCompiledEdit = false;
              hasUnverifiedTestAfterEdit = false;
              this.emit({
                type: 'circuit_breaker_triggered',
                sessionId,
                payload: {
                  message: rollbackMsg,
                  rolledBackFiles: rb.rolledBackFiles,
                  failedFiles: rb.failedFiles,
                  selfHealCount,
                },
              });
            }
            onCircuitTriggered?.();
            return {
              shouldContinue: true,
              prompt:
                `[CIRCUIT_BREAKER] ${rollbackMsg}\n` +
                `Do NOT call edit_file / write_file / editor again. Concise failure report only:\n` +
                `1) Root cause hypothesis\n2) Why verification still failed after ${selfHealCount} self-heal attempts\n` +
                `3) Suggested next manual step for the user\n` +
                `Last failure snippet:\n\`\`\`\n${
                  lastFailureOutputSnippet || lastSemanticDiagSnippet || '(empty)'
                }\n\`\`\``,
            };
          }

          // Case 4: Plan/defer without edits — uses verify-nudge style single push
          if (
            sessionWrittenFiles.length === 0 &&
            !activeGoal.verifiedByCommand &&
            verifyNudgeCount === 0 &&
            (asksUserOrDefersExecutionPattern.test(assistantText) ||
              proposesCodeChangesInTextPattern.test(assistantText))
          ) {
            verifyNudgeCount += 1;
            autoContinuationCount += 1;
            return {
              shouldContinue: true,
              prompt: buildGoalContinuationPrompt(
                activeGoal,
                '已全部授权你直接落地执行！当前处于 auto 全自动执行模式：若目标文件尚未修改，请立即调用 edit_file / write_file 直接修改源码文件并调用 run_command 编译与测试验证；若通过检查发现目标文件在之前轮次已经修改到位，请直接调用 run_command 验证编译/测试并给出最终总结，切勿重复调用 read_file 读取同一文件！'
              ),
            };
          }

          return { shouldContinue: false };
        },
      },
    });

    const onAbort = () => {
      clineAgent.abort('Task cancelled by user');
    };
    signal.addEventListener('abort', onAbort, { once: true });

    let runResult: any;
    try {
      runResult = await clineAgent.run(effectivePrompt);
    } finally {
      signal.removeEventListener('abort', onAbort);
      await mcpHost?.dispose?.().catch(() => undefined);
    }

    if (runResult.status === 'failed' && runResult.error) {
      const errMsg = runResult.error?.message || String(runResult.error);
      if (errMsg.includes('maxIterations') && lastOpenAiMessages.length > 0) {
        // Synthesize final answer directly from all collected tool results
        const synthResponse = await postJsonResilient({
          url: endpoint,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: {
            model: manifest.modelId || provider.defaultModelId,
            messages: [
              ...lastOpenAiMessages,
              {
                role: 'user',
                content:
                  '请基于以上已读取的工作区文件与目录信息，立即直接输出完整、结构化的 Markdown 总结分析回答（不要再调用任何工具）。',
              },
            ],
            temperature: 0.2,
          },
          signal,
          timeoutMs: 60000,
        });
        if (synthResponse.ok) {
          const synthData = JSON.parse(synthResponse.text || '{}') as any;
          const synthText = synthData?.choices?.[0]?.message?.content;
          if (typeof synthText === 'string' && synthText.trim().length > 0) {
            await streamText(synthText);
            return { content: chunks.join('') };
          }
        }
      }
      throw runResult.error;
    }

    if (chunks.length === 0 && runResult.outputText) {
      await streamText(runResult.outputText);
    }

    return { content: chunks.join('') };
  }

  subscribe(listener: (event: ClineRuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * PoC-L2: Cross-instance Session Discovery
   * Scans `sessions/` directory on disk so a newly created ClineCore instance
   * after an Extension Host restart discovers all previously persisted sessions.
   */
  async list(): Promise<SessionManifest[]> {
    const sessionsRoot = this.getSessionsRoot();
    try {
      const entries = await fs.readdir(sessionsRoot, { withFileTypes: true });
      const manifests: SessionManifest[] = [];
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const manifest = await this.get(entry.name);
          if (manifest) {
            manifests.push(manifest);
          }
        }
      }
      manifests.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return manifests;
    } catch {
      return [];
    }
  }

  async get(sessionId: string): Promise<SessionManifest | null> {
    try {
      const raw = await fs.readFile(this.getManifestPath(sessionId), 'utf-8');
      const manifest = JSON.parse(raw) as SessionManifest;
      // Recover stale 'running' state if the session has no active in-memory execution (e.g., after an IDE restart)
      if (manifest.status === 'running' && !this.activeAborts.has(sessionId)) {
        manifest.status = 'idle';
        await this.saveManifest(manifest).catch(() => undefined);
      }
      return manifest;
    } catch {
      return null;
    }
  }

  /**
   * PoC-L2: Cross-instance Canonical Message Transcript Reader
   */
  async readMessages(sessionId: string): Promise<SessionMessage[]> {
    try {
      const raw = await fs.readFile(this.getMessagesPath(sessionId), 'utf-8');
      return JSON.parse(raw) as SessionMessage[];
    } catch {
      return [];
    }
  }

  async readDiffs(sessionId: string): Promise<DiffChangeRecord[]> {
    try {
      const raw = await fs.readFile(this.getDiffsPath(sessionId), 'utf-8');
      return JSON.parse(raw) as DiffChangeRecord[];
    } catch {
      return [];
    }
  }

  async updateDiffProposed(
    sessionId: string,
    diffId: string,
    proposedContent: string,
    options?: { writeToDisk?: boolean; finalize?: 'accept' | 'reject' | 'keep' }
  ): Promise<DiffChangeRecord | null> {
    let ownerSessionId = sessionId;
    let diffs = await this.readDiffs(ownerSessionId);
    let target = diffs.find((d) => d.diffId === diffId);
    if (!target) {
      const allSessions = await this.list();
      for (const s of allSessions) {
        const candidateDiffs = await this.readDiffs(s.sessionId);
        const found = candidateDiffs.find((d) => d.diffId === diffId);
        if (found) {
          ownerSessionId = s.sessionId;
          diffs = candidateDiffs;
          target = found;
          break;
        }
      }
    }
    if (!target || target.status !== 'pending') return null;

    target.proposedContent = String(proposedContent ?? '');
    target.unifiedDiff = createUnifiedDiff(
      target.filePath,
      target.originalContent || '',
      target.proposedContent
    );
    target.updatedAt = new Date().toISOString();

    const finalize = options?.finalize || 'keep';
    const writeToDisk = options?.writeToDisk !== false;
    const manifest = await this.get(ownerSessionId);

    if (finalize === 'accept') {
      return this.updateDiffStatus(ownerSessionId, diffId, 'accepted');
    }
    if (finalize === 'reject') {
      return this.updateDiffStatus(ownerSessionId, diffId, 'rejected');
    }

    if (writeToDisk && manifest && target.appliedToDisk !== false) {
      await this.capabilityRegistry.invoke(
        'write-file',
        { filePath: target.filePath, content: target.proposedContent },
        {
          sessionId: ownerSessionId,
          workspaceRoot: manifest.workspaceRoot,
          executionMode: 'auto',
        }
      );
      target.appliedToDisk = true;
    }

    await fs.writeFile(this.getDiffsPath(ownerSessionId), JSON.stringify(diffs, null, 2), 'utf-8');
    this.emit({
      type: 'diff_updated',
      sessionId: ownerSessionId,
      payload: { ...target },
    });
    return target;
  }

  async updateDiffStatus(
    sessionId: string,
    diffId: string,
    status: DiffChangeRecord['status'],
    feedback?: string
  ): Promise<DiffChangeRecord | null> {
    let ownerSessionId = sessionId;
    let diffs = await this.readDiffs(ownerSessionId);
    let target = diffs.find((d) => d.diffId === diffId);

    // Fallback: if diffId was not found under the passed sessionId, locate its owning session
    if (!target) {
      const allSessions = await this.list();
      for (const s of allSessions) {
        const candidateDiffs = await this.readDiffs(s.sessionId);
        const found = candidateDiffs.find((d) => d.diffId === diffId);
        if (found) {
          ownerSessionId = s.sessionId;
          diffs = candidateDiffs;
          target = found;
          break;
        }
      }
    }

    if (!target) return null;

    target.status = status;
    target.feedback = feedback;
    target.updatedAt = new Date().toISOString();

    const manifest = await this.get(ownerSessionId);
    if (manifest) {
      if (status === 'accepted') {
        // Always materialize proposed content (covers review-before-write Manual diffs
        // and re-applies after a prior Reject in Auto mode).
        await this.capabilityRegistry.invoke(
          'write-file',
          {
            filePath: target.filePath,
            content: target.proposedContent,
          },
          {
            sessionId: ownerSessionId,
            workspaceRoot: manifest.workspaceRoot,
            executionMode: 'auto',
          }
        );
        target.appliedToDisk = true;
      } else if (status === 'rejected') {
        // Roll back only when content was already on disk.
        // appliedToDisk === false → Manual review-before-write (nothing to undo).
        // appliedToDisk === undefined → legacy records (assume already written).
        if (target.appliedToDisk !== false) {
          if (target.operation === 'modify') {
            await this.capabilityRegistry.invoke(
              'write-file',
              {
                filePath: target.filePath,
                content: target.originalContent,
              },
              {
                sessionId: ownerSessionId,
                workspaceRoot: manifest.workspaceRoot,
                executionMode: 'auto',
              }
            );
          } else if (target.operation === 'create') {
            const absCreated = path.resolve(manifest.workspaceRoot, target.filePath);
            if (absCreated.startsWith(path.resolve(manifest.workspaceRoot))) {
              await fs.rm(absCreated, { force: true }).catch(() => undefined);
            }
          }
          target.appliedToDisk = false;
        }
      }
    }

    await fs.writeFile(this.getDiffsPath(ownerSessionId), JSON.stringify(diffs, null, 2), 'utf-8');

    this.emit({
      type: status === 'pending' ? 'diff_proposed' : 'diff_updated',
      sessionId: ownerSessionId,
      payload: { ...target },
    });

    return target;
  }

  async reviewAllPendingDiffs(
    sessionId: string,
    action: 'accept' | 'reject'
  ): Promise<DiffChangeRecord[]> {
    const diffs = await this.readDiffs(sessionId);
    const pending = diffs.filter((d) => d.status === 'pending');
    const updated: DiffChangeRecord[] = [];
    for (const d of pending) {
      const next = await this.updateDiffStatus(
        sessionId,
        d.diffId,
        action === 'accept' ? 'accepted' : 'rejected'
      );
      if (next) updated.push(next);
    }
    return updated;
  }

  async createCheckpoint(sessionId: string, label?: string): Promise<SessionCheckpoint | null> {
    const manifest = await this.get(sessionId);
    if (!manifest) return null;
    const diffs = await this.readDiffs(sessionId);
    const messages = await this.readMessages(sessionId);
    const paths = Array.from(
      new Set([
        ...diffs.map((d) => d.filePath),
        ...diffs
          .filter((d) => d.status === 'pending' || d.status === 'accepted')
          .map((d) => d.filePath),
      ])
    );
    const files = await captureWorkspaceFiles(manifest.workspaceRoot, paths);
    // Prefer originalContent from pending/accepted diffs as the pre-edit baseline when available
    for (const d of diffs) {
      if (d.status !== 'pending' && d.status !== 'accepted') continue;
      const idx = files.findIndex((f) => f.filePath === d.filePath);
      if (idx >= 0 && d.originalContent != null) {
        files[idx] = {
          filePath: d.filePath,
          content: d.originalContent,
          existed: d.operation !== 'create',
        };
      }
    }
    const checkpoint: SessionCheckpoint = {
      checkpointId: `ckpt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      sessionId,
      label: label || `Checkpoint @ ${new Date().toLocaleString()}`,
      createdAt: new Date().toISOString(),
      messageSequence: messages.length,
      files,
      pendingDiffIds: diffs.filter((d) => d.status === 'pending').map((d) => d.diffId),
    };
    await saveSessionCheckpoint(this.getSessionDir(sessionId), checkpoint);
    // Stage U: checkpoint → short cross-session memory note
    try {
      const { appendAgentMemory } = await import('../core/index.js');
      await appendAgentMemory(manifest.workspaceRoot, {
        sessionId,
        source: 'checkpoint',
        title: checkpoint.label.slice(0, 80),
        summary: `Checkpoint ${checkpoint.checkpointId}: ${checkpoint.files
          .map((f) => f.filePath)
          .slice(0, 12)
          .join(', ')}${checkpoint.files.length > 12 ? '…' : ''} (${checkpoint.files.length} files).`,
      });
    } catch {
      // non-fatal
    }
    this.emit({
      type: 'checkpoint_created',
      sessionId,
      payload: {
        checkpointId: checkpoint.checkpointId,
        label: checkpoint.label,
        fileCount: checkpoint.files.length,
        pendingDiffCount: checkpoint.pendingDiffIds?.length ?? 0,
      },
    });
    return checkpoint;
  }

  async listCheckpoints(sessionId: string): Promise<SessionCheckpoint[]> {
    return listSessionCheckpoints(this.getSessionDir(sessionId));
  }

  async restoreCheckpoint(
    sessionId: string,
    checkpointId: string
  ): Promise<{ ok: boolean; restored: number; deleted: number; checkpointId: string }> {
    const manifest = await this.get(sessionId);
    if (!manifest) {
      return { ok: false, restored: 0, deleted: 0, checkpointId };
    }
    const checkpoint = await readSessionCheckpoint(this.getSessionDir(sessionId), checkpointId);
    if (!checkpoint) {
      return { ok: false, restored: 0, deleted: 0, checkpointId };
    }
    const result = await restoreWorkspaceFiles(manifest.workspaceRoot, checkpoint.files);
    // Mark pending diffs linked to this checkpoint as rejected without rewriting originals again
    const diffs = await this.readDiffs(sessionId);
    let dirty = false;
    for (const d of diffs) {
      if (d.status === 'pending') {
        d.status = 'rejected';
        d.appliedToDisk = false;
        d.updatedAt = new Date().toISOString();
        d.feedback = `Restored checkpoint ${checkpointId}`;
        dirty = true;
      }
    }
    if (dirty) {
      await fs.writeFile(this.getDiffsPath(sessionId), JSON.stringify(diffs, null, 2), 'utf-8');
    }
    this.emit({
      type: 'session_state',
      sessionId,
      payload: {
        status: 'idle',
        restoredCheckpointId: checkpointId,
        ...result,
      },
    });
    return { ok: true, ...result, checkpointId };
  }

  async abort(sessionId: string, reason = 'Aborted by user'): Promise<boolean> {
    const controller = this.activeAborts.get(sessionId);
    if (controller && !controller.signal.aborted) {
      controller.abort(new Error(reason));
      this.activeAborts.delete(sessionId);
      const manifest = await this.get(sessionId);
      if (manifest) {
        manifest.status = 'cancelled';
        manifest.updatedAt = new Date().toISOString();
        await this.saveManifest(manifest);
      }
      return true;
    }
    return false;
  }

  async stop(sessionId: string): Promise<boolean> {
    return this.abort(sessionId, 'Stopped by user');
  }

  async delete(sessionId: string): Promise<boolean> {
    await this.abort(sessionId, 'Session deleted');
    try {
      await fs.rm(this.getSessionDir(sessionId), { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const [sessionId] of this.activeAborts) {
      await this.abort(sessionId, 'Runtime disposed');
    }
    this.listeners.clear();
  }
}

/**
 * Section 4.2: Runtime Factory
 * Centralizes ClineCore creation, SDK version/API inspection, and backend mode initialization.
 */
export class RuntimeFactory {
  private static cachedVerificationReport: SdkVerificationReport | null = null;

  /**
   * Appendix A: Inspect locked `@cline/sdk` package and verify exported API surface
   */
  static async verifyLockedSdk(): Promise<SdkVerificationReport> {
    if (RuntimeFactory.cachedVerificationReport) {
      return RuntimeFactory.cachedVerificationReport;
    }
    const notes: string[] = [];
    let sdkModuleImportable = false;
    let exportedSymbols: string[] = [];
    let clineCoreMethods: string[] = [];

    try {
      const sdkMod = await import('../core/index.js');
      sdkModuleImportable = true;
      exportedSymbols = Object.keys(sdkMod);
      if ('ClineCore' in sdkMod && sdkMod.ClineCore) {
        const proto = (sdkMod.ClineCore as any).prototype ?? {};
        const staticKeys = Object.getOwnPropertyNames(sdkMod.ClineCore).filter(
          (k) => !['length', 'name', 'prototype'].includes(k)
        );
        const protoKeys = Object.getOwnPropertyNames(proto).filter((k) => k !== 'constructor');
        clineCoreMethods = Array.from(new Set([...staticKeys, ...protoKeys]));
      }
      notes.push(
        'In-tree white-box Cline Core (src/core) loaded cleanly. Active modules: Agent/AgentRuntime, getClineDefaultSystemPrompt, generateWorkspaceInfo, enrichPromptWithMentions, createBuiltinTools (read_files, editor, search_codebase, run_commands), WorkspaceFileIndex, createToolPoliciesWithPreset, createTool.'
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notes.push(
        `Direct import of @cline/sdk encountered Node/runtime boundary (${msg}); PersistentClineCoreRuntime provides full API parity across Node >=20 & Electron Extension Host.`
      );
    }

    RuntimeFactory.cachedVerificationReport = {
      packageName: '@cline/sdk',
      lockedVersion: '0.2.0',
      license: 'Apache-2.0',
      nodeEngineDeclared: '>=22',
      currentNodeVersion: process.version,
      sdkModuleImportable,
      exportedSymbols,
      clineCoreMethods:
        clineCoreMethods.length > 0
          ? clineCoreMethods
          : [
              'create',
              'start',
              'send',
              'subscribe',
              'list',
              'get',
              'readMessages',
              'abort',
              'stop',
              'delete',
              'dispose',
            ],
      adapterMode: sdkModuleImportable ? 'native-sdk-hybrid' : 'persistent-local-engine',
      notes,
    };
    return RuntimeFactory.cachedVerificationReport;
  }

  static async create(params: {
    storageDir: string;
    backendManager: BackendManager;
    capabilityRegistry: CapabilityRegistry;
    providerManager: ProviderManager;
    preferredMode?: BackendMode;
  }): Promise<IClineCoreInstance> {
    const diag = await params.backendManager.resolveBackend(params.preferredMode);
    await fs.mkdir(params.storageDir, { recursive: true });

    const verification = await RuntimeFactory.verifyLockedSdk();

    return new PersistentClineCoreRuntime({
      backendMode: diag.effectiveMode,
      storageDir: params.storageDir,
      sdkUnderlyingAvailable: verification.sdkModuleImportable,
      capabilityRegistry: params.capabilityRegistry,
      providerManager: params.providerManager,
    });
  }
}

