/**
 * FileStateCache — Ported & adapted from Claude Code (`src/utils/fileStateCache.ts` & `src/utils/fileHistory.ts`)
 *
 * Responsibilities:
 * 1. Normalizes workspace-relative paths across Windows (`\`) and POSIX (`/`) so cache keys never miss.
 * 2. Tracks read file states (`content`, `timestamp`, `startLine`, `endLine`, `totalLines`, `isPartialView`)
 *    within a size-bounded LRU cache (default 25MB, 100 entries).
 * 3. Captures pre-edit file history snapshots (`makeSnapshot`) before any `edit_file` / `write_file` mutation,
 *    enabling instant single-step or full-file rollback.
 * 4. Provides `diagnoseEditMismatch` so when `oldText` fails to match, the agent immediately receives
 *    the closest matching line-numbered snippet from the file without wasting an extra `read_file` turn.
 */

export interface FileStateEntry {
  filePath: string;
  content: string;
  timestamp: number;
  startLine?: number;
  endLine?: number;
  totalLines: number;
  isPartialView: boolean;
}

export interface FileHistorySnapshot {
  snapshotId: string;
  filePath: string;
  content: string;
  timestamp: number;
}

const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024; // 25MB
const MAX_SNAPSHOTS_PER_FILE = 10;

export function normalizeCacheFilePath(rawPath: string): string {
  return String(rawPath || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/');
}

export class FileStateCache {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private currentBytes = 0;
  private readonly entries = new Map<string, FileStateEntry>();
  private readonly snapshots = new Map<string, FileHistorySnapshot[]>();

  constructor(maxEntries = DEFAULT_MAX_ENTRIES, maxBytes = DEFAULT_MAX_BYTES) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
  }

  public recordRead(params: {
    filePath: string;
    content: string;
    startLine?: number;
    endLine?: number;
    isPartialView?: boolean;
  }): FileStateEntry {
    const key = normalizeCacheFilePath(params.filePath);
    const totalLines = params.content.split(/\r?\n/).length;
    const isPartialView = Boolean(
      params.isPartialView ??
        ((params.startLine && params.startLine > 1) ||
          (params.endLine && params.endLine < totalLines))
    );

    const entry: FileStateEntry = {
      filePath: key,
      content: params.content,
      timestamp: Date.now(),
      startLine: params.startLine,
      endLine: params.endLine,
      totalLines,
      isPartialView,
    };

    this.setInternal(key, entry);
    return entry;
  }

  public get(filePath: string): FileStateEntry | undefined {
    const key = normalizeCacheFilePath(filePath);
    const existing = this.entries.get(key);
    if (!existing) return undefined;
    // Refresh LRU order
    this.entries.delete(key);
    this.entries.set(key, existing);
    return existing;
  }

  public hasRead(filePath: string): boolean {
    return this.entries.has(normalizeCacheFilePath(filePath));
  }

  public makeSnapshot(filePath: string, currentContent: string): FileHistorySnapshot {
    const key = normalizeCacheFilePath(filePath);
    const list = this.snapshots.get(key) ?? [];
    const snapshot: FileHistorySnapshot = {
      snapshotId: `snap_${Date.now()}_${list.length + 1}`,
      filePath: key,
      content: currentContent,
      timestamp: Date.now(),
    };
    list.push(snapshot);
    if (list.length > MAX_SNAPSHOTS_PER_FILE) {
      list.shift();
    }
    this.snapshots.set(key, list);

    // Keep the read cache synchronized with the latest known full content
    this.recordRead({
      filePath: key,
      content: currentContent,
      isPartialView: false,
    });

    return snapshot;
  }

  public getLatestSnapshot(filePath: string): FileHistorySnapshot | undefined {
    const list = this.snapshots.get(normalizeCacheFilePath(filePath));
    return list && list.length > 0 ? list[list.length - 1] : undefined;
  }

  public getSnapshots(filePath: string): FileHistorySnapshot[] {
    return [...(this.snapshots.get(normalizeCacheFilePath(filePath)) ?? [])];
  }

  /**
   * When an edit's `oldText` does not match `currentContent`, locates the closest anchor line
   * in `currentContent` and returns a 25-line numbered window around it so the model can
   * immediately fix its `edit_file` call in the next turn without calling `read_file` first.
   */
  public diagnoseEditMismatch(
    filePath: string,
    currentContent: string,
    oldText: string
  ): {
    wasReadPreviously: boolean;
    hintMessage: string;
  } {
    const key = normalizeCacheFilePath(filePath);
    const wasReadPreviously = this.entries.has(key);
    const allLines = currentContent.split(/\r?\n/);
    const candidateLines = oldText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length >= 6 && !/^[{}();]+$/.test(l));

    let bestLineIdx = -1;
    for (const anchor of candidateLines) {
      const idx = allLines.findIndex((line) => line.includes(anchor));
      if (idx !== -1) {
        bestLineIdx = idx;
        break;
      }
    }

    if (bestLineIdx === -1 && candidateLines.length > 0) {
      const prefix = candidateLines[0].slice(0, Math.min(24, candidateLines[0].length));
      bestLineIdx = allLines.findIndex((line) => line.includes(prefix));
    }

    let windowSnippet = '';
    if (bestLineIdx !== -1) {
      const s = Math.max(1, bestLineIdx - 8);
      const e = Math.min(allLines.length, bestLineIdx + 22);
      windowSnippet =
        `\n[Closest matching lines in '${key}' (lines ${s}-${e} of ${allLines.length}) — copy exact lines from below for oldText]:\n` +
        allLines
          .slice(s - 1, e)
          .map((l, idx) => `${s + idx}: ${l}`)
          .join('\n');
    }

    const readNotice = wasReadPreviously
      ? ''
      : `[FILE_STATE_NOTICE: '${key}' was modified without a prior full read in this turn.] `;

    return {
      wasReadPreviously,
      hintMessage: `${readNotice}oldText did not match '${key}'.${windowSnippet}`,
    };
  }

  public clear(): void {
    this.entries.clear();
    this.currentBytes = 0;
  }

  public get size(): number {
    return this.entries.size;
  }

  public get calculatedSizeBytes(): number {
    return this.currentBytes;
  }

  private setInternal(key: string, entry: FileStateEntry): void {
    const entryBytes = Math.max(1, Buffer.byteLength(entry.content, 'utf-8'));
    if (entryBytes > this.maxBytes) {
      return;
    }

    const prev = this.entries.get(key);
    if (prev) {
      this.currentBytes -= Math.max(1, Buffer.byteLength(prev.content, 'utf-8'));
      this.entries.delete(key);
    }

    while (
      this.entries.size > 0 &&
      (this.entries.size >= this.maxEntries || this.currentBytes + entryBytes > this.maxBytes)
    ) {
      const oldestKey = this.entries.keys().next().value;
      if (!oldestKey) break;
      const oldest = this.entries.get(oldestKey);
      if (oldest) {
        this.currentBytes -= Math.max(1, Buffer.byteLength(oldest.content, 'utf-8'));
      }
      this.entries.delete(oldestKey);
    }

    this.entries.set(key, entry);
    this.currentBytes += entryBytes;
  }
}

