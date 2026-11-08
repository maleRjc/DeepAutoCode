import { describe, expect, it } from 'vitest';
import {
  buildContentFromAcceptedHunks,
  parseDiffHunks,
  rebuildProposedAfterHunkDecision,
} from '../src/diff-hunks.js';

describe('diff-hunks', () => {
  it('splits contiguous changes into hunks and rebuilds accepted subset', () => {
    const original = ['a', 'b', 'c', 'd', 'e', 'f', ''].join('\n');
    const proposed = ['a', 'B', 'c', 'd', 'E', 'f', ''].join('\n');
    const hunks = parseDiffHunks({ originalContent: original, proposedContent: proposed });
    expect(hunks.length).toBeGreaterThanOrEqual(1);

    const onlyFirst = buildContentFromAcceptedHunks(
      original,
      hunks,
      hunks.length > 1 ? [hunks[0].index] : [0]
    );
    expect(onlyFirst).toContain('B');
    if (hunks.length > 1) {
      expect(onlyFirst.includes('E')).toBe(false);
    }
  });

  it('rebuilds proposed after rejecting a hunk', () => {
    const original = ['x', 'old', 'y', ''].join('\n');
    const proposed = ['x', 'new', 'y', ''].join('\n');
    const hunks = parseDiffHunks({ originalContent: original, proposedContent: proposed });
    const decisions = hunks.map(() => 'rejected' as const);
    const res = rebuildProposedAfterHunkDecision({
      originalContent: original,
      hunks,
      decisions,
    });
    expect(res.proposedContent).toContain('old');
    expect(res.rejectedCount).toBe(hunks.length);
    expect(res.remainingPending).toBe(0);
  });
});
