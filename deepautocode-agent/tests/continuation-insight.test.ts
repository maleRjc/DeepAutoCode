import { describe, expect, it } from 'vitest';
import {
  extractLastContinuation,
  formatContinuationStatusLabel,
} from '../src/core/trace/ContinuationInsight.js';

describe('ContinuationInsight', () => {
  it('extracts the latest continuation signal', () => {
    const events = [
      {
        kind: 'agent.signal',
        signal: 'continuation',
        summary: '续跑：已编辑未验证 (#1)',
        ts: '2026-03-30T10:00:00.000Z',
        detail: { case: 'verify_nudge_build', selfHealCount: 0 },
      },
      {
        kind: 'agent.signal',
        signal: 'continuation',
        summary: '续跑：缺少修复方案 (#2)',
        ts: '2026-03-30T10:01:00.000Z',
        detail: {
          case: 'compile_lacks_plan',
          compileRemediationContinuationCount: 2,
          sessionWrites: 0,
        },
      },
    ];
    const last = extractLastContinuation(events);
    expect(last?.caseId).toBe('compile_lacks_plan');
    expect(last?.compileRemediationContinuationCount).toBe(2);
    expect(formatContinuationStatusLabel(last!)).toBe('续跑·compile_lacks_plan compile+#2');
  });

  it('returns null when no continuation events', () => {
    expect(extractLastContinuation([])).toBeNull();
    expect(
      extractLastContinuation([{ kind: 'agent.signal', signal: 'model_tier', summary: 'x' }])
    ).toBeNull();
  });
});
