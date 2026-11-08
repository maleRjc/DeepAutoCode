import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { extractCodeOutlineForPath } from './CodeOutline.js';
import { createIgnoreMatcher, IgnoreMatcher } from './IgnoreRules.js';
import { SemanticIndex } from './SemanticIndex.js';

export interface IndexedWorkspaceFile {
  relPath: string;
  absPath: string;
  size: number;
  mtimeMs: number;
  ext: string;
}

export interface WorkspaceFileIndexOptions {
  ttlMs?: number;
  maxFiles?: number;
  maxFileBytes?: number;
  ignoreDirNames?: string[];
  /** Stage W: respect .cursorignore / .deepautocodeignore / .gitignore */
  useIgnoreFiles?: boolean;
}

const DEFAULT_IGNORE = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.deepautocode-data',
  '.venv',
  'venv',
  '__pycache__',
  'CMakeFiles',
  '.next',
  '.turbo',
];

const SOURCE_EXTS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'json',
  'md',
  'py',
  'go',
  'rs',
  'java',
  'c',
  'cc',
  'cpp',
  'cxx',
  'cu',
  'cuh',
  'h',
  'hh',
  'hpp',
  'hxx',
  'cmake',
  'txt',
  'toml',
  'yml',
  'yaml',
  'sh',
  'ps1',
  'css',
  'html',
  'vue',
  'svelte',
]);

/**
 * P1 light-weight workspace path index.
 * Caches relative file paths so search_codebase / explore can skip repeated directory walks.
 */
export class WorkspaceFileIndex {
  private readonly root: string;
  private readonly ttlMs: number;
  private readonly maxFiles: number;
  private readonly maxFileBytes: number;
  private readonly ignoreDirNames: Set<string>;
  private readonly useIgnoreFiles: boolean;
  private ignoreMatcher: IgnoreMatcher | null = null;
  private files: IndexedWorkspaceFile[] = [];
  private builtAt = 0;
  private buildPromise: Promise<void> | null = null;
  private generation = 0;
  private semanticIndex: SemanticIndex | null = null;

  constructor(workspaceRoot: string, options?: WorkspaceFileIndexOptions) {
    this.root = path.resolve(workspaceRoot);
    this.ttlMs = options?.ttlMs ?? 30_000;
    this.maxFiles = options?.maxFiles ?? 12_000;
    this.maxFileBytes = options?.maxFileBytes ?? 768 * 1024;
    this.ignoreDirNames = new Set(options?.ignoreDirNames ?? DEFAULT_IGNORE);
    this.useIgnoreFiles = options?.useIgnoreFiles !== false;
  }

  getSemanticIndex(): SemanticIndex {
    if (!this.semanticIndex) this.semanticIndex = new SemanticIndex(this);
    return this.semanticIndex;
  }

  get size(): number {
    return this.files.length;
  }

  get ageMs(): number {
    return this.builtAt ? Date.now() - this.builtAt : Number.POSITIVE_INFINITY;
  }

  invalidate(): void {
    this.generation += 1;
    this.builtAt = 0;
    this.files = [];
    this.buildPromise = null;
    this.ignoreMatcher = null;
    this.semanticIndex?.invalidate();
  }

  async ensureFresh(force = false): Promise<IndexedWorkspaceFile[]> {
    if (!force && this.builtAt > 0 && this.ageMs < this.ttlMs && this.files.length > 0) {
      return this.files;
    }
    if (this.buildPromise) {
      await this.buildPromise;
      return this.files;
    }

    const gen = this.generation;
    this.buildPromise = this.rebuild(gen);
    try {
      await this.buildPromise;
    } finally {
      this.buildPromise = null;
    }
    return this.files;
  }

  async list(options?: {
    under?: string;
    extensions?: string[];
    includeNonSource?: boolean;
  }): Promise<IndexedWorkspaceFile[]> {
    const all = await this.ensureFresh();
    const under = options?.under
      ? options.under.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
      : '';
    const extFilter =
      options?.extensions && options.extensions.length > 0
        ? new Set(options.extensions.map((e) => e.replace(/^\./, '').toLowerCase()))
        : null;

    return all.filter((f) => {
      if (under) {
        if (!(f.relPath === under || f.relPath.startsWith(`${under}/`))) {
          return false;
        }
      }
      if (extFilter) {
        return extFilter.has(f.ext);
      }
      if (options?.includeNonSource) {
        return true;
      }
      return !f.ext || SOURCE_EXTS.has(f.ext) || f.size <= this.maxFileBytes;
    });
  }

  /**
   * Rank path hits for filename-ish queries before full content scan.
   */
  async findPathMatches(query: string, limit = 40): Promise<IndexedWorkspaceFile[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const all = await this.ensureFresh();
    const scored: Array<{ file: IndexedWorkspaceFile; score: number }> = [];
    for (const file of all) {
      const base = path.posix.basename(file.relPath).toLowerCase();
      const rel = file.relPath.toLowerCase();
      let score = 0;
      if (base === q) score = 100;
      else if (base.startsWith(q)) score = 80;
      else if (base.includes(q)) score = 60;
      else if (rel.includes(q)) score = 40;
      if (score > 0) scored.push({ file, score });
    }
    scored.sort((a, b) => b.score - a.score || a.file.relPath.localeCompare(b.file.relPath));
    return scored.slice(0, limit).map((s) => s.file);
  }

  private async rebuild(generation: number): Promise<void> {
    const collected: IndexedWorkspaceFile[] = [];
    if (this.useIgnoreFiles) {
      try {
        this.ignoreMatcher = await createIgnoreMatcher(this.root);
      } catch {
        this.ignoreMatcher = null;
      }
    }

    const walk = async (dir: string): Promise<void> => {
      if (collected.length >= this.maxFiles) return;
      if (generation !== this.generation) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (collected.length >= this.maxFiles) break;
        if (generation !== this.generation) return;
        const absPath = path.join(dir, entry.name);
        const relPath = path.relative(this.root, absPath).replace(/\\/g, '/');
        if (entry.name.startsWith('.') && entry.name !== '.agents' && entry.name !== '.deepautocode') {
          if (
            entry.name !== '.gitignore' &&
            entry.name !== '.cursorrules' &&
            entry.name !== '.cursorignore' &&
            entry.name !== '.deepautocodeignore'
          ) {
            if (entry.isDirectory()) continue;
          }
        }
        if (this.ignoreDirNames.has(entry.name)) continue;
        if (this.ignoreMatcher?.ignores(relPath, entry.isDirectory())) continue;
        if (entry.isDirectory()) {
          await walk(absPath);
          continue;
        }
        if (!entry.isFile()) continue;
        try {
          const st = await fs.stat(absPath);
          if (st.size > this.maxFileBytes) continue;
          const ext = relPath.includes('.')
            ? relPath.slice(relPath.lastIndexOf('.') + 1).toLowerCase()
            : '';
          if (ext && !SOURCE_EXTS.has(ext) && st.size > 64 * 1024) continue;
          collected.push({
            relPath,
            absPath,
            size: st.size,
            mtimeMs: st.mtimeMs,
            ext,
          });
        } catch {
          // ignore
        }
      }
    };

    await walk(this.root);
    if (generation !== this.generation) return;
    collected.sort((a, b) => a.relPath.localeCompare(b.relPath));
    this.files = collected;
    this.builtAt = Date.now();
    this.semanticIndex?.invalidate();
  }
}

async function tryRipgrepSearch(params: {
  root: string;
  query: string;
  under?: string;
  contextLines: number;
  maxMatches: number;
  regex?: boolean;
  caseSensitive?: boolean;
  glob?: string;
}): Promise<string | null> {
  const args = [
    '--json',
    '--heading',
    '--line-number',
    '--color',
    'never',
    '--hidden',
    '--glob',
    '!node_modules/**',
    '--glob',
    '!.git/**',
    '--glob',
    '!dist/**',
    '--glob',
    '!build/**',
    '--glob',
    '!out/**',
    '--glob',
    '!coverage/**',
    '--max-count',
    String(Math.max(1, params.maxMatches)),
    '-C',
    String(params.contextLines),
  ];
  if (!params.caseSensitive) args.push('-i');
  if (params.glob) {
    args.push('--glob', params.glob);
  }
  if (!params.regex) {
    args.push('-F');
  }
  args.push(params.query);
  if (params.under) {
    args.push('--', params.under);
  } else {
    args.push('--', '.');
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let child;
    try {
      child = spawn('rg', args, {
        cwd: params.root,
        windowsHide: true,
        shell: false,
      });
    } catch {
      finish(null);
      return;
    }

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      finish(null);
    }, 8000);

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 2_000_000) {
        try {
          child.kill();
        } catch {
          // ignore
        }
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // rg exits 1 when no matches; 2 on error
      if (code !== 0 && code !== 1) {
        finish(null);
        return;
      }
      const blocks: string[] = [];
      let currentPath = '';
      const linesOut: string[] = [];
      const flush = () => {
        if (linesOut.length > 0) {
          blocks.push(linesOut.join('\n'));
          linesOut.length = 0;
        }
      };

      for (const rawLine of stdout.split(/\r?\n/)) {
        if (!rawLine.trim()) continue;
        try {
          const msg = JSON.parse(rawLine);
          if (msg.type === 'begin' && msg.data?.path?.text) {
            flush();
            currentPath = String(msg.data.path.text)
              .replace(/\\/g, '/')
              .replace(/^\.\//, '');
          } else if (msg.type === 'match' || msg.type === 'context') {
            const lineNumber = Number(msg.data?.line_number || 0);
            const text = String(msg.data?.lines?.text || '').replace(/\r?\n$/, '');
            const marker = msg.type === 'match' ? '>' : ' ';
            const rel = currentPath || '?';
            linesOut.push(`${marker} ${rel}:${lineNumber}: ${text.slice(0, 200)}`);
            if (blocks.length + (linesOut.length > 0 ? 1 : 0) >= params.maxMatches && msg.type === 'match') {
              flush();
              break;
            }
          } else if (msg.type === 'end') {
            flush();
          }
        } catch {
          // ignore non-json
        }
      }
      flush();
      if (blocks.length === 0 && code === 1) {
        finish('');
        return;
      }
      if (blocks.length === 0 && stderr) {
        finish(null);
        return;
      }
      finish(blocks.length > 0 ? `[search via ripgrep]\n${blocks.join('\n--\n')}` : '');
    });
  });
}

async function outlineFallbackForQuery(params: {
  index: WorkspaceFileIndex;
  query: string;
  under?: string;
}): Promise<string> {
  const pathHits = await params.index.findPathMatches(params.query, 8);
  if (pathHits.length === 0) return '';
  const parts: string[] = ['[No content matches — symbol outline fallback for path hits:]'];
  for (const hit of pathHits.slice(0, 5)) {
    if (
      params.under &&
      !(hit.relPath === params.under || hit.relPath.startsWith(`${params.under}/`))
    ) {
      continue;
    }
    try {
      const content = await fs.readFile(hit.absPath, 'utf-8');
      const outline = extractCodeOutlineForPath(hit.relPath, content, 24).join('\n');
      parts.push(`### ${hit.relPath}\n${outline || '(no symbols)'}`);
    } catch {
      // ignore
    }
  }
  return parts.length > 1 ? parts.join('\n') : '';
}

export interface SearchIndexedFilesOptions {
  root: string;
  index: WorkspaceFileIndex;
  query: string;
  under?: string;
  contextLines?: number;
  maxMatches?: number;
  /** Use regex instead of fixed-string (-F). */
  regex?: boolean;
  caseSensitive?: boolean;
  /** Extra ripgrep --glob, e.g. "*.ts" or "!dist/**" */
  glob?: string;
  /** Prefer symbol/outline hits via CodeOutline; semantic = local TF-IDF hybrid */
  mode?: 'content' | 'symbol' | 'auto' | 'semantic';
}

function matchLine(
  line: string,
  query: string,
  regex: boolean,
  caseSensitive: boolean
): boolean {
  if (regex) {
    try {
      return new RegExp(query, caseSensitive ? '' : 'i').test(line);
    } catch {
      return caseSensitive ? line.includes(query) : line.toLowerCase().includes(query.toLowerCase());
    }
  }
  return caseSensitive ? line.includes(query) : line.toLowerCase().includes(query.toLowerCase());
}

async function searchSymbols(params: {
  index: WorkspaceFileIndex;
  query: string;
  under?: string;
  maxMatches: number;
}): Promise<string> {
  const q = params.query.trim();
  if (!q) return '';
  const files = await params.index.list({ under: params.under, includeNonSource: false });
  const hits: string[] = [];
  const qLower = q.toLowerCase();
  for (const file of files) {
    if (hits.length >= params.maxMatches) break;
    try {
      const content = await fs.readFile(file.absPath, 'utf-8');
      const symbols = extractCodeOutlineForPath(file.relPath, content, 80);
      for (const line of symbols) {
        if (!line.toLowerCase().includes(qLower) && !new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(line)) {
          continue;
        }
        hits.push(`  ${file.relPath}: ${line}`);
        if (hits.length >= params.maxMatches) break;
      }
    } catch {
      // ignore
    }
  }
  return hits.length > 0 ? `[search via symbols]\n${hits.join('\n')}` : '';
}

export async function searchIndexedFiles(params: SearchIndexedFilesOptions): Promise<string> {
  const query = params.query.trim();
  if (!query) return 'Empty search query.';
  const contextLines = Math.max(0, Math.min(10, params.contextLines ?? 3));
  const maxMatches = params.maxMatches ?? 50;
  const under = params.under
    ? params.under.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
    : undefined;
  const regex = Boolean(params.regex);
  const caseSensitive = Boolean(params.caseSensitive);
  const mode = params.mode || 'auto';

  if (mode === 'symbol') {
    const sym = await searchSymbols({ index: params.index, query, under, maxMatches });
    return sym || (await outlineFallbackForQuery({ index: params.index, query, under })) || 'No matches found.';
  }

  if (mode === 'semantic') {
    const sem = await params.index
      .getSemanticIndex()
      .formatSearch(query, { limit: Math.min(20, maxMatches), under });
    if (sem) {
      // Also append a light content pass for the top query token
      const content = await searchIndexedFiles({
        ...params,
        mode: 'content',
        maxMatches: Math.min(12, maxMatches),
      });
      if (content && content !== 'No matches found.') {
        return `${sem}\n--\n${content}`;
      }
      return sem;
    }
    return (await outlineFallbackForQuery({ index: params.index, query, under })) || 'No matches found.';
  }

  if (mode === 'auto' && query.split(/\s+/).length >= 2) {
    // Multi-word natural language → semantic hybrid first
    const sem = await params.index
      .getSemanticIndex()
      .formatSearch(query, { limit: Math.min(10, maxMatches), under });
    const content = await searchIndexedFiles({
      ...params,
      mode: 'content',
    });
    if (sem && content && content !== 'No matches found.') {
      return `${sem}\n--\n${content}`;
    }
    if (sem) return sem;
    return content;
  }

  if (mode === 'auto' && /^[A-Za-z_][\w]*$/.test(query) && query.length >= 3) {
    const sym = await searchSymbols({
      index: params.index,
      query,
      under,
      maxMatches: Math.min(20, maxMatches),
    });
    // Continue with content search; prepend symbol hits when present
    const content = await searchIndexedFiles({
      ...params,
      mode: 'content',
    });
    if (sym && content && content !== 'No matches found.') {
      return `${sym}\n--\n${content}`;
    }
    if (sym) return sym;
    return content;
  }

  const rg = await tryRipgrepSearch({
    root: params.root,
    query,
    under,
    contextLines,
    maxMatches,
    regex,
    caseSensitive,
    glob: params.glob,
  });
  if (rg != null) {
    if (rg) return rg;
    const outline = await outlineFallbackForQuery({ index: params.index, query, under });
    return outline || 'No matches found.';
  }

  const files = await params.index.list({ under, includeNonSource: false });
  const results: string[] = [];
  const globRe = params.glob
    ? (() => {
        try {
          // crude glob → regex: *.ts → .*\.ts$
          const g = params.glob!.replace(/\\/g, '/');
          if (g.startsWith('!')) return null;
          const escaped = g
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*\*/g, '.*')
            .replace(/\*/g, '[^/]*');
          return new RegExp(`^${escaped}$`, 'i');
        } catch {
          return null;
        }
      })()
    : null;

  // Fast path: filename/path matches first for identifier-like queries
  if (!regex && /^[\w./\\-]+$/.test(query) && query.length >= 3) {
    const pathHits = await params.index.findPathMatches(query, 12);
    for (const hit of pathHits) {
      if (under && !(hit.relPath === under || hit.relPath.startsWith(`${under}/`))) continue;
      if (globRe && !globRe.test(hit.relPath)) continue;
      results.push(`  ${hit.relPath}:1: [path match]`);
      if (results.length >= 8) break;
    }
  }

  for (const file of files) {
    if (results.length >= maxMatches) break;
    if (globRe && !globRe.test(file.relPath)) continue;
    try {
      const content = await fs.readFile(file.absPath, 'utf-8');
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!matchLine(lines[i], query, regex, caseSensitive)) continue;
        const startCtx = Math.max(0, i - contextLines);
        const endCtx = Math.min(lines.length - 1, i + contextLines);
        const snippet: string[] = [];
        for (let k = startCtx; k <= endCtx; k++) {
          const marker = k === i ? '>' : ' ';
          snippet.push(`${marker} ${file.relPath}:${k + 1}: ${lines[k].slice(0, 200)}`);
        }
        results.push(snippet.join('\n'));
        i = endCtx;
        if (results.length >= maxMatches) break;
      }
    } catch {
      // binary / unreadable
    }
  }

  if (results.length > 0) {
    return `[search via index]\n${results.join('\n--\n')}`;
  }
  const outline = await outlineFallbackForQuery({ index: params.index, query, under });
  return outline || 'No matches found.';
}
