import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionTodoList } from '../src/core/SessionTodo.js';
import { runResearchSubagent, runPlannerSubagent } from '../src/core/ResearchSubagent.js';
import { WorkspaceFileIndex } from '../src/core/WorkspaceFileIndex.js';

describe('SessionTodoList', () => {
  it('supports set/add/complete and format', () => {
    const todos = new SessionTodoList();
    todos.manage({
      action: 'set',
      items: [
        { content: 'Find root cause' },
        { content: 'Run verify', status: 'pending' },
      ],
    });
    expect(todos.list().length).toBe(2);
    expect(todos.hasIncomplete).toBe(true);
    const added = todos.manage({ action: 'add', content: 'Write summary' });
    expect(added.ok).toBe(true);
    const id = todos.list()[0].id;
    todos.manage({ action: 'complete', id });
    expect(todos.formatForPrompt()).toMatch(/\[x\]/);
    todos.completeMatching((c) => /verify/i.test(c));
    expect(todos.incomplete.some((i) => /verify/i.test(i.content))).toBe(false);
  });
});

describe('ResearchSubagent', () => {
  let root = '';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'dac-research-'));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'src', 'widget.ts'),
      [
        'export function createWidget() {',
        '  return { ok: true };',
        '}',
        'export function renderWidget() {',
        '  return createWidget();',
        '}',
        '',
      ].join('\n'),
      'utf-8'
    );
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  it('runs multi-round research and returns evidence', async () => {
    const index = new WorkspaceFileIndex(root);
    const res = await runResearchSubagent({
      workspaceRoot: root,
      task: 'Investigate createWidget rendering path and find callers',
      queries: ['createWidget'],
      index,
      maxRounds: 4,
    });
    expect(res.ok).toBe(true);
    expect(res.rounds).toBeGreaterThanOrEqual(1);
    expect(res.report).toMatch(/createWidget|Research|Guided|Round/i);
    expect(res.filesInspected.some((f) => f.includes('widget.ts'))).toBe(true);
    expect(res.suggestedTodos!.length).toBeGreaterThan(0);
  });

  it('planner returns plan markdown and todos', async () => {
    const index = new WorkspaceFileIndex(root);
    const res = await runPlannerSubagent({
      workspaceRoot: root,
      task: 'Fix createWidget',
      queries: ['createWidget'],
      index,
    });
    expect(res.role).toBe('planner');
    expect(res.planMarkdown).toMatch(/## Steps/);
    expect(res.suggestedTodos!.some((t) => /verify|Edit|Confirm/i.test(t))).toBe(true);
  });
});
