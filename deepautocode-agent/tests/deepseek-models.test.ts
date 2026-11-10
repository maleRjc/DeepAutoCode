import { describe, expect, it } from 'vitest';
import {
  DEEPSEEK_FLASH,
  DEEPSEEK_V4_PRO,
  buildDeepSeekRequestControls,
  deepSeekChatBodyExtras,
  estimateDeepSeekTurnCostCny,
  isDeepSeekPeakHour,
  isGlmModelId,
  normalizeDeepSeekApiModelId,
  parseToolArgumentsResilient,
  resolveGlmRequestControls,
  resolveModelContextBudget,
  resolveModelMaxOutputTokens,
  resolveNestedLlmMaxTokens,
} from '../src/core/DeepSeekModels.js';
import { resolveTieredModelForTurn } from '../src/core/GoalSteering.js';
import { completeDeepSeekFim } from '../src/core/DeepSeekFim.js';
import {
  DEFAULT_PROVIDERS,
  InMemorySecretStorage,
  ProviderManager,
  buildClaudeSettingsJsonForGlm,
  isLocalOrPrivateEndpoint,
  resolveChatCompletionsUrl,
} from '../providers/index.js';

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

  it('provides built-in official GLM provider and supports custom local vLLM/SGLang endpoints', async () => {
    expect(DEFAULT_PROVIDERS.glm).toBeDefined();
    expect(DEFAULT_PROVIDERS.glm.apiEndpoint).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(DEFAULT_PROVIDERS.glm.defaultModelId).toBe('glm-4-plus');
    expect(resolveChatCompletionsUrl('https://open.bigmodel.cn/api/paas/v4')).toBe(
      'https://open.bigmodel.cn/api/paas/v4/chat/completions'
    );
    expect(resolveChatCompletionsUrl('http://127.0.0.1:8000')).toBe(
      'http://127.0.0.1:8000/v1/chat/completions'
    );

    const claudeSettings = buildClaudeSettingsJsonForGlm({
      baseUrl: 'http://127.0.0.1:8000',
      defaultModel: 'Custom-GLM-Flash',
    }) as any;
    expect(claudeSettings.env.ANTHROPIC_AUTH_TOKEN).toBe('EMPTY');
    expect(claudeSettings.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8000');
    expect(claudeSettings.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('Custom-GLM-Flash');
    expect(claudeSettings.tui).toBe('fullscreen');
  });

  it('supports universal provider settings compatibility across any provider slot and persists state', async () => {
    expect(isLocalOrPrivateEndpoint('http://10.0.0.1:8000')).toBe(true);
    expect(isLocalOrPrivateEndpoint('http://127.0.0.1:11434/v1')).toBe(true);
    expect(isLocalOrPrivateEndpoint('https://api.deepseek.com/v1')).toBe(false);
    expect(resolveChatCompletionsUrl('https://open.bigmodel.cn/api/paas/v4')).toBe(
      'https://open.bigmodel.cn/api/paas/v4/chat/completions'
    );

    const sharedSecrets = new InMemorySecretStorage();
    const pm1 = new ProviderManager(sharedSecrets);
    await pm1.configureProvider({
      providerId: 'openai-compatible',
      apiEndpoint: 'http://10.0.0.1:8000',
      modelId: 'Custom-Local-Model',
      apiKey: '',
    });

    // Empty apiKey on a private LAN endpoint automatically resolves to EMPTY
    expect(await pm1.resolveApiKey('openai-compatible')).toBe('EMPTY');
    // Universal resolver prefers the active provider that the user configured
    expect(pm1.resolveProviderForModel('Custom-Local-Model').providerId).toBe('openai-compatible');

    // A new ProviderManager instance sharing the same secret storage restores activeProviderId, modelId, and endpoint
    const pm2 = new ProviderManager(sharedSecrets);
    const restored = await pm2.getActiveProviderWithKeyStatus();
    expect(restored.provider.providerId).toBe('openai-compatible');
    expect(restored.provider.apiEndpoint).toBe('http://10.0.0.1:8000');
    expect(restored.model.modelId).toBe('Custom-Local-Model');
    expect(restored.hasApiKeyConfigured).toBe(true);
  });

  it('optimizes GLM-5.3-Flash adaptive thinking gating, NVFP4 sampling, 96K context budget, JSON repair, and local FIM', async () => {
    expect(isGlmModelId('GLM-5.3-Flash')).toBe(true);
    expect(isGlmModelId('glm-4-plus')).toBe(true);
    expect(isGlmModelId('deepseek-flash')).toBe(false);

    // 1. Adaptive Thinking Gating & NVFP4 Sampling
    const execCtrl = resolveGlmRequestControls({
      modelId: 'GLM-5.3-Flash',
      phase: 'exec',
      turnIndex: 2,
      userPrompt: '继续编写代码',
    });
    expect(execCtrl.enableThinking).toBe(false);
    expect(execCtrl.temperature).toBe(0.1);
    expect(execCtrl.topP).toBe(0.85);
    expect(execCtrl.chatTemplateKwargs).toEqual({ enable_thinking: false });

    const healCtrl = resolveGlmRequestControls({
      modelId: 'GLM-5.3-Flash',
      phase: 'exec',
      turnIndex: 3,
      hasFailure: true,
      userPrompt: '继续',
    });
    expect(healCtrl.enableThinking).toBe(true);

    const compileFast = resolveGlmRequestControls({
      modelId: 'GLM-5.3-Flash',
      phase: 'exec',
      turnIndex: 2,
      hasFailure: true,
      userPrompt: '[FORCE_AUTO_ACTION] prims_ll.h:181: error: should return a value',
      compileRemediationTurn: true,
      toolCallingTurn: true,
    });
    expect(compileFast.enableThinking).toBe(false);
    expect(compileFast.reason).toBe('compile-remediation-fast');
    expect(healCtrl.temperature).toBe(0.6);
    expect(healCtrl.topP).toBe(0.95);
    expect(healCtrl.chatTemplateKwargs).toEqual({ enable_thinking: true });

    // 2. 128K Context Budget Binding (96K safe budget for GLM vs 180K for DeepSeek)
    expect(resolveModelContextBudget({ modelId: 'GLM-5.3-Flash', configuredBudget: 180_000 })).toBe(
      96_000
    );
    expect(
      resolveModelMaxOutputTokens({
        modelId: 'GLM-5.3-Flash',
        catalogMaxOutput: 16_384,
      })
    ).toBe(16_384);
    expect(resolveModelMaxOutputTokens({ modelId: 'GLM-5.3-Flash' })).toBe(16_384);
    expect(resolveModelMaxOutputTokens({ modelId: 'glm-4-flash' })).toBe(8_192);
    expect(
      resolveNestedLlmMaxTokens({
        modelId: 'GLM-5.3-Flash',
        role: 'subagent',
      })
    ).toBe(8_192);
    expect(
      resolveNestedLlmMaxTokens({
        modelId: 'glm-4-flash',
        role: 'subagent',
      })
    ).toBeGreaterThanOrEqual(3_500);
    expect(
      resolveNestedLlmMaxTokens({
        modelId: 'GLM-5.3-Flash',
        role: 'synthesize',
      })
    ).toBeGreaterThanOrEqual(1_800);
    expect(resolveModelContextBudget({ modelId: 'deepseek-flash', configuredBudget: 180_000 })).toBe(
      180_000
    );

    // 3. Resilient Tool Argument JSON Repair (trailing comma + unclosed brace)
    const repairedComma = parseToolArgumentsResilient('{"filePath": "calc.py", "content": "x=1",}');
    expect(repairedComma.ok).toBe(true);
    expect(repairedComma.parsed.filePath).toBe('calc.py');

    const repairedBrace = parseToolArgumentsResilient('{"filePath": "calc.py", "content": "x=1"');
    expect(repairedBrace.ok).toBe(true);
    expect(repairedBrace.parsed.content).toBe('x=1');

    // 4. Local vLLM / GLM FIM Completion with enable_thinking: false
    let capturedBody: any = null;
    const fimRes = await completeDeepSeekFim({
      apiKey: 'EMPTY',
      model: 'GLM-5.3-Flash',
      apiEndpoint: 'http://127.0.0.1:8000',
      prompt: 'def add(a, b):\n    ',
      suffix: '\n',
      fetchImpl: async (_url, init) => {
        capturedBody = JSON.parse(String(init.body || '{}'));
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({
            choices: [{ message: { content: 'return a + b' } }],
          }),
        };
      },
    });
    expect(fimRes.ok).toBe(true);
    expect(fimRes.text).toBe('return a + b');
    expect(capturedBody.chat_template_kwargs).toEqual({ enable_thinking: false });
  });
});
