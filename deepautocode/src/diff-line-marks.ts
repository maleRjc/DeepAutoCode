/**
 * Compute 1-based line marks for the *proposed* buffer vs original.
 * Used to paint pending Agent Diffs in the live editor.
 */

export type DiffLineKind = 'add' | 'del' | 'mod';

/**
 * Myers-lite / LCS line diff: mark lines present in proposed that differ / were added.
 * Deleted-only original lines are returned separately (not in proposed).
 */
export function computeDiffLineMarks(
  originalContent: string,
  proposedContent: string
): {
  proposedMarks: Map<number, DiffLineKind>;
  deletedOriginalLines: number[];
} {
  const a = String(originalContent ?? '').split(/\r?\n/);
  const b = String(proposedContent ?? '').split(/\r?\n/);
  const proposedMarks = new Map<number, DiffLineKind>();
  const deletedOriginalLines: number[] = [];

  const aCounts = new Map<string, number>();
  for (const line of a) {
    aCounts.set(line, (aCounts.get(line) ?? 0) + 1);
  }

  const maxN = 4000;
  const n = Math.min(a.length, maxN);
  const m = Math.min(b.length, maxN);
  if (n === 0 && m === 0) {
    return { proposedMarks, deletedOriginalLines };
  }

  // Large files: O(N) pairwise walk
  if (n * m > 1_500_000) {
    const maxLen = Math.max(a.length, b.length);
    for (let i = 0; i < maxLen; i++) {
      const o = a[i];
      const p = b[i];
      if (o === p) continue;
      if (p !== undefined && o === undefined) proposedMarks.set(i + 1, 'add');
      else if (p !== undefined && o !== undefined) proposedMarks.set(i + 1, 'mod');
      else if (o !== undefined && p === undefined) deletedOriginalLines.push(i + 1);
    }
    return { proposedMarks, deletedOriginalLines };
  }

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      deletedOriginalLines.push(i + 1);
      i += 1;
    } else {
      const remaining = aCounts.get(b[j]) ?? 0;
      const kind: DiffLineKind = remaining > 0 ? 'mod' : 'add';
      if (remaining > 0) aCounts.set(b[j], remaining - 1);
      proposedMarks.set(j + 1, kind);
      j += 1;
    }
  }
  while (i < n) {
    deletedOriginalLines.push(i + 1);
    i += 1;
  }
  while (j < m) {
    proposedMarks.set(j + 1, 'add');
    j += 1;
  }

  for (let k = m; k < b.length; k++) {
    if (!proposedMarks.has(k + 1)) proposedMarks.set(k + 1, 'add');
  }
  for (let k = n; k < a.length; k++) {
    deletedOriginalLines.push(k + 1);
  }

  return { proposedMarks, deletedOriginalLines };
}

export function marksFromDiffRecord(diff: {
  originalContent?: string;
  proposedContent?: string;
  status?: string;
}): Map<number, DiffLineKind> {
  if (!diff || diff.status !== 'pending') return new Map();
  return computeDiffLineMarks(diff.originalContent || '', diff.proposedContent || '')
    .proposedMarks;
}
