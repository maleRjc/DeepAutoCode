import type { TraceAgentSignal, TraceEvent } from './TaskTrace.js';

export type ContinuationInsight = {
  caseId: string;
  summary: string;
  ts?: string;
  selfHealCount?: number;
  compileRemediationContinuationCount?: number;
  sessionWrites?: number;
};

function isContinuationSignal(evt: TraceEvent): evt is TraceAgentSignal {
  return evt.kind === 'agent.signal' && evt.signal === 'continuation';
}

/** Latest `continuation` signal from a trace event list (chronological order). */
export function extractLastContinuation(events: unknown[] | undefined): ContinuationInsight | null {
  if (!Array.isArray(events) || events.length === 0) return null;
  let last: ContinuationInsight | null = null;
  for (const raw of events) {
    const evt = raw as TraceEvent;
    if (!isContinuationSignal(evt)) continue;
    const d = evt.detail || {};
    last = {
      caseId: String(d.case || 'unknown'),
      summary: String(evt.summary || ''),
      ts: evt.ts,
      selfHealCount: typeof d.selfHealCount === 'number' ? d.selfHealCount : undefined,
      compileRemediationContinuationCount:
        typeof d.compileRemediationContinuationCount === 'number'
          ? d.compileRemediationContinuationCount
          : undefined,
      sessionWrites: typeof d.sessionWrites === 'number' ? d.sessionWrites : undefined,
    };
  }
  return last;
}

export function formatContinuationStatusLabel(insight: ContinuationInsight): string {
  const parts = [`续跑·${insight.caseId}`];
  if (insight.compileRemediationContinuationCount != null) {
    parts.push(`compile+#${insight.compileRemediationContinuationCount}`);
  }
  if (insight.selfHealCount != null) {
    parts.push(`heal ${insight.selfHealCount}`);
  }
  return parts.join(' ');
}
