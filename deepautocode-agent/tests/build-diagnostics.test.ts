import { describe, expect, it } from 'vitest';
import {
  formatDiagnosticsForPrompt,
  parseBuildDiagnostics,
  rankDefinitionCandidates,
} from '../src/core/BuildDiagnostics.js';

describe('BuildDiagnostics', () => {
  it('parses gcc/clang and tsc diagnostics', () => {
    const out = parseBuildDiagnostics(
      [
        'src/enqueue.cc:128:5: error: use of undeclared identifier \'nBytesAhead\'',
        'src/math.ts(12,3): error TS2322: Type \'string\' is not assignable to type \'number\'.',
        'src/util.ts:4:10: warning Unexpected any',
      ].join('\n'),
      ''
    );
    expect(out.length).toBeGreaterThanOrEqual(3);
    expect(out.some((d) => d.file.includes('enqueue.cc') && d.severity === 'error')).toBe(true);
    expect(out.some((d) => d.source === 'tsc')).toBe(true);
  });

  it('formats diagnostics for @problems prompt injection', () => {
    const text = formatDiagnosticsForPrompt([
      {
        file: 'a.ts',
        line: 1,
        severity: 'error',
        message: 'boom',
        source: 'tsc',
      },
    ]);
    expect(text).toContain('ERROR a.ts:1');
    expect(text).toContain('boom');
  });

  it('ranks definition-like candidates higher', () => {
    const ranked = rankDefinitionCandidates('reduceCopy', [
      { file: 'a.cc', line: 10, preview: '  return reduceCopy(n);' },
      { file: 'b.cc', line: 40, preview: 'static int reduceCopy(int n) {' },
    ]);
    expect(ranked[0].file).toBe('b.cc');
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });
});
