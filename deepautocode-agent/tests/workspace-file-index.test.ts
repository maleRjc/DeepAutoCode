import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  searchIndexedFiles,
  WorkspaceFileIndex,
} from '../src/core/WorkspaceFileIndex.js';

describe('WorkspaceFileIndex', () => {
  let root = '';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'dac-file-index-'));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'src', 'alpha.ts'),
      'export function findAlpha() {\n  return 1;\n}\n'
    );
    await fs.writeFile(
      path.join(root, 'src', 'beta.ts'),
      'export const BETA = "findAlpha";\n'
    );
    await fs.writeFile(
      path.join(root, 'node_modules', 'pkg', 'index.js'),
      'export const noise = "findAlpha";\n'
    );
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('indexes source files and skips node_modules', async () => {
    const index = new WorkspaceFileIndex(root, { ttlMs: 60_000 });
    const files = await index.ensureFresh();
    const rels = files.map((f) => f.relPath).sort();
    expect(rels).toContain('src/alpha.ts');
    expect(rels).toContain('src/beta.ts');
    expect(rels.some((r) => r.includes('node_modules'))).toBe(false);
  });

  it('reuses cache within ttl and refreshes after invalidate', async () => {
    const index = new WorkspaceFileIndex(root, { ttlMs: 60_000 });
    await index.ensureFresh();
    const firstSize = index.size;
    await fs.writeFile(path.join(root, 'src', 'gamma.ts'), 'export const G = 1;\n');
    await index.ensureFresh();
    expect(index.size).toBe(firstSize);
    index.invalidate();
    await index.ensureFresh(true);
    expect(index.size).toBe(firstSize + 1);
  });

  it('searchIndexedFiles returns content matches with context', async () => {
    const index = new WorkspaceFileIndex(root);
    const out = await searchIndexedFiles({
      root,
      index,
      query: 'findAlpha',
      contextLines: 1,
    });
    expect(out).toContain('src/alpha.ts');
    expect(out).toContain('src/beta.ts');
    expect(out).not.toContain('node_modules');
    expect(out).toMatch(/> src\/alpha\.ts:\d+:/);
  });

  it('scopes search under a subdirectory', async () => {
    await fs.mkdir(path.join(root, 'other'), { recursive: true });
    await fs.writeFile(path.join(root, 'other', 'x.ts'), 'findAlpha elsewhere\n');
    const index = new WorkspaceFileIndex(root);
    const out = await searchIndexedFiles({
      root,
      index,
      query: 'findAlpha',
      under: 'src',
    });
    expect(out).toContain('src/alpha.ts');
    expect(out).not.toContain('other/x.ts');
  });
});
