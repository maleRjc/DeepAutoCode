import { describe, expect, it } from 'vitest';
import { resolveComposerContextPlan } from '../../deepautocode-agent/src/core/ComposerContextRouter.js';

describe('Composer context (shared router)', () => {
  it('resolves plan for deliverable → query', () => {
    const plan = resolveComposerContextPlan({
      newPrompt: '帮我分析一下 scheduleP2p 的调用链是什么？',
      messages: [{ role: 'user', content: '生成一份完整的 pdf 教程' }],
      allowFork: false,
    });
    expect(plan.relationScore).toBeLessThan(0.7);
    expect(plan.stripDeliverableFromAudit).toBe(true);
  });
});
