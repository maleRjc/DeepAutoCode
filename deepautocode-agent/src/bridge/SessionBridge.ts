import type {
  AgentExecutionMode,
  DiffChangeRecord,
  EventMessage,
  SessionManifest,
  SessionMessage,
} from '../types.js';
import type { ApprovalBridge } from './ApprovalBridge.js';
import type { EventBridge } from './EventBridge.js';
import type { IClineCoreInstance } from '../runtime/RuntimeFactory.js';
import type { ResourceManager } from '../runtime/ResourceManager.js';

export interface ResumedSessionSnapshot {
  manifest: SessionManifest;
  messages: SessionMessage[];
  diffs: DiffChangeRecord[];
  missedEvents: EventMessage[];
  pendingApprovals: ReturnType<ApprovalBridge['getPendingApprovals']>;
  recoveredAcrossInstanceRestart: boolean;
}

/**
 * Section 4.2 & 5.5 (ADR-009): Session Bridge
 * Wraps session creation, listing, cross-instance recovery (PoC-L2), cancellation, and disposal.
 * Coordinates EventBridge sequence seeding and ApprovalBridge cleanup when sessions are resumed or cancelled.
 */
export class SessionBridge {
  private runtime: IClineCoreInstance;
  private readonly eventBridge: EventBridge;
  private readonly approvalBridge: ApprovalBridge;
  private readonly resourceManager: ResourceManager;
  private readonly createdInCurrentInstance = new Set<string>();
  private runtimeUnsubscribe?: () => void;

  constructor(params: {
    runtime: IClineCoreInstance;
    eventBridge: EventBridge;
    approvalBridge: ApprovalBridge;
    resourceManager: ResourceManager;
  }) {
    this.runtime = params.runtime;
    this.eventBridge = params.eventBridge;
    this.approvalBridge = params.approvalBridge;
    this.resourceManager = params.resourceManager;
    this.bindRuntimeEvents(this.runtime);
  }

  /**
   * Rebind to a newly created ClineCore instance (e.g., after Extension Host restart or backend mode switch)
   */
  rebindRuntime(newRuntime: IClineCoreInstance): void {
    if (this.runtimeUnsubscribe) {
      this.runtimeUnsubscribe();
    }
    this.runtime = newRuntime;
    this.createdInCurrentInstance.clear();
    this.bindRuntimeEvents(newRuntime);
  }

  private bindRuntimeEvents(runtime: IClineCoreInstance): void {
    this.runtimeUnsubscribe = runtime.subscribe((ev) => {
      switch (ev.type) {
        case 'text_delta':
          this.eventBridge.emit(ev.sessionId, 'assistant.text.delta', ev.payload);
          break;
        case 'text_done':
          this.eventBridge.emit(ev.sessionId, 'assistant.text.done', ev.payload);
          break;
        case 'tool_call_started':
          this.eventBridge.emit(ev.sessionId, 'tool.call.started', ev.payload);
          break;
        case 'tool_call_completed':
          this.eventBridge.emit(ev.sessionId, 'tool.call.completed', ev.payload);
          break;
        case 'tool_call_failed':
          this.eventBridge.emit(ev.sessionId, 'tool.call.failed', ev.payload);
          break;
        case 'diff_proposed':
          this.eventBridge.emit(ev.sessionId, 'diff.proposed', ev.payload);
          break;
        case 'session_state':
          this.eventBridge.emit(ev.sessionId, 'session.state.changed', ev.payload);
          break;
        case 'error':
          this.eventBridge.emit(ev.sessionId, 'runtime.error', ev.payload);
          break;
      }
    });

    this.resourceManager.register({
      id: `runtime-sub:${runtime.instanceId}`,
      category: 'subscription',
      dispose: () => {
        if (this.runtimeUnsubscribe) {
          this.runtimeUnsubscribe();
          this.runtimeUnsubscribe = undefined;
        }
      },
    });
  }

  async createSession(input: {
    title?: string;
    prompt?: string;
    workspaceRoot: string;
    providerId: string;
    modelId: string;
    apiKey?: string;
    executionMode?: AgentExecutionMode;
  }): Promise<{
    sessionId: string;
    manifest: SessionManifest;
    manifestPath: string;
  }> {
    const res = await this.runtime.start({
      title: input.title,
      prompt: input.prompt,
      config: {
        providerId: input.providerId,
        modelId: input.modelId,
        apiKey: input.apiKey,
        cwd: input.workspaceRoot,
        workspaceRoot: input.workspaceRoot,
        executionMode: input.executionMode ?? 'auto',
        enableTools: true,
      },
    });
    this.createdInCurrentInstance.add(res.sessionId);
    return res;
  }

  async sendPrompt(input: {
    sessionId: string;
    prompt: string;
    workspaceRoot?: string;
    executionMode?: AgentExecutionMode;
    modelId?: string;
  }): Promise<SessionMessage> {
    const signal = this.resourceManager.createSessionTaskSignal(input.sessionId);
    try {
      const { message } = await this.runtime.send({
        sessionId: input.sessionId,
        prompt: input.prompt,
        workspaceRoot: input.workspaceRoot,
        executionMode: input.executionMode,
        modelId: input.modelId,
        signal,
      });
      return message;
    } finally {
      this.resourceManager.clearSessionTaskSignal(input.sessionId);
    }
  }

  async listSessions(): Promise<SessionManifest[]> {
    return this.runtime.list();
  }

  /**
   * Section 5.5 (PoC-L2) & Section 6.2: Resume Session & Replay Missed Events
   * Supports both:
   *  1. Webview close/reopen within same Extension Host (replays missed events since `lastSequence`).
   *  2. Extension Host restart / new ClineCore instance (loads persisted manifest, messages, diffs from disk and seeds sequence counter).
   */
  async resumeSession(
    sessionId: string,
    lastSequence = 0
  ): Promise<ResumedSessionSnapshot> {
    let manifest = await this.runtime.get(sessionId);
    if (!manifest) {
      const created = await this.runtime.start({
        sessionId,
        title: 'AI Session',
        config: {
          providerId: 'deepseek',
          modelId: 'deepseek-chat',
          cwd: process.cwd(),
          workspaceRoot: process.cwd(),
          executionMode: 'auto',
          enableTools: true,
        },
      });
      manifest = created.manifest;
    }

    const messages = await this.runtime.readMessages(sessionId);
    const diffs = await this.runtime.readDiffs(sessionId);
    const recoveredAcrossInstanceRestart = !this.createdInCurrentInstance.has(sessionId);

    // Seed EventBridge sequence so subsequent events never collide with restored history
    this.eventBridge.seedSessionSequence(
      sessionId,
      Math.max(manifest.lastSequence, messages.length)
    );

    const missedEvents = this.eventBridge.getEventsSince(sessionId, lastSequence);
    const pendingApprovals = this.approvalBridge.getPendingApprovals(sessionId);

    return {
      manifest,
      messages,
      diffs,
      missedEvents,
      pendingApprovals,
      recoveredAcrossInstanceRestart,
    };
  }

  async reviewDiff(params: {
    sessionId: string;
    diffId: string;
    action: 'accept' | 'reject' | 'revise';
    feedback?: string;
  }): Promise<DiffChangeRecord> {
    const statusMap: Record<'accept' | 'reject' | 'revise', DiffChangeRecord['status']> = {
      accept: 'accepted',
      reject: 'rejected',
      revise: 'revising',
    };
    const updated = await this.runtime.updateDiffStatus(
      params.sessionId,
      params.diffId,
      statusMap[params.action],
      params.feedback
    );
    if (!updated) {
      throw new Error(`DIFF_NOT_FOUND: Diff "${params.diffId}" not found in session "${params.sessionId}"`);
    }

    if (params.action === 'revise' && params.feedback) {
      await this.sendPrompt({
        sessionId: params.sessionId,
        prompt: `请根据审阅反馈继续修改文件 ${updated.filePath}：${params.feedback}`,
      });
    }

    return updated;
  }

  async cancelSession(sessionId: string, reason = 'Cancelled by user'): Promise<{
    abortedRuntime: boolean;
    cancelledApprovals: number;
  }> {
    this.resourceManager.cancelSessionTask(sessionId, reason);
    const cancelledApprovals = this.approvalBridge.cancelSessionApprovals(sessionId, reason);
    const abortedRuntime = await this.runtime.abort(sessionId, reason);
    return {
      abortedRuntime,
      cancelledApprovals,
    };
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    await this.cancelSession(sessionId, 'Session deleted');
    this.eventBridge.clearSession(sessionId);
    this.createdInCurrentInstance.delete(sessionId);
    return this.runtime.delete(sessionId);
  }
}

