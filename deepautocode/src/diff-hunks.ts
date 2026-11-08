/**
 * Split a pending Diff into reviewable hunks and rebuild file content
 * from a subset of accepted hunks (Cursor-style partial accept).
 */

export interface DiffHunkView {
  index: number;
  header: string;
  oldStart: number;
  oldLines: string[];
  newLines: string[];
  /** Short preview for UI */
  preview: string;
}

const HUNK_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

function splitLines(text: string): string[] {
  return String(text ?? '').replace(/\r\n/g, '\n').split('\n');
}

function joinLines(lines: string[], preferCrLf: boolean): string {
  const body = lines.join('\n');
  return preferCrLf ? body.replace(/\n/g, '\r\n') : body;
}

/**
 * Parse @@ hunks from a unified diff. Falls back to contiguous change blocks
 * when the diff is a single naive whole-file hunk.
 */
export function parseDiffHunks(params: {
  unifiedDiff?: string;
  originalContent?: string;
  proposedContent?: string;
}): DiffHunkView[] {
  const fromUnified = parseUnifiedHunks(String(params.unifiedDiff || ''));
  if (fromUnified.length > 1) return fromUnified;

  // Single giant hunk or empty → derive contiguous blocks from original/proposed
  const blocks = computeContiguousHunks(
    String(params.originalContent ?? ''),
    String(params.proposedContent ?? '')
  );
  if (blocks.length > 0) return blocks;
  return fromUnified;
}

function parseUnifiedHunks(unifiedDiff: string): DiffHunkView[] {
  const lines = splitLines(unifiedDiff);
  const hunks: DiffHunkView[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = HUNK_RE.exec(lines[i]);
    if (!m) {
      i += 1;
      continue;
    }
    const oldStart = Number(m[1]) || 1;
    const oldLines: string[] = [];
    const newLines: string[] = [];
    const header = m[0];
    i += 1;
    while (i < lines.length && !HUNK_RE.test(lines[i]) && !/^---\s/.test(lines[i]) && !/^\+\+\+\s/.test(lines[i])) {
      const l = lines[i];
      if (l.startsWith('+')) newLines.push(l.slice(1));
      else if (l.startsWith('-')) oldLines.push(l.slice(1));
      else if (l.startsWith(' ') || l === '') {
        const body = l.startsWith(' ') ? l.slice(1) : l;
        oldLines.push(body);
        newLines.push(body);
      } else if (l.startsWith('\\')) {
        // no newline marker
      } else {
        break;
      }
      i += 1;
    }
    hunks.push({
      index: hunks.length,
      header,
      oldStart,
      oldLines,
      newLines,
      preview: formatPreview(oldLines, newLines),
    });
  }
  return hunks;
}

/**
 * Group consecutive differing lines into hunks (with 2 lines of context).
 */
function computeContiguousHunks(original: string, proposed: string): DiffHunkView[] {
  const a = splitLines(original);
  const b = splitLines(proposed);
  if (a.join('\n') === b.join('\n')) return [];

  // Pairwise walk — good enough for Agent-sized edits
  type Seg = { a0: number; a1: number; b0: number; b1: number };
  const segs: Seg[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    const a0 = i;
    const b0 = j;
    // Advance through unequal region: consume until next equal pair or end
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) break;
      // Prefer consuming from the longer remaining side when mismatched
      if (j >= b.length || (i < a.length && (a[i] !== b[j] || j >= b.length))) {
        // try find a[i] later in b
        let found = -1;
        if (i < a.length) {
          for (let k = j; k < Math.min(b.length, j + 40); k++) {
            if (b[k] === a[i]) {
              found = k;
              break;
            }
          }
        }
        if (found > j) {
          // lines b[j..found) are inserts
          j = found;
          break;
        }
        if (i < a.length && (j >= b.length || a[i] !== b[j])) {
          i += 1;
          continue;
        }
      }
      if (i >= a.length && j < b.length) {
        j += 1;
        continue;
      }
      if (j < b.length && i < a.length && a[i] !== b[j]) {
        // treat as replace pair
        i += 1;
        j += 1;
        continue;
      }
      break;
    }
    const a1 = i;
    const b1 = j;
    if (a1 > a0 || b1 > b0) segs.push({ a0, a1, b0, b1 });
    if (a1 === a0 && b1 === b0) {
      // stuck — force advance
      if (i < a.length) i += 1;
      else if (j < b.length) j += 1;
      else break;
    }
  }

  // Merge nearby segs (within 3 context lines)
  const merged: Seg[] = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && s.a0 - last.a1 <= 3) {
      last.a1 = s.a1;
      last.b1 = s.b1;
    } else {
      merged.push({ ...s });
    }
  }

  return merged.map((s, idx) => {
    const ctx = 2;
    const oldStart = Math.max(0, s.a0 - ctx);
    const oldEnd = Math.min(a.length, s.a1 + ctx);
    const newStart = Math.max(0, s.b0 - ctx);
    const newEnd = Math.min(b.length, s.b1 + ctx);
    // Align context: take prefix context from original, changed region, suffix context
    const pre = a.slice(oldStart, s.a0);
    const oldMid = a.slice(s.a0, s.a1);
    const post = a.slice(s.a1, oldEnd);
    const newMid = b.slice(s.b0, s.b1);
    // new side context: use same pre/post when possible
    const oldLines = [...pre, ...oldMid, ...post];
    const newLines = [...pre, ...newMid, ...post];
    const header = `@@ -${oldStart + 1},${oldLines.length} +${newStart + 1},${newLines.length} @@`;
    return {
      index: idx,
      header,
      oldStart: oldStart + 1,
      oldLines,
      newLines,
      preview: formatPreview(oldMid.length ? oldMid : oldLines, newMid.length ? newMid : newLines),
    };
  });
}

function formatPreview(oldLines: string[], newLines: string[]): string {
  const dels = oldLines.filter((l, i) => newLines[i] !== l || !newLines.includes(l)).slice(0, 3);
  const adds = newLines.filter((l, i) => oldLines[i] !== l).slice(0, 3);
  const lines = [
    ...dels.map((l) => `- ${l.slice(0, 100)}`),
    ...adds.map((l) => `+ ${l.slice(0, 100)}`),
  ];
  return lines.join('\n').slice(0, 400) || '(empty hunk)';
}

function findBlock(
  fileLines: string[],
  oldLines: string[],
  preferStart: number
): number {
  const eq = (i: number, trim: boolean) => {
    if (i < 0 || i + oldLines.length > fileLines.length) return false;
    for (let j = 0; j < oldLines.length; j++) {
      const a = fileLines[i + j];
      const b = oldLines[j];
      if (trim ? a.trimEnd() !== b.trimEnd() : a !== b) return false;
    }
    return true;
  };
  if (eq(preferStart, false) || eq(preferStart, true)) return preferStart;
  for (let i = 0; i <= fileLines.length - oldLines.length; i++) {
    if (eq(i, false) || eq(i, true)) return i;
  }
  return -1;
}

function applyOneHunk(content: string, hunk: DiffHunkView): string {
  const hasCrLf = content.includes('\r\n');
  const fileLines = splitLines(content);
  if (hunk.oldLines.length === 0) {
    const idx = Math.min(fileLines.length, Math.max(0, hunk.oldStart - 1));
    const next = [...fileLines.slice(0, idx), ...hunk.newLines, ...fileLines.slice(idx)];
    return joinLines(next, hasCrLf);
  }
  const at = findBlock(fileLines, hunk.oldLines, Math.max(0, hunk.oldStart - 1));
  if (at < 0) {
    throw new Error(`HUNK_NOT_FOUND: ${hunk.header}`);
  }
  const next = [
    ...fileLines.slice(0, at),
    ...hunk.newLines,
    ...fileLines.slice(at + hunk.oldLines.length),
  ];
  return joinLines(next, hasCrLf);
}

/**
 * Rebuild file content by applying keepIndices hunks onto original (in order).
 */
export function buildContentFromAcceptedHunks(
  originalContent: string,
  hunks: DiffHunkView[],
  keepIndices: number[]
): string {
  const keep = new Set(keepIndices);
  let content = originalContent;
  const ordered = [...hunks].sort((a, b) => a.oldStart - b.oldStart);
  for (const h of ordered) {
    if (!keep.has(h.index)) continue;
    content = applyOneHunk(content, h);
  }
  return content;
}

/**
 * After rejecting some hunks: content = original + accepted + still-pending.
 * Rejected are omitted.
 */
export function rebuildProposedAfterHunkDecision(params: {
  originalContent: string;
  hunks: DiffHunkView[];
  decisions: Array<'pending' | 'accepted' | 'rejected'>;
}): { proposedContent: string; remainingPending: number; acceptedCount: number; rejectedCount: number } {
  const keep: number[] = [];
  let remainingPending = 0;
  let acceptedCount = 0;
  let rejectedCount = 0;
  for (let i = 0; i < params.hunks.length; i++) {
    const d = params.decisions[i] || 'pending';
    if (d === 'rejected') {
      rejectedCount += 1;
      continue;
    }
    if (d === 'accepted') acceptedCount += 1;
    if (d === 'pending') remainingPending += 1;
    keep.push(params.hunks[i].index);
  }
  const proposedContent = buildContentFromAcceptedHunks(
    params.originalContent,
    params.hunks,
    keep
  );
  return { proposedContent, remainingPending, acceptedCount, rejectedCount };
}

export function createSimpleUnifiedDiff(
  filePath: string,
  original: string,
  proposed: string
): string {
  const hunks = parseDiffHunks({ originalContent: original, proposedContent: proposed });
  const rel = filePath.replace(/\\/g, '/');
  const lines = [`--- a/${rel}`, `+++ b/${rel}`];
  for (const h of hunks) {
    lines.push(h.header);
    // Emit as proper unified lines: context/old/new — approximate via line compare
    const max = Math.max(h.oldLines.length, h.newLines.length);
    // Prefer emitting old then new for mismatched regions using LCS-lite per hunk
    let oi = 0;
    let ni = 0;
    while (oi < h.oldLines.length || ni < h.newLines.length) {
      if (oi < h.oldLines.length && ni < h.newLines.length && h.oldLines[oi] === h.newLines[ni]) {
        lines.push(` ${h.oldLines[oi]}`);
        oi += 1;
        ni += 1;
      } else if (
        ni < h.newLines.length &&
        (oi >= h.oldLines.length || !h.oldLines.slice(oi).includes(h.newLines[ni]))
      ) {
        lines.push(`+${h.newLines[ni]}`);
        ni += 1;
      } else if (oi < h.oldLines.length) {
        lines.push(`-${h.oldLines[oi]}`);
        oi += 1;
      } else {
        break;
      }
      if (oi + ni > max * 3) break;
    }
  }
  if (hunks.length === 0) {
    lines.push('@@ -0,0 +0,0 @@');
  }
  return lines.join('\n');
}
