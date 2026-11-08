import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LspManager } from '../src/lsp/LspManager.js';

describe('LspManager (TypeScript Language Service)', () => {
  let root = '';
  let lsp: LspManager;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'dac-lsp-'));
    await fs.writeFile(
      path.join(root, 'math.ts'),
      [
        'export function add(a: number, b: number) {',
        '  return a + b;',
        '}',
        'const z = add(1, 2);',
      ].join('\n'),
      'utf-8'
    );
    lsp = new LspManager();
    await lsp.setWorkspace(root);
  });

  afterEach(async () => {
    await lsp.dispose();
    try {
      await fs.rm(root, { recursive: true, force: true });
    } catch {
      // Windows may briefly lock temp dirs; ignore cleanup races
    }
  });

  it('resolves TS definition via language service', async () => {
    const content = await fs.readFile(path.join(root, 'math.ts'), 'utf-8');
    // cursor on `add` in the call site (line 4)
    const matches = await lsp.definition('math.ts', 4, 12, content);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].file.replace(/\\/g, '/')).toContain('math.ts');
    expect(matches[0].line).toBe(1);
  });

  it('reports TS diagnostics', async () => {
    const bad = 'const n: number = "nope";\n';
    await fs.writeFile(path.join(root, 'bad.ts'), bad, 'utf-8');
    const diags = await lsp.diagnostics('bad.ts', bad);
    expect(diags.some((d) => d.severity === 'error')).toBe(true);
  });

  it('exposes status for typescript engine', () => {
    const status = lsp.getStatus();
    expect(status.typescript.ready).toBe(true);
    expect(status.typescript.mode).toBe('language-service');
  });
});
