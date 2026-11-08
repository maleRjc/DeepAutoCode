import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TaskTraceStore,
  digestArgs,
  summarizePrompt,
  estimateResultBytes,
} from '../src/core/trace/TaskTrace.js';
import { EventMessageSchema } from '../src/types.js';

describe('TaskTrace helpers', () => {
  it('digests and summarizes stably', () => {
    expect(digestArgs({ a: 1 })).toBe('{"a":1}');
    expect(summarizePrompt('hello   world')).toBe('hello world');
    expect(estimateResultBytes('abc')).toBe(3);
  });
});

describe('TaskTraceStore', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => undefined))
    );
  });

  it('records llm/tool/verify lifecycle and writes JSONL', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dac-trace-'));
    dirs.push(workspaceRoot);
    const store = new TaskTraceStore();
    const taskId = 'trc_test_1';
    const sessionId = 'sess_test_1';

    store.startTask({
      taskId,
      sessionId,
      mode: 'auto',
      prompt: 'fix the flaky suite',
      modelId: 'deepseek-flash',
      workspaceRoot,
      tokenBudget: 180000,
    });

    const llm = store.recordLlmTurn({
      workspaceRoot,
      sessionId,
      turnIndex: 1,
      modelId: 'deepseek-flash',
      latencyMs: 120,
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 55,
      cacheWriteTokens: 10,
      tokensUsed: 140,
      tokenBudget: 180000,
    });
    expect(llm?.kind).toBe('llm.turn');
    expect(llm?.cacheReadTokens).toBe(55);

    const tool = store.recordToolCall({
      workspaceRoot,
      sessionId,
      toolCallId: 'tc_1',
      toolName: 'read-file',
      args: { filePath: 'src/a.ts' },
      result: 'file body',
      durationMs: 12,
      ok: true,
    });
    expect(tool?.ok).toBe(true);

    const verify = store.recordVerify({
      workspaceRoot,
      sessionId,
      passed: true,
      summary: 'npm test exit=0',
    });
    expect(verify?.passed).toBe(true);

    const end = store.endTask({
      workspaceRoot,
      sessionId,
      status: 'success',
    });
    expect(end?.status).toBe('success');
    expect(end?.cacheReadTokens).toBe(55);

    const snap = store.get(taskId);
    expect(snap?.events.map((e) => e.kind)).toEqual([
      'task.start',
      'llm.turn',
      'tool.call',
      'verify.result',
      'task.end',
    ]);
    expect(store.getBySession(sessionId)?.taskId).toBe(taskId);
    expect(store.list(5)[0]?.taskId).toBe(taskId);

    // allow async append to settle
    await new Promise((r) => setTimeout(r, 40));
    const jsonlPath = path.join(workspaceRoot, '.deepautocode', 'traces', `${taskId}.jsonl`);
    const raw = await fs.readFile(jsonlPath, 'utf8');
    const lines = raw
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines.length).toBeGreaterThanOrEqual(5);
    expect(lines.some((l) => l.kind === 'llm.turn' && l.cacheReadTokens === 55)).toBe(true);
  });
});

describe('goal.usage / trace.updated event schema', () => {
  it('accepts cache token fields on goal.usage', () => {
    const parsed = EventMessageSchema.parse({
      category: 'event',
      type: 'goal.usage',
      sessionId: 'sess_1',
      sequence: 3,
      timestamp: new Date().toISOString(),
      payload: {
        tokensUsed: 140,
        tokenBudget: 180000,
        inputTokens: 100,
        outputTokens: 40,
        cacheReadTokens: 55,
        cacheWriteTokens: 10,
        cacheReadTokensTotal: 55,
        cacheWriteTokensTotal: 10,
        turnIndex: 1,
        remaining: 179860,
      },
    });
    expect(parsed.payload.cacheReadTokens).toBe(55);
    expect(parsed.payload.cacheWriteTokens).toBe(10);
    expect(parsed.payload.cacheReadTokensTotal).toBe(55);
  });

  it('accepts trace.updated events', () => {
    const parsed = EventMessageSchema.parse({
      category: 'event',
      type: 'trace.updated',
      sessionId: 'sess_1',
      sequence: 4,
      timestamp: new Date().toISOString(),
      payload: {
        taskId: 'trc_1',
        event: { kind: 'llm.turn', cacheReadTokens: 12 },
        snapshot: { taskId: 'trc_1', events: [] },
      },
    });
    expect(parsed.type).toBe('trace.updated');
  });
});
