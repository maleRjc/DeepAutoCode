import { ApprovalRequestPayloadSchema, type ApprovalRequestPayload, type RiskLevel } from '../types.js';
import type { EventBridge } from './EventBridge.js';

export interface ApprovalDecision {
  approvalId: string;
  approved: boolean;
  reason?: string;
  decidedBy: 'user' | 'timeout' | 'cancelled' | 'policy';
  decidedAt: string;
}

interface PendingApproval {
  payload: ApprovalRequestPayload;
  resolve: (decision: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
}

/**
 * Section 4.2, 6.2 & 9.2: Approval Bridge
 * Manages human-in-the-loop tool & capability approvals with timeout, cancellation, and reconnect state preservation.
 */
export class ApprovalBridge {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly resolvedHistory = new Map<string, ApprovalDecision>();
  private readonly eventBridge: EventBridge;
  private readonly defaultTimeoutMs: number;

  constructor(eventBridge: EventBridge, options?: { defaultTimeoutMs?: number }) {
    this.eventBridge = eventBridge;
    this.defaultTimeoutMs = options?.defaultTimeoutMs ?? 120_000;
  }

  /**
   * Request user approval and emit `approval.requested` event to UI
   */
  async requestApproval(input: {
    sessionId: string;
    toolName: string;
    summary: string;
    risk: RiskLevel;
    targetPath?: string;
    command?: string;
    cwd?: string;
    arguments?: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<ApprovalDecision> {
    const approvalId = `appr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const timeoutMs = input.timeoutMs ?? this.defaultTimeoutMs;
    const expiresAt = new Date(Date.now() + timeoutMs).toISOString();

    const payload: ApprovalRequestPayload = ApprovalRequestPayloadSchema.parse({
      approvalId,
      sessionId: input.sessionId,
      toolName: input.toolName,
      summary: input.summary,
      targetPath: input.targetPath,
      command: input.command,
      cwd: input.cwd,
      risk: input.risk,
      expiresAt,
      arguments: input.arguments ?? {},
    });

    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(approvalId)) return;
        this.pending.delete(approvalId);
        const decision: ApprovalDecision = {
          approvalId,
          approved: false,
          reason: `Approval request expired after ${timeoutMs}ms`,
          decidedBy: 'timeout',
          decidedAt: new Date().toISOString(),
        };
        this.resolvedHistory.set(approvalId, decision);
        this.eventBridge.emit(input.sessionId, 'approval.resolved', {
          ...decision,
          toolName: input.toolName,
        });
        resolve(decision);
      }, timeoutMs);

      this.pending.set(approvalId, { payload, resolve, timer });

      this.eventBridge.emit(input.sessionId, 'approval.requested', {
        ...payload,
      });
    });
  }

  /**
   * Resolve a pending approval from IDE UI user action
   */
  respond(approvalId: string, approved: boolean, reason?: string): ApprovalDecision {
    const entry = this.pending.get(approvalId);
    if (!entry) {
      const existing = this.resolvedHistory.get(approvalId);
      if (existing) return existing;
      throw new Error(`APPROVAL_NOT_FOUND: No pending approval with id "${approvalId}"`);
    }

    clearTimeout(entry.timer);
    this.pending.delete(approvalId);

    const decision: ApprovalDecision = {
      approvalId,
      approved,
      reason: reason ?? (approved ? 'Approved by user' : 'Rejected by user'),
      decidedBy: 'user',
      decidedAt: new Date().toISOString(),
    };

    this.resolvedHistory.set(approvalId, decision);
    this.eventBridge.emit(entry.payload.sessionId, 'approval.resolved', {
      ...decision,
      toolName: entry.payload.toolName,
    });
    entry.resolve(decision);
    return decision;
  }

  /**
   * Get all pending approvals for a session (used when Webview reopens/re-attaches)
   */
  getPendingApprovals(sessionId?: string): ApprovalRequestPayload[] {
    const list: ApprovalRequestPayload[] = [];
    for (const entry of this.pending.values()) {
      if (!sessionId || entry.payload.sessionId === sessionId) {
        list.push(entry.payload);
      }
    }
    return list;
  }

  /**
   * Cancel all pending approvals for a session when the task/session is cancelled
   */
  cancelSessionApprovals(sessionId: string, reason = 'Session cancelled'): number {
    let count = 0;
    for (const [approvalId, entry] of this.pending.entries()) {
      if (entry.payload.sessionId === sessionId) {
        clearTimeout(entry.timer);
        this.pending.delete(approvalId);
        const decision: ApprovalDecision = {
          approvalId,
          approved: false,
          reason,
          decidedBy: 'cancelled',
          decidedAt: new Date().toISOString(),
        };
        this.resolvedHistory.set(approvalId, decision);
        this.eventBridge.emit(sessionId, 'approval.resolved', {
          ...decision,
          toolName: entry.payload.toolName,
        });
        entry.resolve(decision);
        count++;
      }
    }
    return count;
  }

  dispose(): void {
    for (const [approvalId, entry] of this.pending.entries()) {
      clearTimeout(entry.timer);
      entry.resolve({
        approvalId,
        approved: false,
        reason: 'ApprovalBridge disposed',
        decidedBy: 'cancelled',
        decidedAt: new Date().toISOString(),
      });
    }
    this.pending.clear();
  }
}

