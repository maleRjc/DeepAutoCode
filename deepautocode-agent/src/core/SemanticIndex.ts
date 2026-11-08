/**
 * Stage W: local hybrid "semantic" retrieval without cloud embeddings.
 * Tokenizes camelCase / snake_case / path segments and ranks via TF-IDF + outline boost.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { extractCodeOutlineForPath } from './CodeOutline.js';
import type { IndexedWorkspaceFile, WorkspaceFileIndex } from './WorkspaceFileIndex.js';

export interface SemanticHit {
  relPath: string;
  score: number;
  reasons: string[];
  preview?: string;
}

const STOP = new Set([
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'from',
  'into',
  'return',
  'const',
  'let',
  'var',
  'function',
  'class',
  'export',
  'import',
  'default',
  'type',
  'interface',
  'async',
  'await',
  'true',
  'false',
  'null',
  'undefined',
  'void',
  'string',
  'number',
  'boolean',
  'object',
]);

/** Split identifiers like getUserName / get_user_name / path/segments into tokens. */
export function tokenizeSemantic(text: string): string[] {
  const raw = String(text || '');
  const parts = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-./\\:]+/g, ' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOP.has(t) && !/^\d+$/.test(t));
  return parts;
}

interface DocEntry {
  file: IndexedWorkspaceFile;
  tf: Map<string, number>;
  tokens: number;
  outlineBoost: Map<string, number>;
  preview: string;
}

export class SemanticIndex {
  private docs: DocEntry[] = [];
  private df = new Map<string, number>();
  private builtAt = 0;
  private buildPromise: Promise<void> | null = null;
  private readonly maxDocs: number;
  private readonly maxFileBytes: number;

  constructor(
    private readonly fileIndex: WorkspaceFileIndex,
    options?: { maxDocs?: number; maxFileBytes?: number }
  ) {
    this.maxDocs = options?.maxDocs ?? 4000;
    this.maxFileBytes = options?.maxFileBytes ?? 96 * 1024;
  }

  get size(): number {
    return this.docs.length;
  }

  invalidate(): void {
    this.docs = [];
    this.df.clear();
    this.builtAt = 0;
    this.buildPromise = null;
  }

  async ensureFresh(force = false): Promise<void> {
    if (!force && this.builtAt > 0 && this.docs.length > 0) {
      // Rebuild if underlying file index is newer / empty was invalidated
      if (this.fileIndex.ageMs < 60_000 && this.fileIndex.size > 0) return;
    }
    if (this.buildPromise) {
      await this.buildPromise;
      return;
    }
    this.buildPromise = this.rebuild();
    try {
      await this.buildPromise;
    } finally {
      this.buildPromise = null;
    }
  }

  private async rebuild(): Promise<void> {
    const files = await this.fileIndex.ensureFresh();
    const docs: DocEntry[] = [];
    const df = new Map<string, number>();

    for (const file of files) {
      if (docs.length >= this.maxDocs) break;
      if (file.size > this.maxFileBytes) continue;
      if (!file.ext || !/^(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|c|cc|cpp|h|hpp|md)$/i.test(file.ext)) {
        continue;
      }
      try {
        const content = await fs.readFile(file.absPath, 'utf-8');
        const head = content.slice(0, this.maxFileBytes);
        const tokens = tokenizeSemantic(`${file.relPath}\n${head}`);
        const tf = new Map<string, number>();
        for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);

        const outlineBoost = new Map<string, number>();
        const symbols = extractCodeOutlineForPath(file.relPath, head, 40);
        for (const line of symbols) {
          for (const t of tokenizeSemantic(line)) {
            outlineBoost.set(t, (outlineBoost.get(t) || 0) + 3);
          }
        }
        // Path basename tokens get a boost
        for (const t of tokenizeSemantic(path.posix.basename(file.relPath))) {
          outlineBoost.set(t, (outlineBoost.get(t) || 0) + 5);
        }

        const seen = new Set(tf.keys());
        for (const t of seen) df.set(t, (df.get(t) || 0) + 1);

        docs.push({
          file,
          tf,
          tokens: tokens.length || 1,
          outlineBoost,
          preview: head
            .split(/\r?\n/)
            .slice(0, 4)
            .join(' ')
            .slice(0, 180),
        });
      } catch {
        // skip
      }
    }

    this.docs = docs;
    this.df = df;
    this.builtAt = Date.now();
  }

  async search(query: string, options?: { limit?: number; under?: string }): Promise<SemanticHit[]> {
    await this.ensureFresh();
    const qTokens = [...new Set(tokenizeSemantic(query))];
    if (qTokens.length === 0) return [];
    const limit = options?.limit ?? 12;
    const under = options?.under
      ? options.under.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
      : '';
    const N = Math.max(1, this.docs.length);
    const hits: SemanticHit[] = [];

    for (const doc of this.docs) {
      if (under && !(doc.file.relPath === under || doc.file.relPath.startsWith(`${under}/`))) {
        continue;
      }
      let score = 0;
      const reasons: string[] = [];
      for (const t of qTokens) {
        const tf = doc.tf.get(t) || 0;
        const boost = doc.outlineBoost.get(t) || 0;
        if (tf === 0 && boost === 0) continue;
        const df = this.df.get(t) || 1;
        const idf = Math.log(1 + N / df);
        const tfNorm = tf / doc.tokens;
        const termScore = (tfNorm * 8 + Math.min(tf, 6) * 0.4 + boost) * idf;
        score += termScore;
        if (boost > 0) reasons.push(`symbol:${t}`);
        else reasons.push(`term:${t}`);
      }
      if (score <= 0) continue;
      // Prefer shorter path / source roots lightly
      if (doc.file.relPath.startsWith('src/')) score *= 1.08;
      hits.push({
        relPath: doc.file.relPath,
        score,
        reasons: [...new Set(reasons)].slice(0, 6),
        preview: doc.preview,
      });
    }

    hits.sort((a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath));
    return hits.slice(0, limit);
  }

  async formatSearch(query: string, options?: { limit?: number; under?: string }): Promise<string> {
    const hits = await this.search(query, options);
    if (hits.length === 0) return '';
    const lines = hits.map(
      (h, i) =>
        `${i + 1}. ${h.relPath}  (score=${h.score.toFixed(2)}; ${h.reasons.join(', ')})\n   ${h.preview || ''}`
    );
    return `[search via semantic/tf-idf]\n${lines.join('\n')}`;
  }
}
