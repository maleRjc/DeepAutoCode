import { describe, expect, it } from 'vitest';
import {
  resolveCompactionPlan,
  estimateTokensFromChars,
} from '../src/core/ContextCompaction.js';
import {
  decomposeResearchHeuristic,
  decomposeResearchTask,
  parseLlmDecomposeResponse,
} from '../src/core/ResearchDecompose.js';
import { Agent, type AgentMessage } from '../src/core/AgentLoop.js';

describe('ContextCompaction', () => {
  it('escalates plan with higher fill / chars', () => {
    const low = resolveCompactionPlan({ toolResultChars: 10_000 });
    expect(low.shouldCompact).toBe(false);

    const glmEarly = resolveCompactionPlan({
      toolResultChars: 30_000,
      compactProfile: 'glm128k',
    });
    expect(glmEarly.shouldCompact).toBe(true);

    const mid = resolveCompactionPlan({ toolResultChars: 40_000 });
    expect(mid.shouldCompact).toBe(true);
    expect(mid.keepRecentMessages).toBe(4);

    const high = resolveCompactionPlan({ toolResultChars: 90_000 });
    expect(high.minCharsToSummarize).toBeLessThanOrEqual(800);
    expect(high.keepRecentMessages).toBeLessThanOrEqual(3);

    const critical = resolveCompactionPlan({
      toolResultChars: 20_000,
      tokenBudget: 100_000,
      tokensUsed: 90_000,
    });
    expect(critical.reason).toMatch(/critical-(?:provider-token-|context-)pressure/);
    expect(critical.trigger).toBe('provider_tokens');
    expect(critical.keepRecentMessages).toBe(2);
    expect(estimateTokensFromChars(400)).toBe(100);
  });

  it('Agent uses budget callback for aggressive compaction', () => {
    let used = 90_000;
    const agent = new Agent({
      sessionId: 's',
      model: {
        async *stream() {
          yield { type: 'finish', reason: 'stop' };
        },
      },
      systemPrompt: 'x',
      tools: [],
      getContextBudget: () => ({ tokensUsed: used, tokenBudget: 100_000 }),
    });

    const messages: AgentMessage[] = [];
    for (let i = 0; i < 6; i++) {
      messages.push({
        id: `t${i}`,
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: `c${i}`,
            toolName: 'read_file',
            output: { content: `error: bad in src/x.ts:3\n${'z'.repeat(600)}` },
          },
        ],
        createdAt: Date.now(),
      });
    }
    messages.push({
      id: 'u',
      role: 'user',
      content: [{ type: 'text', text: 'go' }],
      createdAt: Date.now(),
    });
    messages.push({
      id: 'a',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      createdAt: Date.now(),
    });

    agent.compactOlderToolOutputsIfNeeded(messages);
    const first = messages[0].content[0];
    expect(first.type).toBe('tool-result');
    if (first.type === 'tool-result') {
      expect(String(first.output)).toMatch(/compacted summary/);
    }
  });
});

describe('ResearchDecompose', () => {
  it('heuristic extracts idents and error-oriented questions', () => {
    const d = decomposeResearchHeuristic(
      'Fix createWidget crash: TypeError in renderWidget and failing widget.test.ts'
    );
    expect(d.source).toBe('heuristic');
    expect(d.searchQueries.some((q) => /createWidget|widget\.test/i.test(q))).toBe(true);
    expect(d.questions.length).toBeGreaterThan(2);
  });

  it('parses LLM JSON and merges as hybrid', async () => {
    const parsed = parseLlmDecomposeResponse(
      '{"questions":["Where is Foo defined?"],"searchQueries":["Foo","foo.ts"]}'
    );
    expect(parsed.questions[0]).toMatch(/Foo/);
    expect(parsed.searchQueries).toContain('Foo');

    const hybrid = await decomposeResearchTask('Investigate Foo callers', {
      llmDecompose: async () =>
        JSON.stringify({
          questions: ['Who imports Foo?'],
          searchQueries: ['import Foo'],
        }),
    });
    expect(hybrid.source).toBe('hybrid');
    expect(hybrid.searchQueries).toContain('import Foo');
  });

  it('falls back to heuristic when LLM fails', async () => {
    const d = await decomposeResearchTask('Investigate Bar', {
      llmDecompose: async () => {
        throw new Error('network');
      },
    });
    expect(d.source).toBe('heuristic');
    expect(d.searchQueries.some((q) => q.includes('Bar'))).toBe(true);
  });
});
