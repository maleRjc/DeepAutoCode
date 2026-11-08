import { describe, expect, it } from 'vitest';
import {
  DEEPSEEK_FLASH,
  DEEPSEEK_V4_PRO,
  buildDeepSeekRequestControls,
  deepSeekChatBodyExtras,
  estimateDeepSeekTurnCostCny,
  isDeepSeekPeakHour,
  normalizeDeepSeekApiModelId,
} from '../src/core/DeepSeekModels.js';
import { resolveTieredModelForTurn } from '../src/core/GoalSteering.js';
import { completeDeepSeekFim } from '../src/core/DeepSeekFim.js';

describe('DeepSeek model catalog helpers', () => {
  it('normalizes legacy aliases to flash/pro', () => {
    expect(normalizeDeepSeekApiModelId('deepseek-chat')).toBe(DEEPSEEK_FLASH);
    expect(normalizeDeepSeekApiModelId('deepseek-v4-flash')).toBe(DEEPSEEK_FLASH);
    expect(normalizeDeepSeekApiModelId('deepseek-reasoner')).toBe(DEEPSEEK_FLASH);
    expect(normalizeDeepSeekApiModelId('deepseek-v4-pro')).toBe(DEEPSEEK_V4_PRO);
  });

  it('builds thinking body extras', () => {
    const on = buildDeepSeekRequestControls({
      apiModelId: DEEPSEEK_FLASH,
      thinkingEnabled: true,
      reasoningEffort: 'high',
    });
    expect(deepSeekChatBodyExtras(on)).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    });
    const off = buildDeepSeekRequestControls({
      apiModelId: DEEPSEEK_FLASH,
      thinkingEnabled: false,
    });
    expect(deepSeekChatBodyExtras(off)).toEqual({
      thinking: { type: 'disabled' },
    });
  });

  it('detects peak hours in UTC weekday windows', () => {
    // Monday 02:30 UTC → peak
    expect(isDeepSeekPeakHour(new Date('2026-11-09T02:30:00Z'))).toBe(true);
    // Monday 05:00 UTC → off-peak gap
    expect(isDeepSeekPeakHour(new Date('2026-11-09T05:00:00Z'))).toBe(false);
    // Saturday → off-peak
    expect(isDeepSeekPeakHour(new Date('2026-11-07T02:30:00Z'))).toBe(false);
  });

  it('estimates cache-aware CNY cost', () => {
    const cost = estimateDeepSeekTurnCostCny({
      apiModelId: DEEPSEEK_FLASH,
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 500_000,
      peak: false,
    });
    // 0.5M hit * 0.02 + 0.5M miss * 1.0 = 0.01 + 0.5 = 0.51
    expect(cost).toBeCloseTo(0.51, 5);
  });
});

describe('Tier router Flash/Pro × thinking', () => {
  it('force-fast uses flash without thinking', () => {
    const r = resolveTieredModelForTurn({
      configuredModelId: 'deepseek-flash',
      providerId: 'deepseek',
      userPrompt: 'read file',
      turnIndex: 1,
      selfHealCount: 0,
      routingMode: 'force-fast',
    });
    expect(r.effectiveModelId).toBe(DEEPSEEK_FLASH);
    expect(r.thinkingEnabled).toBe(false);
    expect(r.tier).toBe('fast-tool');
  });

  it('force-reasoner uses v4-pro with thinking high', () => {
    const r = resolveTieredModelForTurn({
      configuredModelId: 'deepseek-v4-pro',
      providerId: 'deepseek',
      userPrompt: 'plan architecture',
      turnIndex: 1,
      selfHealCount: 0,
      routingMode: 'force-reasoner',
    });
    expect(r.effectiveModelId).toBe(DEEPSEEK_V4_PRO);
    expect(r.thinkingEnabled).toBe(true);
    expect(r.reasoningEffort).toBe('high');
  });

  it('auto discovery stays on flash no-think; self-heal promotes to pro', () => {
    const discovery = resolveTieredModelForTurn({
      configuredModelId: 'deepseek-auto',
      providerId: 'deepseek',
      userPrompt: 'fix the flaky suite',
      turnIndex: 1,
      selfHealCount: 0,
      hasReadFiles: false,
      routingMode: 'auto',
    });
    expect(discovery.effectiveModelId).toBe(DEEPSEEK_FLASH);
    expect(discovery.thinkingEnabled).toBe(false);

    const heal = resolveTieredModelForTurn({
      configuredModelId: 'deepseek-auto',
      providerId: 'deepseek',
      userPrompt: 'build failed',
      turnIndex: 4,
      selfHealCount: 1,
      hasBuildOrTestFailure: true,
      routingMode: 'auto',
    });
    expect(heal.effectiveModelId).toBe(DEEPSEEK_V4_PRO);
    expect(heal.thinkingEnabled).toBe(true);
  });
});

describe('DeepSeek FIM client', () => {
  it('posts to beta completions and parses text', async () => {
    const result = await completeDeepSeekFim({
      apiKey: 'sk-test',
      prompt: 'def fib(a):',
      suffix: '    return fib(a-1)+fib(a-2)',
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String((init as any).body || '{}'));
        expect(body.model).toBe(DEEPSEEK_FLASH);
        expect(body.prompt).toContain('def fib');
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({ choices: [{ text: '\n    if a < 2: return a\n' }] }),
        };
      },
    });
    expect(result.ok).toBe(true);
    expect(result.text).toContain('if a < 2');
  });
});
