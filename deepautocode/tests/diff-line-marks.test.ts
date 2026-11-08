import { describe, expect, it } from 'vitest';
import { computeDiffLineMarks, marksFromDiffRecord } from '../src/diff-line-marks.js';

describe('diff-line-marks', () => {
  it('marks added and modified proposed lines', () => {
    const original = ['a', 'b', 'c'].join('\n');
    const proposed = ['a', 'B', 'c', 'd'].join('\n');
    const { proposedMarks, deletedOriginalLines } = computeDiffLineMarks(original, proposed);
    expect(proposedMarks.get(2)).toBeTruthy();
    expect(proposedMarks.get(4)).toBe('add');
    expect(deletedOriginalLines.length).toBeGreaterThanOrEqual(0);
  });

  it('only marks pending diffs', () => {
    const pending = marksFromDiffRecord({
      status: 'pending',
      originalContent: 'x\n',
      proposedContent: 'y\n',
    });
    expect(pending.size).toBeGreaterThan(0);
    const accepted = marksFromDiffRecord({
      status: 'accepted',
      originalContent: 'x\n',
      proposedContent: 'y\n',
    });
    expect(accepted.size).toBe(0);
  });
});
