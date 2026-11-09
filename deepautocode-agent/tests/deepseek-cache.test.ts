import { describe, expect, it } from 'vitest';
import { buildStablePrefix } from '../src/core/AgentLoop.js';
import { createTool, type AgentTool } from '../src/core/ToolSuite.js';
import {
  extractDeepSeekCacheUsage,
  resolvePhaseReasoningEffort,
} from '../src/core/DeepSeekModels.js';
import { recordProviderCacheUsageToTrace } from '../providers/index.js';
import { decideBudgetCompaction, type ChatMessageLike } from '../src/core/ContextCompaction.js';
import { extractToolResultTuple, summarizeToolOutput } from '../src/core/ToolResultSummarizer.js';

describe('Batch B + C1 + C2: DeepSeek Prefix Cache, Phase Thinking, Budget Compaction & 4-Tuple Summarizer', () => {
  it('B1: buildStablePrefix strips volatile tags and sorts tools deterministically for byte-identical prefix hash', () => {
    const toolB: AgentTool<any, any> = createTool({
      name: 'write_file',
      description: 'Write file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      execute: async () => ({}),
    });
    const toolA: AgentTool<any, any> = createTool({
      name: 'read_file',
      description: 'Read file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      execute: async () => ({}),
    });

    const p1 = buildStablePrefix({
      systemPrompt:
        'Core system prompt.\n[Auto-Prefetched Workspace Files: foo.ts]\n[Current Plan Checklist (Phase EXEC):\n  1. [ ] step]',
      projectRules: 'Rule 1: Always test.',
      tools: [toolB, toolA],
    });

    const p2 = buildStablePrefix({
      systemPrompt:
        'Core system prompt.\n[Auto-Prefetched Workspace Files: bar.ts]\n[Current Plan Checklist (Phase EXEC):\n  1. [x] step]',
      projectRules: 'Rule 1: Always test.',
      tools: [toolA, toolB],
    });

    expect(p1.prefixHash).toBe(p2.prefixHash);
    expect(p1.stableSystemPrompt).toBe(p2.stableSystemPrompt);
    expect(p1.orderedTools.map((t) => t.name)).toEqual(['read_file', 'write_file']);
    expect(p1.trailingDynamicContext).toContain('Auto-Prefetched Workspace Files');
  });

  it('B1: extractDeepSeekCacheUsage & recordProviderCacheUsageToTrace record prompt_cache_hit_tokens', () => {
    const rawUsage = {
      prompt_tokens: 10000,
      completion_tokens: 500,
      prompt_cache_hit_tokens: 8500,
      prompt_cache_miss_tokens: 1500,
    };

    const parsed = extractDeepSeekCacheUsage(rawUsage);
    expect(parsed.inputTokens).toBe(10000);
    expect(parsed.outputTokens).toBe(500);
    expect(parsed.promptCacheHitTokens).toBe(8500);
    expect(parsed.promptCacheMissTokens).toBe(1500);

    const recordedTurns: any[] = [];
    const res = recordProviderCacheUsageToTrace({
      usageRaw: rawUsage,
      modelId: 'deepseek-v4-pro',
      tier: 'pro',
      reasoningEffort: 'high',
      trace: {
        recordModelTurn: (entry) => recordedTurns.push(entry),
      },
    });

    expect(res.promptCacheHitTokens).toBe(8500);
    expect(recordedTurns).toHaveLength(1);
    expect(recordedTurns[0].cacheReadTokens).toBe(8500);
    expect(recordedTurns[0].reasoningEffort).toBe('high');
  });

  it('B2: resolvePhaseReasoningEffort grades thinking effort by phase and retry state', () => {
    expect(resolvePhaseReasoningEffort({ phase: 'plan' })).toBe('high');
    expect(resolvePhaseReasoningEffort({ phase: 'exec' })).toBe('low');
    expect(resolvePhaseReasoningEffort({ phase: 'exec', isDebugOrVerifyRetry: true })).toBe('max');
    expect(resolvePhaseReasoningEffort({ phase: 'verify', consecutiveMistakes: 1 })).toBe('max');
  });

  it('C1: decideBudgetCompaction outputs { keep, summarize, drop } based on token budget', () => {
    const bigToolOutput = 'x'.repeat(32000); // ~8,000 tokens each
    const messages: ChatMessageLike[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Initial task prompt' },
      ...Array.from({ length: 20 }, (_, i) => ({
        role: 'tool',
        name: 'read_file',
        tool_call_id: `tc_${i}`,
        content: `File ${i}: ${bigToolOutput}`,
      })),
      { role: 'assistant', content: 'Recent assistant reply' },
      { role: 'user', content: 'Recent user follow-up' },
    ];

    const decision = decideBudgetCompaction(messages, {
      softTokenBudget: 40000,
      preserveRecentMessages: 4,
    });

    expect(decision.overBudgetTokens).toBeGreaterThan(0);
    expect(decision.keep).toContain(0);
    expect(decision.keep).toContain(1);
    expect(decision.summarize.length + decision.drop.length).toBeGreaterThan(0);
  });

  it('C2: extractToolResultTuple extracts structured { paths, errors, exitCode, matchedLines }', () => {
    const rawOutput = [
      'src/core/AgentLoop.ts:441:12: error TS2345: Argument of type string is not assignable',
      'tests/agent-loop.test.ts:28:5: FAIL expected true to be false',
      'Command exited with code 2',
    ].join('\n');

    const tuple = extractToolResultTuple('run_command', rawOutput);
    expect(tuple.exitCode).toBe(2);
    expect(tuple.paths).toContain('src/core/AgentLoop.ts');
    expect(tuple.errors.length).toBeGreaterThan(0);
    expect(tuple.matchedLines.some((m) => m.includes('src/core/AgentLoop.ts:441'))).toBe(true);

    const summary = summarizeToolOutput('run_command', rawOutput + '\n' + 'padding '.repeat(2000), {
      maxChars: 500,
    });
    expect(summary).toContain('[ToolTuple exitCode=2');
    expect(summary).toContain('src/core/AgentLoop.ts');
  });
});
