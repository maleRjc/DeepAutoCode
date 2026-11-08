import { describe, expect, it } from 'vitest';
import { Agent, type AgentMessage } from '../src/core/AgentLoop.js';
import {
  summarizeToolOutput,
  shouldCompactToolOutput,
} from '../src/core/ToolResultSummarizer.js';
import { buildGuidedFollowUpQueries } from '../src/core/ResearchSubagent.js';

describe('ToolResultSummarizer', () => {
  it('preserves paths and errors instead of only head-slice', () => {
    const blob =
      'x'.repeat(2000) +
      '\nerror: cannot find symbol Foo in src/core/Foo.ts\n' +
      '> src/core/Foo.ts:12: export function Foo() {}\n' +
      'y'.repeat(2000);
    const summary = summarizeToolOutput('search_codebase', blob, blob.length);
    expect(summary).toMatch(/compacted summary/);
    expect(summary).toMatch(/Foo\.ts|error:/i);
    expect(summary.length).toBeLessThan(blob.length);
  });

  it('summarizes structured edit failures', () => {
    const summary = summarizeToolOutput(
      'edit_file',
      {
        ok: false,
        filePath: 'a.ts',
        error: 'OLD_TEXT_NOT_FOUND: missing block',
        semanticErrors: 'ERROR a.ts:3 [typescript-ls] Type error',
      },
      5000
    );
    expect(summary).toContain('a.ts');
    expect(summary).toMatch(/OLD_TEXT_NOT_FOUND|Type error/);
  });

  it('Agent compaction uses summaries for older tool messages', () => {
    const agent = new Agent({
      sessionId: 's1',
      model: {
        async *stream() {
          yield { type: 'finish', reason: 'stop' };
        },
      },
      systemPrompt: 'test',
      tools: [],
    });

    const big = {
      content: `${'line\n'.repeat(2500)}error: boom in src/fail.ts:9: bad\n`,
    };
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push({
        id: `t${i}`,
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: `c${i}`,
            toolName: 'read_file',
            output: { ...big },
          },
        ],
        createdAt: Date.now(),
      });
    }
    // trailing recent msgs kept
    messages.push({
      id: 'u',
      role: 'user',
      content: [{ type: 'text', text: 'continue' }],
      createdAt: Date.now(),
    });
    messages.push({
      id: 'a',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      createdAt: Date.now(),
    });

    expect(shouldCompactToolOutput(big)).toBe(true);
    agent.compactOlderToolOutputsIfNeeded(messages);

    const first = messages[0].content[0];
    expect(first.type).toBe('tool-result');
    if (first.type === 'tool-result') {
      const out = String(first.output);
      expect(out).toMatch(/compacted summary/);
      expect(out).toMatch(/fail\.ts|boom|error/i);
    }
  });
});

describe('buildGuidedFollowUpQueries', () => {
  it('adds test/caller oriented follow-ups', () => {
    const qs = buildGuidedFollowUpQueries('查找 createWidget 的调用方并修复测试失败', [
      'createWidget',
    ]);
    expect(qs.some((q) => /createWidget|import|test|Error/i.test(q))).toBe(true);
  });
});
