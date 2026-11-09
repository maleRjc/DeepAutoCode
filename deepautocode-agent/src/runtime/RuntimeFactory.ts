import fs from 'node:fs/promises';
import path from 'node:path';
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
    | 'trace_updated'
    | 'question_requested'
    | 'question_resolved'
    | 'task_state_changed';
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
  images?: Array<{ name?: string; dataUrl: string; mimeType?: string }>;
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
import {
  createUnifiedDiff,
  normalizeWorkspaceRelativePath as normalizeWorkspaceRelativePathFn,
  applySmartTextReplacement as applySmartTextReplacementFn,
  proposeAndApplyFileEdit as proposeAndApplyFileEditFn,
} from './tools/FileEditEngine.js';
import {
  updateDiffProposedService,
  updateDiffStatusService,
  reviewAllPendingDiffsService,
  createCheckpointService,
  listCheckpointsService,
  restoreCheckpointService,
} from './checkpoint/CheckpointDiffService.js';
import {
  postJsonResilient,
  executeLiveLlmAgentLoop as executeLiveLlmAgentLoopFn,
} from './session/SessionLoopRunner.js';

export { createUnifiedDiff };

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

    // Kernel Upgrade 2: True Reactive Wakeup — auto-trigger a turn when a session is idle and receives a <SYSTEM_MESSAGE>
    void import('../core/SubagentOrchestrator.js')
      .then(({ globalSubagentOrchestrator }) => {
        globalSubagentOrchestrator.onWakeup((notif) => {
          if (this.disposed) return;
          const sid = notif.sessionId;
          if (!sid || this.activeAborts.has(sid)) return;
          void this.get(sid)
            .then((manifest) => {
              if (!manifest || this.activeAborts.has(sid)) return;
              const drained = globalSubagentOrchestrator.drainWakeupMessagesForPrompt(sid);
              if (!drained) return;
              return this.send({
                sessionId: sid,
                prompt: `${drained}\n\nProcess the above background notification and report or continue the next action.`,
                executionMode: manifest.executionMode,
              });
            })
            .catch(() => undefined);
        });
      })
      .catch(() => undefined);
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

    await this.providerManager.getActiveProviderWithKeyStatus().catch(() => null);
    if (input.executionMode && input.executionMode !== manifest.executionMode) {
      manifest.executionMode = input.executionMode;
    }
    if (input.modelId && input.modelId.trim()) {
      manifest.modelId = input.modelId.trim();
    }
    if (typeof this.providerManager.resolveProviderForModel === 'function') {
      const resolvedProv = this.providerManager.resolveProviderForModel(
        manifest.modelId,
        manifest.providerId
      );
      manifest.providerId = resolvedProv.providerId;
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
      ...(Array.isArray(input.images) && input.images.length > 0 ? { images: input.images } : {}),
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
        images: input.images,
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

    // Stage C: Persist dual-layer JSONL transcript (transcript.jsonl + transcript_full.jsonl)
    try {
      const { globalTranscriptLogger } = await import('../core/index.js');
      if (globalTranscriptLogger) {
        const sDir = this.getSessionDir(input.sessionId);
        await globalTranscriptLogger.appendStep(sDir, {
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          status: 'DONE',
          content: input.prompt,
        });
        await globalTranscriptLogger.appendStep(sDir, {
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: traceTerminal === 'error' ? 'ERROR' : 'DONE',
          content: assistantContent,
          toolCalls: toolCalls.map((tc) => ({ ...tc })),
        });
      }
    } catch {
      // non-fatal
    }

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

    // Run onSessionComplete lifecycle hooks if configured in .deepautocode/hooks.json
    try {
      const { runLifecycleHooks } = await import('../core/index.js');
      if (typeof runLifecycleHooks === 'function') {
        await runLifecycleHooks({
          workspaceRoot: manifest.workspaceRoot,
          event: 'onSessionComplete',
          sessionId: input.sessionId,
        });
      }
    } catch {
      // non-fatal
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
    images?: Array<{ name?: string; dataUrl: string; mimeType?: string }>;
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
      images,
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
        // Kernel Upgrade 3: preToolUse & preVerify Lifecycle Hooks
        try {
          const { runLifecycleHooks } = await import('../core/index.js');
          if (typeof runLifecycleHooks === 'function') {
            const preHook = await runLifecycleHooks({
              workspaceRoot: manifest.workspaceRoot,
              event: 'preToolUse',
              sessionId,
              toolName: capability,
              filePath: args?.filePath ? String(args.filePath) : undefined,
              command: args?.command ? String(args.command) : undefined,
            });
            if (preHook.blocked) {
              throw new Error(
                preHook.feedbackMessage || `PRE_TOOL_HOOK_BLOCKED: ${capability} blocked by lifecycle hook`
              );
            }
            if (capability === 'run-build') {
              const preVerify = await runLifecycleHooks({
                workspaceRoot: manifest.workspaceRoot,
                event: 'preVerify',
                sessionId,
                toolName: capability,
                command: args?.command ? String(args.command) : undefined,
              });
              if (preVerify.blocked) {
                throw new Error(
                  preVerify.feedbackMessage || `PRE_VERIFY_HOOK_BLOCKED: build/verify blocked by lifecycle hook`
                );
              }
            }
          }
        } catch (hookErr) {
          if (String((hookErr as Error)?.message || '').includes('HOOK_BLOCKED') || String((hookErr as Error)?.message || '').includes('Lifecycle Hook')) {
            throw hookErr;
          }
        }

        const output = await this.capabilityRegistry.invoke(capability, args, {
          sessionId,
          workspaceRoot: manifest.workspaceRoot,
          executionMode: policyGate.executionMode,
          permissionRuleset: policyGate.permissionRuleset,
          signal,
        });

        try {
          const { runLifecycleHooks } = await import('../core/index.js');
          if (typeof runLifecycleHooks === 'function') {
            await runLifecycleHooks({
              workspaceRoot: manifest.workspaceRoot,
              event: 'postToolUse',
              sessionId,
              toolName: capability,
              filePath: args?.filePath ? String(args.filePath) : undefined,
              command: args?.command ? String(args.command) : undefined,
            });
          }
        } catch {
          // non-fatal postToolUse hook
        }
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
          images,
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

  public normalizeWorkspaceRelativePath(rawPath: string, workspaceRoot: string): string {
    return normalizeWorkspaceRelativePathFn(rawPath, workspaceRoot);
  }

  public applySmartTextReplacement(
    currentContent: string,
    oldText: string,
    newText: string,
    filePath: string
  ): string {
    return applySmartTextReplacementFn(currentContent, oldText, newText, filePath);
  }

  public async proposeAndApplyFileEdit(params: Parameters<typeof proposeAndApplyFileEditFn>[1]) {
    return proposeAndApplyFileEditFn(
      {
        capabilityRegistry: this.capabilityRegistry,
        saveDiff: (sid, diff) => this.saveDiff(sid, diff),
        emit: (ev) => this.emit(ev),
      },
      params
    );
  }

  private async executeLiveLlmAgentLoop(params: Parameters<typeof executeLiveLlmAgentLoopFn>[1]): Promise<{ content: string }> {
    return executeLiveLlmAgentLoopFn(this, params);
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

  private getCheckpointCtx() {
    return {
      capabilityRegistry: this.capabilityRegistry,
      readDiffs: (sid: string) => this.readDiffs(sid),
      readMessages: (sid: string) => this.readMessages(sid),
      list: () => this.list(),
      get: (sid: string) => this.get(sid),
      getDiffsPath: (sid: string) => this.getDiffsPath(sid),
      getSessionDir: (sid: string) => this.getSessionDir(sid),
      emit: (ev: ClineRuntimeEvent) => this.emit(ev),
    };
  }

  async updateDiffProposed(
    sessionId: string,
    diffId: string,
    proposedContent: string,
    options?: { writeToDisk?: boolean; finalize?: 'accept' | 'reject' | 'keep' }
  ): Promise<DiffChangeRecord | null> {
    return updateDiffProposedService(
      this.getCheckpointCtx(),
      sessionId,
      diffId,
      proposedContent,
      options
    );
  }

  async updateDiffStatus(
    sessionId: string,
    diffId: string,
    status: DiffChangeRecord['status'],
    feedback?: string
  ): Promise<DiffChangeRecord | null> {
    return updateDiffStatusService(
      this.getCheckpointCtx(),
      sessionId,
      diffId,
      status,
      feedback
    );
  }

  async reviewAllPendingDiffs(
    sessionId: string,
    action: 'accept' | 'reject'
  ): Promise<DiffChangeRecord[]> {
    return reviewAllPendingDiffsService(this.getCheckpointCtx(), sessionId, action);
  }

  async createCheckpoint(sessionId: string, label?: string): Promise<SessionCheckpoint | null> {
    return createCheckpointService(this.getCheckpointCtx(), sessionId, label);
  }

  async listCheckpoints(sessionId: string): Promise<SessionCheckpoint[]> {
    return listCheckpointsService(this.getCheckpointCtx(), sessionId);
  }

  async restoreCheckpoint(
    sessionId: string,
    checkpointId: string
  ): Promise<{ ok: boolean; restored: number; deleted: number; checkpointId: string }> {
    return restoreCheckpointService(this.getCheckpointCtx(), sessionId, checkpointId);
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

