import { describe, expect, it } from 'vitest';
import {
  historySliceBounds,
  resolveComposerContextPlan,
  shouldForkComposerSession,
} from '../src/core/ComposerContextRouter.js';

describe('ComposerContextRouter (Cursor-style)', () => {
  it('continues full thread when user says 继续修', () => {
    const plan = resolveComposerContextPlan({
      newPrompt: '还是不对，继续修 sendrecv #wrong=1',
      messages: [
        { role: 'user', content: '修复 sendrecv #wrong=1' },
        { role: 'assistant', content: '已修改 enqueue.cc' },
      ],
      allowFork: true,
    });
    expect(plan.mode).not.toBe('fork_session');
    expect(plan.historyMessagePairs).toBeGreaterThanOrEqual(1);
  });

  it('trims when switching from tutorial PDF to unrelated bug question', () => {
    const plan = resolveComposerContextPlan({
      newPrompt: '帮我分析一下 scheduleP2p 的调用链是什么？',
      messages: [
        { role: 'user', content: '生成 LL Simple 的 pdf 教程' },
        { role: 'assistant', content: 'docs/tutorials/nccl.md' },
      ],
      allowFork: false,
    });
    expect(['continue_trimmed', 'fork_session']).toContain(plan.mode);
    expect(plan.stripDeliverableFromAudit).toBe(true);
  });

  it('forks on explicit 新问题', () => {
    const messages = [
      { role: 'user', content: '生成 pdf 教程' },
      { role: 'assistant', content: 'done' },
    ];
    expect(
      shouldForkComposerSession('新问题：sendrecv_perf #wrong=1', messages, true)
    ).toBe(true);
  });

  it('historySliceBounds respects trimmed plan', () => {
    const bounds = historySliceBounds(5, {
      mode: 'continue_trimmed',
      relationScore: 0.4,
      reason: 'test',
      historyMessagePairs: 1,
      includeToolAudit: false,
      stripDeliverableFromAudit: true,
      focusBlock: 'engineering',
    });
    expect(bounds.end - bounds.start).toBeLessThanOrEqual(2);
  });
});
