/**
 * Unified-diff apply for Agent edits.
 * Supports *** Begin Patch / *** Update|Add|Delete File and classic ---/+++ @@ hunks.
 * Matching prefers anchored line windows, then first exact/trim-tolerant block (never global replace-all).
 */
import { FileStateCache } from './FileStateCache.js';

export interface PatchHunk {
  oldStart: number;
  oldLines: string[];
  newLines: string[];
  header: string;
}

export type PatchFileOp = 'update' | 'add' | 'delete';

export interface ParsedPatchFile {
  filePath: string;
  hunks: PatchHunk[];
  op: PatchFileOp;
}

export interface ApplyPatchResult {
  ok: boolean;
  filePath: string;
  content?: string;
  deleted?: boolean;
  created?: boolean;
  hunksApplied: number;
  error?: string;
  hint?: string;
}

export interface MultiFilePatchApplyItem {
  filePath: string;
  beforeContent: string | null;
  afterContent: string | null;
  deleted: boolean;
  created: boolean;
  hunksApplied: number;
}

export interface MultiFilePatchResult {
  ok: boolean;
  files: MultiFilePatchApplyItem[];
  error?: string;
  hint?: string;
  /** Snapshots to restore if a later write fails (path → prior content or null if did not exist). */
  rollbackSnapshots: Array<{ filePath: string; content: string | null }>;
}

const BEGIN = /^\*\*\*\s*Begin Patch\s*$/i;
const END = /^\*\*\*\s*End Patch\s*$/i;
const UPDATE = /^\*\*\*\s*Update\s+File:\s*(.+)\s*$/i;
const ADD = /^\*\*\*\s*Add\s+File:\s*(.+)\s*$/i;
const DELETE = /^\*\*\*\s*Delete\s+File:\s*(.+)\s*$/i;
const CLASSIC_MINUS = /^---\s+(?:a\/)?(.+?)(?:\s+|$)/;
const CLASSIC_PLUS = /^\+\+\+\s+(?:b\/)?(.+?)(?:\s+|$)/;
const HUNK = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

function normalizeRel(p: string): string {
  return String(p || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^a\//, '')
    .replace(/^b\//, '')
    .replace(/^\/dev\/null$/i, '');
}

function ensureFile(
  files: ParsedPatchFile[],
  filePath: string,
  op: PatchFileOp = 'update'
): ParsedPatchFile {
  const rel = normalizeRel(filePath);
  let found = files.find((f) => f.filePath === rel);
  if (!found) {
    found = { filePath: rel, hunks: [], op };
    files.push(found);
  } else if (op !== 'update') {
    found.op = op;
  }
  return found;
}

export function stripHeredocAndFences(raw: string): string {
  let text = String(raw || '').trim();
  const heredocMatch = text.match(/^(?:cat\s+<<\s*['"]?([A-Za-z0-9_]+)['"]?.*?\n)([\s\S]*?)(?:\n\1\s*$)/i);
  if (heredocMatch) {
    text = heredocMatch[2].trim();
  }
  if (text.startsWith('```')) {
    text = text.replace(/^```[a-zA-Z0-9_-]*\r?\n/, '').replace(/\r?\n```\s*$/, '').trim();
  }
  return text;
}

/**
 * Parse a unified diff / Cursor-like patch into per-file hunks.
 */
export function parseUnifiedPatch(patchText: string): ParsedPatchFile[] {
  const cleaned = stripHeredocAndFences(patchText);
  const lines = cleaned.replace(/\r\n/g, '\n').split('\n');
  const files: ParsedPatchFile[] = [];
  let current: ParsedPatchFile | null = null;
  let i = 0;
  let inPatch = false;

  while (i < lines.length) {
    const line = lines[i];
    if (BEGIN.test(line)) {
      inPatch = true;
      i += 1;
      continue;
    }
    if (END.test(line)) {
      inPatch = false;
      i += 1;
      continue;
    }
    const add = ADD.exec(line);
    if (add) {
      current = ensureFile(files, add[1], 'add');
      i += 1;
      continue;
    }
    const del = DELETE.exec(line);
    if (del) {
      current = ensureFile(files, del[1], 'delete');
      i += 1;
      continue;
    }
    const upd = UPDATE.exec(line);
    if (upd) {
      current = ensureFile(files, upd[1], 'update');
      i += 1;
      continue;
    }
    const minus = CLASSIC_MINUS.exec(line);
    if (minus && i + 1 < lines.length && CLASSIC_PLUS.test(lines[i + 1])) {
      const plus = CLASSIC_PLUS.exec(lines[i + 1])!;
      const minusPath = normalizeRel(minus[1]);
      const plusPath = normalizeRel(plus[1]);
      if (!plusPath || plusPath === 'dev/null') {
        current = ensureFile(files, minusPath, 'delete');
      } else if (!minusPath || minusPath === 'dev/null') {
        current = ensureFile(files, plusPath, 'add');
      } else {
        current = ensureFile(files, plusPath || minusPath, 'update');
      }
      i += 2;
      continue;
    }
    const hunkMatch = HUNK.exec(line);
    if (hunkMatch && current) {
      const targetFile: ParsedPatchFile = current;
      const oldStart = Number(hunkMatch[1]) || 1;
      const oldLines: string[] = [];
      const newLines: string[] = [];
      i += 1;
      while (i < lines.length) {
        const l = lines[i];
        if (
          HUNK.test(l) ||
          BEGIN.test(l) ||
          END.test(l) ||
          UPDATE.test(l) ||
          ADD.test(l) ||
          DELETE.test(l) ||
          CLASSIC_MINUS.test(l) ||
          CLASSIC_PLUS.test(l)
        ) {
          break;
        }
        if (l.startsWith('+')) {
          newLines.push(l.slice(1));
        } else if (l.startsWith('-')) {
          oldLines.push(l.slice(1));
        } else if (l.startsWith(' ') || l === '') {
          const body = l.startsWith(' ') ? l.slice(1) : l;
          oldLines.push(body);
          newLines.push(body);
        } else if (l.startsWith('\\')) {
          // "\ No newline at end of file"
        } else if (inPatch || targetFile) {
          oldLines.push(l);
          newLines.push(l);
        } else {
          break;
        }
        i += 1;
      }
      targetFile.hunks.push({
        oldStart,
        oldLines,
        newLines,
        header: hunkMatch[0],
      });
      continue;
    }
    i += 1;
  }

  return files.filter(
    (f) => f.filePath && (f.hunks.length > 0 || f.op === 'add' || f.op === 'delete')
  );
}

function linesEqualTrimEnd(a: string[], b: string[], start: number): boolean {
  if (start < 0 || start + b.length > a.length) return false;
  for (let j = 0; j < b.length; j++) {
    if (a[start + j].trimEnd() !== b[j].trimEnd()) return false;
  }
  return true;
}

export type MatchMode = 'exact' | 'rstrip' | 'trim' | 'normalized';

function findFirstBlockIndex(
  fileLines: string[],
  oldLines: string[],
  preferStart: number,
  mode: MatchMode
): number {
  if (oldLines.length === 0) return -1;
  const eq = (i: number) => {
    if (i < 0 || i + oldLines.length > fileLines.length) return false;
    for (let j = 0; j < oldLines.length; j++) {
      const a = fileLines[i + j];
      const b = oldLines[j];
      if (mode === 'exact') {
        if (a !== b) return false;
      } else if (mode === 'rstrip') {
        if (a.trimEnd() !== b.trimEnd()) return false;
      } else if (mode === 'trim') {
        if (a.trim() !== b.trim()) return false;
      } else if (mode === 'normalized') {
        if (a.replace(/\s+/g, ' ').trim() !== b.replace(/\s+/g, ' ').trim()) return false;
      }
    }
    return true;
  };
  if (eq(preferStart)) return preferStart;
  // Search outward from preferStart first (anchored), then full scan first hit only
  const maxStart = fileLines.length - oldLines.length;
  for (let dist = 1; dist <= Math.max(preferStart, maxStart - preferStart); dist++) {
    const left = preferStart - dist;
    const right = preferStart + dist;
    if (left >= 0 && eq(left)) return left;
    if (right <= maxStart && eq(right)) return right;
  }
  for (let i = 0; i <= maxStart; i++) {
    if (eq(i)) return i;
  }
  return -1;
}

function applyHunkToContent(
  content: string,
  hunk: PatchHunk
): { ok: true; content: string } | { ok: false; error: string } {
  const hasCrLf = content.includes('\r\n');
  const norm = content.replace(/\r\n/g, '\n');
  const fileLines = norm.split('\n');
  // Preserve trailing empty from split of files ending with \n
  const startIdx = Math.max(0, hunk.oldStart - 1);

  // Pure additions (empty old) at oldStart
  if (hunk.oldLines.length === 0) {
    const idx = Math.min(fileLines.length, startIdx);
    const next = [
      ...fileLines.slice(0, idx),
      ...hunk.newLines,
      ...fileLines.slice(idx),
    ].join('\n');
    return { ok: true, content: hasCrLf ? next.replace(/\n/g, '\r\n') : next };
  }

  // 1. Exact match near declared oldStart, then first exact elsewhere (never replace-all)
  let matchAt = findFirstBlockIndex(fileLines, hunk.oldLines, startIdx, 'exact');
  let matchMode: MatchMode = 'exact';
  if (matchAt < 0) {
    // 2. Trailing-whitespace tolerant
    matchAt = findFirstBlockIndex(fileLines, hunk.oldLines, startIdx, 'rstrip');
    matchMode = 'rstrip';
  }
  if (matchAt < 0) {
    // 3. Trim-tolerant (leading & trailing indentation difference)
    matchAt = findFirstBlockIndex(fileLines, hunk.oldLines, startIdx, 'trim');
    matchMode = 'trim';
  }
  if (matchAt < 0) {
    // 4. Normalized whitespace match
    matchAt = findFirstBlockIndex(fileLines, hunk.oldLines, startIdx, 'normalized');
    matchMode = 'normalized';
  }
  if (matchAt < 0) {
    return {
      ok: false,
      error: `HUNK_NOT_FOUND near line ${hunk.oldStart}: ${hunk.header}`,
    };
  }

  // Indentation adaptation if matched via trim or normalized
  let finalNewLines = hunk.newLines;
  if ((matchMode === 'trim' || matchMode === 'normalized') && hunk.oldLines.length > 0) {
    const actualFirstLine = fileLines[matchAt];
    const patternFirstLine = hunk.oldLines[0];
    const actualIndent = actualFirstLine.match(/^\s*/)?.[0] ?? '';
    const patternIndent = patternFirstLine.match(/^\s*/)?.[0] ?? '';
    if (actualIndent !== patternIndent) {
      const delta = actualIndent.length - patternIndent.length;
      finalNewLines = hunk.newLines.map((line) => {
        if (!line.trim()) return line;
        if (delta > 0) {
          return ' '.repeat(delta) + line;
        } else if (delta < 0) {
          const cut = Math.min(-delta, (line.match(/^\s*/)?.[0] ?? '').length);
          return line.slice(cut);
        }
        return line;
      });
    }
  }

  const next = [
    ...fileLines.slice(0, matchAt),
    ...finalNewLines,
    ...fileLines.slice(matchAt + hunk.oldLines.length),
  ].join('\n');
  return { ok: true, content: hasCrLf ? next.replace(/\n/g, '\r\n') : next };
}

/**
 * Apply all hunks for one file onto currentContent.
 */
export function applyPatchToContent(
  filePath: string,
  currentContent: string,
  patchText: string
): ApplyPatchResult {
  const parsed = parseUnifiedPatch(patchText);
  const target =
    parsed.find((f) => f.filePath === normalizeRel(filePath)) ||
    (parsed.length === 1 ? parsed[0] : null);
  if (!target) {
    return {
      ok: false,
      filePath: normalizeRel(filePath),
      hunksApplied: 0,
      error:
        parsed.length === 0
          ? 'PATCH_PARSE_EMPTY: No file hunks found. Use unified diff with @@ headers or *** Update File: path.'
          : `PATCH_FILE_MISMATCH: patch targets [${parsed.map((p) => p.filePath).join(', ')}] but filePath=${normalizeRel(filePath)}`,
    };
  }

  if (target.op === 'delete') {
    return {
      ok: true,
      filePath: target.filePath,
      deleted: true,
      content: '',
      hunksApplied: Math.max(1, target.hunks.length),
    };
  }

  if (target.op === 'add' && target.hunks.length === 0) {
    return {
      ok: false,
      filePath: target.filePath,
      hunksApplied: 0,
      error: 'PATCH_ADD_EMPTY: Add File requires at least one hunk with + lines.',
    };
  }

  let content = target.op === 'add' && !currentContent ? '' : currentContent;
  let applied = 0;
  for (const hunk of target.hunks) {
    const res = applyHunkToContent(content, hunk);
    if (!res.ok) {
      const cache = new FileStateCache();
      const hint = cache.diagnoseEditMismatch(
        target.filePath,
        content,
        hunk.oldLines.join('\n')
      );
      return {
        ok: false,
        filePath: target.filePath,
        hunksApplied: applied,
        error: res.error,
        hint: hint.hintMessage,
      };
    }
    content = res.content;
    applied += 1;
  }

  return {
    ok: true,
    filePath: target.filePath,
    content,
    created: target.op === 'add',
    hunksApplied: applied,
  };
}

/**
 * Apply a multi-file patch in memory. On first failure, returns ok:false with
 * partial `files` already computed and `rollbackSnapshots` for any successful prior files.
 */
export function applyMultiFilePatch(
  patchText: string,
  readContent: (filePath: string) => string | null
): MultiFilePatchResult {
  const parsed = parseUnifiedPatch(patchText);
  if (parsed.length === 0) {
    return {
      ok: false,
      files: [],
      error:
        'PATCH_PARSE_EMPTY: No file hunks found. Use unified diff with @@ headers or *** Update/Add/Delete File.',
      rollbackSnapshots: [],
    };
  }

  const files: MultiFilePatchApplyItem[] = [];
  const rollbackSnapshots: Array<{ filePath: string; content: string | null }> = [];

  for (const target of parsed.slice(0, 8)) {
    const before = readContent(target.filePath);
    if (target.op === 'delete') {
      files.push({
        filePath: target.filePath,
        beforeContent: before,
        afterContent: null,
        deleted: true,
        created: false,
        hunksApplied: Math.max(1, target.hunks.length),
      });
      rollbackSnapshots.push({ filePath: target.filePath, content: before });
      continue;
    }

    const current = before ?? '';
    if (target.op === 'update' && before == null) {
      return {
        ok: false,
        files,
        error: `PATCH_FILE_MISSING: ${target.filePath} does not exist (use *** Add File for new files).`,
        rollbackSnapshots,
      };
    }

    const single = applyPatchToContent(
      target.filePath,
      current,
      // Re-scope: build a mini patch for this file only via applyPatchToContent full text
      // is OK because applyPatchToContent matches by path.
      patchText
    );
    if (!single.ok || single.content == null) {
      return {
        ok: false,
        files,
        error: single.error || `Failed applying patch to ${target.filePath}`,
        hint: single.hint,
        rollbackSnapshots,
      };
    }

    files.push({
      filePath: target.filePath,
      beforeContent: before,
      afterContent: single.content,
      deleted: false,
      created: target.op === 'add' || before == null,
      hunksApplied: single.hunksApplied,
    });
    rollbackSnapshots.push({ filePath: target.filePath, content: before });
  }

  return { ok: true, files, rollbackSnapshots };
}

export function listPatchFiles(patchText: string): string[] {
  return parseUnifiedPatch(patchText).map((f) => f.filePath);
}

/** @internal exported for tests */
export const __applyPatchTestUtils = {
  findFirstBlockIndex,
  linesEqualTrimEnd,
  normalizeRel,
};
