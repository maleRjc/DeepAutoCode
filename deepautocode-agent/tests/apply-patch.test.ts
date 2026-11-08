import { describe, expect, it } from 'vitest';
import {
  applyMultiFilePatch,
  applyPatchToContent,
  parseUnifiedPatch,
} from '../src/core/ApplyPatch.js';

describe('ApplyPatch', () => {
  it('parses classic unified diff and applies hunks', () => {
    const original = ['line1', 'oldA', 'oldB', 'line4', ''].join('\n');
    const patch = [
      '--- a/src/demo.ts',
      '+++ b/src/demo.ts',
      '@@ -1,4 +1,4 @@',
      ' line1',
      '-oldA',
      '-oldB',
      '+newA',
      '+newB',
      ' line4',
      '',
    ].join('\n');

    const files = parseUnifiedPatch(patch);
    expect(files[0]?.filePath).toBe('src/demo.ts');
    expect(files[0]?.hunks.length).toBe(1);

    const res = applyPatchToContent('src/demo.ts', original, patch);
    expect(res.ok).toBe(true);
    expect(res.content).toContain('newA');
    expect(res.content).not.toContain('oldA');
    expect(res.hunksApplied).toBe(1);
  });

  it('returns hint when hunk does not match', () => {
    const original = 'alpha\nbeta\n';
    const patch = [
      '*** Begin Patch',
      '*** Update File: foo.ts',
      '@@ -1,1 +1,1 @@',
      '-missing',
      '+present',
      '*** End Patch',
    ].join('\n');
    const res = applyPatchToContent('foo.ts', original, patch);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/HUNK_NOT_FOUND|PATCH_/);
  });

  it('replaces only the first matching block (never global replace-all)', () => {
    const original = ['dup', 'keep', 'dup', 'tail', ''].join('\n');
    const patch = [
      '*** Begin Patch',
      '*** Update File: multi.ts',
      '@@ -1,1 +1,1 @@',
      '-dup',
      '+once',
      '*** End Patch',
    ].join('\n');
    const res = applyPatchToContent('multi.ts', original, patch);
    expect(res.ok).toBe(true);
    const lines = (res.content || '').replace(/\r\n/g, '\n').split('\n');
    expect(lines[0]).toBe('once');
    expect(lines[2]).toBe('dup');
  });

  it('supports Add File and Delete File ops', () => {
    const addPatch = [
      '*** Begin Patch',
      '*** Add File: new.ts',
      '@@ -0,0 +1,2 @@',
      '+export const x = 1;',
      '+',
      '*** End Patch',
    ].join('\n');
    const added = applyPatchToContent('new.ts', '', addPatch);
    expect(added.ok).toBe(true);
    expect(added.created).toBe(true);
    expect(added.content).toContain('export const x = 1;');

    const delPatch = [
      '*** Begin Patch',
      '*** Delete File: old.ts',
      '*** End Patch',
    ].join('\n');
    const parsed = parseUnifiedPatch(delPatch);
    expect(parsed[0]?.op).toBe('delete');
    const deleted = applyPatchToContent('old.ts', 'gone\n', delPatch);
    expect(deleted.ok).toBe(true);
    expect(deleted.deleted).toBe(true);
  });

  it('applies multi-file patch in memory with rollback snapshots', () => {
    const store: Record<string, string> = {
      'a.ts': 'foo\n',
      'b.ts': 'bar\n',
    };
    const patch = [
      '*** Begin Patch',
      '*** Update File: a.ts',
      '@@ -1,1 +1,1 @@',
      '-foo',
      '+FOO',
      '*** Update File: b.ts',
      '@@ -1,1 +1,1 @@',
      '-bar',
      '+BAR',
      '*** End Patch',
    ].join('\n');
    const res = applyMultiFilePatch(patch, (p) => store[p] ?? null);
    expect(res.ok).toBe(true);
    expect(res.files).toHaveLength(2);
    expect(res.files[0].afterContent).toContain('FOO');
    expect(res.files[1].afterContent).toContain('BAR');
    expect(res.rollbackSnapshots).toHaveLength(2);
  });

  it('stops multi-file apply on first failure and keeps prior rollback snapshots', () => {
    const store: Record<string, string> = {
      'a.ts': 'foo\n',
      'b.ts': 'bar\n',
    };
    const patch = [
      '*** Begin Patch',
      '*** Update File: a.ts',
      '@@ -1,1 +1,1 @@',
      '-foo',
      '+FOO',
      '*** Update File: b.ts',
      '@@ -1,1 +1,1 @@',
      '-MISSING',
      '+BAR',
      '*** End Patch',
    ].join('\n');
    const res = applyMultiFilePatch(patch, (p) => store[p] ?? null);
    expect(res.ok).toBe(false);
    expect(res.files).toHaveLength(1);
    expect(res.rollbackSnapshots).toHaveLength(1);
    expect(res.error).toMatch(/HUNK_NOT_FOUND/);
  });

  it('matches trim-tolerant / nearby drifted lines', () => {
    const original = ['alpha', 'old  ', 'gamma', ''].join('\n');
    const patch = [
      '--- a/drift.ts',
      '+++ b/drift.ts',
      '@@ -2,1 +2,1 @@',
      '-old',
      '+new',
    ].join('\n');
    const res = applyPatchToContent('drift.ts', original, patch);
    expect(res.ok).toBe(true);
    expect(res.content).toContain('new');
    expect(res.content).not.toMatch(/^old/m);
  });
});
