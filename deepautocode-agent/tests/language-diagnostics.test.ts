import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  diagnoseTypeScriptFile,
  diagnoseEditedFile,
  attachDiagnosticSnippets,
} from '../src/core/LanguageDiagnostics.js';
import { extractFailedTestHints } from '../src/core/BuildDiagnostics.js';
import { FileStateCache } from '../src/core/FileStateCache.js';
import { resolveTieredModelForTurn } from '../src/core/GoalSteering.js';
import { MAX_SELF_HEAL_ATTEMPTS } from '../src/core/index.js';
import { searchIndexedFiles, WorkspaceFileIndex } from '../src/core/WorkspaceFileIndex.js';

describe('LanguageDiagnostics (agent post-edit)', () => {
  it('reports TS type errors for in-memory content', () => {
    const content = 'const n: number = "nope";\n';
    const diags = diagnoseTypeScriptFile({
      workspaceRoot: process.cwd(),
      filePath: 'bad.ts',
      content,
    });
    expect(diags.some((d) => d.severity === 'error')).toBe(true);
    const snip = attachDiagnosticSnippets(content, diags);
    expect(snip).toContain('bad.ts');
  });

  it('diagnoseEditedFile routes python syntax errors', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dac-py-diag-'));
    try {
      const diags = await diagnoseEditedFile({
        workspaceRoot: root,
        filePath: 'bad.py',
        content: 'def broken(\n',
      });
      // py_compile may be unavailable on PATH — then empty is acceptable
      if (diags.length > 0) {
        expect(diags.some((d) => d.severity === 'error')).toBe(true);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('uses tsconfig when present for project-aware diagnostics', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dac-ts-diag-'));
    try {
      await fs.writeFile(
        path.join(root, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext' },
          include: ['*.ts'],
        }),
        'utf-8'
      );
      const diags = diagnoseTypeScriptFile({
        workspaceRoot: root,
        filePath: 'strict.ts',
        content: 'export const x: string = 1;\n',
      });
      expect(diags.some((d) => d.severity === 'error')).toBe(true);
      expect(diags[0]?.source).toMatch(/typescript-ls/);
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

describe('searchIndexedFiles upgrades', () => {
  it('supports regex and symbol mode', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dac-search-'));
    try {
      await fs.mkdir(path.join(root, 'src'));
      await fs.writeFile(
        path.join(root, 'src', 'a.ts'),
        'export function findAlpha() { return 1; }\nconst zz = 2;\n',
        'utf-8'
      );
      const index = new WorkspaceFileIndex(root);
      const re = await searchIndexedFiles({
        root,
        index,
        query: 'findAlp\\w+',
        regex: true,
        mode: 'content',
      });
      expect(re).toContain('findAlpha');

      const sym = await searchIndexedFiles({
        root,
        index,
        query: 'findAlpha',
        mode: 'symbol',
      });
      expect(sym).toMatch(/findAlpha|symbols/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

describe('extractFailedTestHints', () => {
  it('parses vitest-style FAIL lines', () => {
    const hints = extractFailedTestHints(' FAIL  tests/foo.test.ts > does thing\n');
    expect(hints.length).toBeGreaterThan(0);
    expect(hints[0]).toMatch(/foo\.test/);
  });
});

describe('FileStateCache multi-hunk', () => {
  it('applies multiple replacements', () => {
    const src = 'aaa\nbbb\nccc\n';
    const out = FileStateCache.applyMultiHunkReplacements(
      src,
      [
        { oldText: 'aaa', newText: 'AAA' },
        { oldText: 'ccc', newText: 'CCC' },
      ],
      (content, oldText, newText) => content.replace(oldText, () => newText)
    );
    expect(out).toBe('AAA\nbbb\nCCC\n');
  });
});

describe('resolveTieredModelForTurn coding-power signals', () => {
  it('promotes reasoner on semantic failure and mismatch', () => {
    const semantic = resolveTieredModelForTurn({
      configuredModelId: 'deepseek-auto',
      providerId: 'deepseek',
      userPrompt: 'fix types',
      turnIndex: 3,
      selfHealCount: 0,
      hasSemanticFailure: true,
      routingMode: 'auto',
    });
    expect(semantic.tier).toBe('deep-reasoner');

    const mismatch = resolveTieredModelForTurn({
      configuredModelId: 'deepseek-auto',
      providerId: 'deepseek',
      userPrompt: 'edit',
      turnIndex: 4,
      selfHealCount: 0,
      editMismatchCount: 2,
      routingMode: 'auto',
    });
    expect(mismatch.tier).toBe('deep-reasoner');

    const multi = resolveTieredModelForTurn({
      configuredModelId: 'deepseek-auto',
      providerId: 'deepseek',
      userPrompt: 'multi file',
      turnIndex: 2,
      selfHealCount: 0,
      multiFilePending: true,
      routingMode: 'auto',
    });
    expect(multi.tier).toBe('deep-reasoner');
  });

  it('exports self-heal budget of 5', () => {
    expect(MAX_SELF_HEAL_ATTEMPTS).toBe(5);
  });
});
