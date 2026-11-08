import { describe, expect, it } from 'vitest';
import {
  filterRulesForPaths,
  parseRuleFrontmatter,
  pathMatchesGlobs,
  selectSkillsForPrompt,
} from '../src/core/PromptBuilder.js';
import { runEditSubagent } from '../src/core/EditSubagent.js';
import { applyStandardToolAliases } from '../src/core/ToolRegistry.js';
import { createTool } from '../src/core/ToolSuite.js';

describe('rules globs / frontmatter', () => {
  it('parses Cursor-style frontmatter', () => {
    const raw = `---
description: TS only
globs: **/*.ts,**/*.tsx
alwaysApply: false
---
Use strict null checks.
`;
    const parsed = parseRuleFrontmatter(raw);
    expect(parsed.alwaysApply).toBe(false);
    expect(parsed.globs).toEqual(expect.arrayContaining(['**/*.ts', '**/*.tsx']));
    expect(parsed.body).toContain('strict null');
    expect(parsed.description).toBe('TS only');
  });

  it('matches globs against relative paths', () => {
    expect(pathMatchesGlobs('src/foo.ts', ['**/*.ts'])).toBe(true);
    expect(pathMatchesGlobs('src/foo.tsx', ['**/*.ts'])).toBe(false);
    expect(pathMatchesGlobs('deepautocode/webview/src/App.tsx', ['**/webview/**'])).toBe(true);
  });

  it('filters rules by active paths', () => {
    const rules = [
      {
        name: 'always',
        path: '.cursor/rules/always.mdc',
        content: 'always',
        alwaysApply: true,
        globs: [],
      },
      {
        name: 'ts-only',
        path: '.cursor/rules/ts.mdc',
        content: 'ts',
        alwaysApply: false,
        globs: ['**/*.ts'],
      },
      {
        name: 'css-only',
        path: '.cursor/rules/css.mdc',
        content: 'css',
        alwaysApply: false,
        globs: ['**/*.css'],
      },
    ];
    const filtered = filterRulesForPaths(rules, ['src/main.ts']);
    expect(filtered.map((r) => r.name).sort()).toEqual(['always', 'ts-only']);
  });

  it('drops unmatched globbed rules when no path context (Stage S strict)', () => {
    const rules = [
      {
        name: 'always',
        path: 'a',
        content: 'a',
        alwaysApply: true,
        globs: [],
      },
      {
        name: 'globbed',
        path: 'b',
        content: 'b',
        alwaysApply: false,
        globs: ['**/*.ts'],
      },
    ];
    expect(filterRulesForPaths(rules, []).map((r) => r.name)).toEqual(['always']);
  });

  it('expands skills only when mentioned', () => {
    const skills = [
      {
        name: 'release',
        description: 'Release checklist',
        path: '.agents/skills/release/SKILL.md',
        content: '# Release\nDo X then Y',
      },
      {
        name: 'review',
        description: 'Code review',
        path: '.agents/skills/review/SKILL.md',
        content: '# Review\nCheck Z',
      },
    ];
    const catalog = selectSkillsForPrompt(skills, { prompt: 'hello world' });
    expect(catalog.every((s) => !s.expanded && !s.content)).toBe(true);
    const expanded = selectSkillsForPrompt(skills, { prompt: 'please use @skill:release' });
    expect(expanded.find((s) => s.name === 'release')?.expanded).toBe(true);
    expect(expanded.find((s) => s.name === 'release')?.content).toContain('Do X');
    expect(expanded.find((s) => s.name === 'review')?.expanded).toBe(false);
  });
});

describe('ToolRegistry aliases', () => {
  it('exposes grep / explore / str_replace aliases', () => {
    const tools = applyStandardToolAliases([
      createTool({
        name: 'search_codebase',
        description: 'search',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => ({}),
      }),
      createTool({
        name: 'explore_codebase',
        description: 'explore',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => ({}),
      }),
      createTool({
        name: 'edit_file',
        description: 'edit',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => ({}),
      }),
    ]);
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['search_codebase', 'grep', 'explore', 'str_replace'])
    );
  });
});

describe('EditSubagent', () => {
  it('applies budgeted edits and rolls back on diagnose fail', async () => {
    const files: Record<string, string> = {
      'src/a.ts': 'export const x = 1;\n',
    };
    const result = await runEditSubagent({
      task: 'rename x to y',
      files: ['src/a.ts'],
      maxFiles: 1,
      maxEdits: 2,
      readFile: async (p) => files[p],
      writeFile: async (p, c) => {
        files[p] = c;
      },
      applyEdit: async (p, oldText, newText) => {
        if (!files[p].includes(oldText)) return { ok: false, error: 'missing' };
        files[p] = files[p].replace(oldText, newText);
        return { ok: true, content: files[p] };
      },
      diagnose: async () => 'error TS2304: boom',
      llmPropose: async () =>
        JSON.stringify([
          { filePath: 'src/a.ts', oldText: 'export const x = 1;', newText: 'export const y = 1;' },
        ]),
    });
    expect(result.rolledBack).toBe(true);
    expect(files['src/a.ts']).toContain('const x');
    expect(result.editsApplied).toBe(0);
  });

  it('keeps edits when diagnostics pass', async () => {
    const files: Record<string, string> = {
      'src/a.ts': 'export const x = 1;\n',
    };
    const result = await runEditSubagent({
      task: 'rename x to y',
      files: ['src/a.ts'],
      readFile: async (p) => files[p],
      writeFile: async (p, c) => {
        files[p] = c;
      },
      applyEdit: async (p, oldText, newText) => {
        files[p] = files[p].replace(oldText, newText);
        return { ok: true, content: files[p] };
      },
      diagnose: async () => null,
      llmPropose: async () =>
        JSON.stringify([
          { filePath: 'src/a.ts', oldText: 'export const x = 1;', newText: 'export const y = 1;' },
        ]),
    });
    expect(result.ok).toBe(true);
    expect(result.rolledBack).toBe(false);
    expect(files['src/a.ts']).toContain('const y');
  });
});
