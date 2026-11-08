import fs from 'node:fs/promises';
import path from 'node:path';

export type TraceTerminalStatus =
  | 'running'
  | 'success'
  | 'circuit'
  | 'abort'
  | 'error';

export type TraceEventKind =
  | 'task.start'
  | 'llm.turn'
  | 'tool.call'
  | 'verify.result'
  | 'agent.signal'
  | 'task.end';

export interface TraceEventBase {
  ts: string;
  kind: TraceEventKind;
  taskId: string;
  sessionId: string;
}

export interface TraceTaskStart extends TraceEventBase {
  kind: 'task.start';
  mode: string;
  promptSummary: string;
  modelId?: string;
}

export interface TraceLlmTurn extends TraceEventBase {
  kind: 'llm.turn';
  turnIndex: number;
  modelId: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  tokensUsed: number;
  tokenBudget: number;
}

export interface TraceToolCall extends TraceEventBase {
  kind: 'tool.call';
  toolCallId: string;
  toolName: string;
  argDigest: string;
  resultBytes: number;
  durationMs: number;
  ok: boolean;
  error?: string;
}

export interface TraceVerifyResult extends TraceEventBase {
  kind: 'verify.result';
  passed: boolean;
  summary: string;
}

export interface TraceAgentSignal extends TraceEventBase {
  kind: 'agent.signal';
  signal: 'mistake' | 'loop' | 'checkpoint' | 'compaction';
  summary: string;
  detail?: Record<string, unknown>;
}

export interface TraceTaskEnd extends TraceEventBase {
  kind: 'task.end';
  status: TraceTerminalStatus;
  totalTurns: number;
  tokensUsed: number;
  tokenBudget: number;
  cacheReadTokens: number;
  reason?: string;
}

export type TraceEvent =
  | TraceTaskStart
  | TraceLlmTurn
  | TraceToolCall
  | TraceVerifyResult
  | TraceAgentSignal
  | TraceTaskEnd;

export interface TaskTraceSnapshot {
  taskId: string;
  sessionId: string;
  mode: string;
  promptSummary: string;
  status: TraceTerminalStatus;
  startedAt: string;
  endedAt?: string;
  totalTurns: number;
  tokensUsed: number;
  tokenBudget: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  events: TraceEvent[];
}

const MEMORY_RING_MAX = 40;
const EVENTS_PER_TASK_MAX = 500;

function nowIso(): string {
  return new Date().toISOString();
}

export function digestArgs(args: unknown, maxLen = 240): string {
  try {
    const raw = JSON.stringify(args ?? {});
    if (raw.length <= maxLen) return raw;
    return `${raw.slice(0, maxLen)}…`;
  } catch {
    return String(args ?? '');
  }
}

export function summarizePrompt(prompt: string, maxLen = 240): string {
  const cleaned = String(prompt || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen)}…`;
}

export function estimateResultBytes(result: unknown): number {
  try {
    if (typeof result === 'string') return Buffer.byteLength(result, 'utf8');
    return Buffer.byteLength(JSON.stringify(result ?? null), 'utf8');
  } catch {
    return 0;
  }
}

/**
 * Durable JSONL task traces under `.deepautocode/traces/<taskId>.jsonl`
 * plus a small in-memory ring for UI / RPC.
 */
export class TaskTraceStore {
  private readonly byTask = new Map<string, TaskTraceSnapshot>();
  private readonly order: string[] = [];
  private readonly sessionToTask = new Map<string, string>();

  resolveTaskId(sessionId: string): string | undefined {
    return this.sessionToTask.get(sessionId);
  }

  list(limit = 20): TaskTraceSnapshot[] {
    const n = Math.max(1, Math.min(100, limit));
    return this.order
      .slice(-n)
      .reverse()
      .map((id) => this.cloneSnapshot(this.byTask.get(id)!))
      .filter(Boolean);
  }

  get(taskId: string): TaskTraceSnapshot | null {
    const snap = this.byTask.get(taskId);
    return snap ? this.cloneSnapshot(snap) : null;
  }

  getBySession(sessionId: string): TaskTraceSnapshot | null {
    const taskId = this.sessionToTask.get(sessionId);
    if (!taskId) return null;
    return this.get(taskId);
  }

  startTask(params: {
    taskId: string;
    sessionId: string;
    mode: string;
    prompt: string;
    modelId?: string;
    workspaceRoot: string;
    tokenBudget?: number;
  }): TraceTaskStart {
    const startedAt = nowIso();
    const event: TraceTaskStart = {
      ts: startedAt,
      kind: 'task.start',
      taskId: params.taskId,
      sessionId: params.sessionId,
      mode: params.mode || 'auto',
      promptSummary: summarizePrompt(params.prompt),
      modelId: params.modelId,
    };
    const snap: TaskTraceSnapshot = {
      taskId: params.taskId,
      sessionId: params.sessionId,
      mode: event.mode,
      promptSummary: event.promptSummary,
      status: 'running',
      startedAt,
      totalTurns: 0,
      tokensUsed: 0,
      tokenBudget: Number(params.tokenBudget ?? 180000),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      events: [event],
    };
    this.remember(snap);
    this.sessionToTask.set(params.sessionId, params.taskId);
    void this.appendJsonl(params.workspaceRoot, event);
    return event;
  }

  recordLlmTurn(params: {
    workspaceRoot: string;
    sessionId: string;
    taskId?: string;
    turnIndex: number;
    modelId: string;
    latencyMs: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    tokensUsed: number;
    tokenBudget: number;
  }): TraceLlmTurn | null {
    const taskId = params.taskId || this.sessionToTask.get(params.sessionId);
    if (!taskId) return null;
    const snap = this.byTask.get(taskId);
    if (!snap) return null;
    const event: TraceLlmTurn = {
      ts: nowIso(),
      kind: 'llm.turn',
      taskId,
      sessionId: params.sessionId,
      turnIndex: params.turnIndex,
      modelId: params.modelId,
      latencyMs: Math.max(0, Math.round(params.latencyMs)),
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      cacheReadTokens: params.cacheReadTokens,
      cacheWriteTokens: params.cacheWriteTokens,
      tokensUsed: params.tokensUsed,
      tokenBudget: params.tokenBudget,
    };
    snap.totalTurns = Math.max(snap.totalTurns, params.turnIndex + 1);
    snap.tokensUsed = params.tokensUsed;
    snap.tokenBudget = params.tokenBudget;
    snap.cacheReadTokens += params.cacheReadTokens;
    snap.cacheWriteTokens += params.cacheWriteTokens;
    this.pushEvent(snap, event);
    void this.appendJsonl(params.workspaceRoot, event);
    return event;
  }

  recordToolCall(params: {
    workspaceRoot: string;
    sessionId: string;
    taskId?: string;
    toolCallId: string;
    toolName: string;
    args: unknown;
    result?: unknown;
    durationMs: number;
    ok: boolean;
    error?: string;
  }): TraceToolCall | null {
    const taskId = params.taskId || this.sessionToTask.get(params.sessionId);
    if (!taskId) return null;
    const snap = this.byTask.get(taskId);
    if (!snap) return null;
    const event: TraceToolCall = {
      ts: nowIso(),
      kind: 'tool.call',
      taskId,
      sessionId: params.sessionId,
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      argDigest: digestArgs(params.args),
      resultBytes: estimateResultBytes(params.result ?? params.error ?? ''),
      durationMs: Math.max(0, Math.round(params.durationMs)),
      ok: params.ok,
      error: params.error,
    };
    this.pushEvent(snap, event);
    void this.appendJsonl(params.workspaceRoot, event);
    return event;
  }

  recordVerify(params: {
    workspaceRoot: string;
    sessionId: string;
    taskId?: string;
    passed: boolean;
    summary: string;
  }): TraceVerifyResult | null {
    const taskId = params.taskId || this.sessionToTask.get(params.sessionId);
    if (!taskId) return null;
    const snap = this.byTask.get(taskId);
    if (!snap) return null;
    const event: TraceVerifyResult = {
      ts: nowIso(),
      kind: 'verify.result',
      taskId,
      sessionId: params.sessionId,
      passed: params.passed,
      summary: summarizePrompt(params.summary, 400),
    };
    this.pushEvent(snap, event);
    void this.appendJsonl(params.workspaceRoot, event);
    return event;
  }

  recordSignal(params: {
    workspaceRoot: string;
    sessionId: string;
    taskId?: string;
    signal: TraceAgentSignal['signal'];
    summary: string;
    detail?: Record<string, unknown>;
  }): TraceAgentSignal | null {
    const taskId = params.taskId || this.sessionToTask.get(params.sessionId);
    if (!taskId) return null;
    const snap = this.byTask.get(taskId);
    if (!snap) return null;
    const event: TraceAgentSignal = {
      ts: nowIso(),
      kind: 'agent.signal',
      taskId,
      sessionId: params.sessionId,
      signal: params.signal,
      summary: summarizePrompt(params.summary, 400),
      detail: params.detail,
    };
    this.pushEvent(snap, event);
    void this.appendJsonl(params.workspaceRoot, event);
    return event;
  }

  endTask(params: {
    workspaceRoot: string;
    sessionId: string;
    taskId?: string;
    status: TraceTerminalStatus;
    reason?: string;
  }): TraceTaskEnd | null {
    const taskId = params.taskId || this.sessionToTask.get(params.sessionId);
    if (!taskId) return null;
    const snap = this.byTask.get(taskId);
    if (!snap) return null;
    const event: TraceTaskEnd = {
      ts: nowIso(),
      kind: 'task.end',
      taskId,
      sessionId: params.sessionId,
      status: params.status,
      totalTurns: snap.totalTurns,
      tokensUsed: snap.tokensUsed,
      tokenBudget: snap.tokenBudget,
      cacheReadTokens: snap.cacheReadTokens,
      reason: params.reason,
    };
    snap.status = params.status === 'running' ? 'success' : params.status;
    snap.endedAt = event.ts;
    this.pushEvent(snap, event);
    void this.appendJsonl(params.workspaceRoot, event);
    return event;
  }

  private pushEvent(snap: TaskTraceSnapshot, event: TraceEvent): void {
    snap.events.push(event);
    if (snap.events.length > EVENTS_PER_TASK_MAX) {
      snap.events.splice(0, snap.events.length - EVENTS_PER_TASK_MAX);
    }
  }

  private remember(snap: TaskTraceSnapshot): void {
    if (!this.byTask.has(snap.taskId)) {
      this.order.push(snap.taskId);
      while (this.order.length > MEMORY_RING_MAX) {
        const dropped = this.order.shift();
        if (dropped) {
          const old = this.byTask.get(dropped);
          if (old) this.sessionToTask.delete(old.sessionId);
          this.byTask.delete(dropped);
        }
      }
    }
    this.byTask.set(snap.taskId, snap);
  }

  private cloneSnapshot(snap: TaskTraceSnapshot): TaskTraceSnapshot {
    return {
      ...snap,
      events: snap.events.slice(),
    };
  }

  private async appendJsonl(
    workspaceRoot: string,
    event: TraceEvent
  ): Promise<void> {
    if (!workspaceRoot) return;
    try {
      const dir = path.join(workspaceRoot, '.deepautocode', 'traces');
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `${event.taskId}.jsonl`);
      await fs.appendFile(file, `${JSON.stringify(event)}\n`, 'utf8');
    } catch {
      // non-fatal: UI can still use in-memory ring
    }
  }
}

export const globalTaskTraceStore = new TaskTraceStore();
