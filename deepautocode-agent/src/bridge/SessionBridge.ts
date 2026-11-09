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
import { globalTaskTraceStore } from '../core/trace/TaskTrace.js';
import {
  globalBackgroundTaskManager,
  type BackgroundTaskSnapshot,
} from '../core/BackgroundTaskManager.js';
import {
  globalQuestionBridge,
  type PendingQuestionPrompt,
} from '../core/QuestionBridge.js';

export interface ResumedSessionSnapshot {
  manifest: SessionManifest;
  messages: SessionMessage[];
  diffs: DiffChangeRecord[];
  missedEvents: EventMessage[];
  pendingApprovals: ReturnType<ApprovalBridge['getPendingApprovals']>;
  pendingQuestions?: PendingQuestionPrompt[];
  backgroundTasks?: BackgroundTaskSnapshot[];
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
        case 'diff_updated':
          this.eventBridge.emit(ev.sessionId, 'diff.updated', ev.payload);
          break;
        case 'model_tier':
          this.eventBridge.emit(ev.sessionId, 'model.tier', ev.payload);
          break;
        case 'checkpoint_created':
          this.eventBridge.emit(ev.sessionId, 'checkpoint.created', ev.payload);
          break;
        case 'session_state':
          this.eventBridge.emit(ev.sessionId, 'session.state.changed', ev.payload);
          break;
        case 'error':
          this.eventBridge.emit(ev.sessionId, 'runtime.error', ev.payload);
          break;
        case 'sandbox_branch_created':
          this.eventBridge.emit(ev.sessionId, 'sandbox.branch.created', ev.payload);
          break;
        case 'circuit_breaker_triggered':
          this.eventBridge.emit(ev.sessionId, 'circuit.breaker.triggered', ev.payload);
          break;
        case 'artifact_created':
          this.eventBridge.emit(ev.sessionId, 'artifact.created', ev.payload);
          break;
        case 'goal_usage':
          this.eventBridge.emit(ev.sessionId, 'goal.usage', ev.payload);
          break;
        case 'trace_updated':
          this.eventBridge.emit(ev.sessionId, 'trace.updated', ev.payload);
          break;
        case 'question_requested':
          this.eventBridge.emit(ev.sessionId, 'question.requested', ev.payload);
          break;
        case 'question_resolved':
          this.eventBridge.emit(ev.sessionId, 'question.resolved', ev.payload);
          break;
        case 'task_state_changed':
          this.eventBridge.emit(ev.sessionId, 'task.state.changed', ev.payload);
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
    /** Stage W: isolate in git worktree (used by ∥ Parallel) */
    useWorktree?: boolean;
  }): Promise<{
    sessionId: string;
    manifest: SessionManifest;
    manifestPath: string;
  }> {
    const res = await this.runtime.start({
      title: input.title,
      prompt: input.prompt,
      useWorktree: Boolean(input.useWorktree),
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
    images?: Array<{ name?: string; dataUrl: string; mimeType?: string }>;
  }): Promise<SessionMessage> {
    const signal = this.resourceManager.createSessionTaskSignal(input.sessionId);
    try {
      const { message } = await this.runtime.send({
        sessionId: input.sessionId,
        prompt: input.prompt,
        workspaceRoot: input.workspaceRoot,
        executionMode: input.executionMode,
        modelId: input.modelId,
        images: input.images,
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
          modelId: 'deepseek-flash',
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
    const pendingQuestions = globalQuestionBridge.getPendingForSession(sessionId);
    const backgroundTasks = globalBackgroundTaskManager.listTasks(sessionId);

    return {
      manifest,
      messages,
      diffs,
      missedEvents,
      pendingApprovals,
      pendingQuestions,
      backgroundTasks,
      recoveredAcrossInstanceRestart,
    };
  }

  async updateDiffProposed(params: {
    sessionId: string;
    diffId: string;
    proposedContent: string;
    writeToDisk?: boolean;
    finalize?: 'accept' | 'reject' | 'keep';
  }): Promise<DiffChangeRecord> {
    const updated = await this.runtime.updateDiffProposed(
      params.sessionId,
      params.diffId,
      params.proposedContent,
      {
        writeToDisk: params.writeToDisk,
        finalize: params.finalize,
      }
    );
    if (!updated) {
      throw new Error(
        `DIFF_NOT_FOUND: Diff "${params.diffId}" not found or not pending in session "${params.sessionId}"`
      );
    }
    return updated;
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
    pendingDiffsPreserved: number;
  }> {
    this.resourceManager.cancelSessionTask(sessionId, reason);
    const cancelledApprovals = this.approvalBridge.cancelSessionApprovals(sessionId, reason);
    globalQuestionBridge.cancelSessionQuestions(sessionId);
    globalBackgroundTaskManager.killSessionTasks(sessionId, false);
    const abortedRuntime = await this.runtime.abort(sessionId, reason);
    // Stop preserves pending Diffs for Accept/Reject review (Cursor-like).
    const diffs = await this.runtime.readDiffs(sessionId);
    const pendingDiffsPreserved = diffs.filter((d) => d.status === 'pending').length;
    return {
      abortedRuntime,
      cancelledApprovals,
      pendingDiffsPreserved,
    };
  }

  async reviewAllPendingDiffs(
    sessionId: string,
    action: 'accept' | 'reject'
  ): Promise<DiffChangeRecord[]> {
    return this.runtime.reviewAllPendingDiffs(sessionId, action);
  }

  async createCheckpoint(sessionId: string, label?: string) {
    return this.runtime.createCheckpoint(sessionId, label);
  }

  async listCheckpoints(sessionId: string) {
    return this.runtime.listCheckpoints(sessionId);
  }

  async restoreCheckpoint(sessionId: string, checkpointId: string) {
    return this.runtime.restoreCheckpoint(sessionId, checkpointId);
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    await this.cancelSession(sessionId, 'Session deleted');
    this.eventBridge.clearSession(sessionId);
    this.createdInCurrentInstance.delete(sessionId);
    return this.runtime.delete(sessionId);
  }

  getTrace(params: { taskId?: string; sessionId?: string }) {
    if (params.taskId) {
      return globalTaskTraceStore.get(params.taskId);
    }
    if (params.sessionId) {
      return globalTaskTraceStore.getBySession(params.sessionId);
    }
    return null;
  }

  listTraces(limit = 20) {
    return globalTaskTraceStore.list(limit);
  }
}

