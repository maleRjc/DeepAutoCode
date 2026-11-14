/**
 * Code Mode Execution Engine
 * Inspired by OpenCode's packages/codemode.
 * Allows LLMs to write and execute sandboxed JavaScript programs to batch-process
 * file discovery, symbol filtering, and code reads in a single round-trip,
 * eliminating dozens of repetitive tool call round-trips.
 */

import vm from 'node:vm';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceFileIndex } from './WorkspaceFileIndex.js';
import { extractCodeOutlineForPath } from './CodeOutline.js';

export interface CodeModeOptions {
  cwd: string;
  timeoutMs?: number;
  maxOutputChars?: number;
  extraBindings?: Record<string, unknown>;
}

export interface CodeModeResult {
  ok: boolean;
  value?: unknown;
  logs: string[];
  durationMs: number;
  error?: string;
}

export interface CodeModeGrepMatch {
  file: string;
  line: number;
  text: string;
}

export interface CodeModeWorkspaceApi {
  cwd: string;
  glob: (
    pattern: string,
    options?: { ignore?: string[]; maxResults?: number }
  ) => Promise<string[]>;
  readFile: (
    filePath: string,
    options?: { maxLines?: number; startLine?: number; endLine?: number }
  ) => Promise<string>;
  grep: (
    pattern: string | RegExp,
    options?: {
      files?: string[];
      filePattern?: string;
      maxMatches?: number;
    }
  ) => Promise<CodeModeGrepMatch[]>;
  outline: (filePath: string) => Promise<string[]>;
  exists: (filePath: string) => Promise<boolean>;
  stat: (filePath: string) => Promise<{ isDirectory: boolean; isFile: boolean; size: number }>;
  extractLinesContaining: (content: string, substringOrRegex: string | RegExp) => Array<{ line: number; text: string }>;
  log: (...args: unknown[]) => void;
}

function globToRegExp(pattern: string): RegExp {
  const norm = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  let regexStr = '^';
  let i = 0;
  while (i < norm.length) {
    const c = norm[i];
    if (c === '*' && norm[i + 1] === '*') {
      if (norm[i + 2] === '/') {
        regexStr += '(?:.+/)?';
        i += 3;
      } else {
        regexStr += '.*';
        i += 2;
      }
    } else if (c === '*') {
      regexStr += '[^/]*';
      i += 1;
    } else if (c === '?') {
      regexStr += '[^/]';
      i += 1;
    } else if (['.', '+', '^', '$', '(', ')', '[', ']', '{', '}', '|'].includes(c)) {
      regexStr += '\\' + c;
      i += 1;
    } else {
      regexStr += c;
      i += 1;
    }
  }
  regexStr += '$';
  return new RegExp(regexStr, 'i');
}

function matchSimpleGlob(relPath: string, pattern: string): boolean {
  const normPath = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  const normPat = pattern.replace(/\\/g, '/').replace(/^\.\//, '');

  if (normPat === '*' || normPat === '**/*') return true;

  try {
    return globToRegExp(normPat).test(normPath);
  } catch {
    return normPath.includes(normPat.replace(/\*/g, ''));
  }
}

export class CodeModeEngine {
  private fileIndex: WorkspaceFileIndex;

  constructor(private readonly cwd: string) {
    this.fileIndex = new WorkspaceFileIndex(cwd);
  }

  /**
   * Execute JavaScript source code in a sandboxed Node VM context.
   */
  public async execute(code: string, options: Partial<CodeModeOptions> = {}): Promise<CodeModeResult> {
    const startMs = Date.now();
    const timeoutMs = Math.max(500, Math.min(60_000, options.timeoutMs ?? 15_000));
    const maxOutputChars = options.maxOutputChars ?? 65_536;
    const logs: string[] = [];

    const safeLog = (...args: unknown[]) => {
      const line = args
        .map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a)))
        .join(' ');
      if (logs.length < 500) {
        logs.push(line);
      }
    };

    const dacApi: CodeModeWorkspaceApi = {
      cwd: this.cwd,
      log: safeLog,

      glob: async (pattern: string, opts = {}) => {
        const files = await this.fileIndex.ensureFresh();
        const maxResults = opts.maxResults ?? 500;
        const ignoreList = opts.ignore ?? ['node_modules/**', 'dist/**', '.git/**'];

        const matched: string[] = [];
        for (const file of files) {
          const rel = file.relPath.replace(/\\/g, '/');
          const isIgnored = ignoreList.some((ign) => matchSimpleGlob(rel, ign));
          if (!isIgnored && matchSimpleGlob(rel, pattern)) {
            matched.push(rel);
            if (matched.length >= maxResults) break;
          }
        }
        return matched;
      },

      readFile: async (filePath: string, opts = {}) => {
        const full = path.isAbsolute(filePath) ? filePath : path.resolve(this.cwd, filePath);
        const text = await fs.readFile(full, 'utf-8');
        const lines = text.split(/\r?\n/);
        const start = Math.max(1, opts.startLine ?? 1);
        const end = Math.min(lines.length, opts.endLine ?? (opts.maxLines ? start + opts.maxLines - 1 : lines.length));
        return lines.slice(start - 1, end).join('\n');
      },

      grep: async (pattern: string | RegExp, opts = {}) => {
        const maxMatches = opts.maxMatches ?? 200;
        let candidateFiles: string[] = [];

        if (opts.files && opts.files.length > 0) {
          candidateFiles = opts.files;
        } else if (opts.filePattern) {
          candidateFiles = await dacApi.glob(opts.filePattern);
        } else {
          const all = await this.fileIndex.ensureFresh();
          candidateFiles = all.slice(0, 300).map((f) => f.relPath);
        }

        const isRegex =
          pattern instanceof RegExp ||
          Object.prototype.toString.call(pattern) === '[object RegExp]' ||
          (typeof pattern === 'object' && pattern !== null && 'source' in (pattern as any));
        const regex = isRegex
          ? new RegExp((pattern as any).source, (pattern as any).flags || 'i')
          : new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

        const matches: CodeModeGrepMatch[] = [];
        for (const file of candidateFiles) {
          try {
            const content = await dacApi.readFile(file);
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                matches.push({
                  file: file.replace(/\\/g, '/'),
                  line: i + 1,
                  text: lines[i].trim(),
                });
                if (matches.length >= maxMatches) return matches;
              }
            }
          } catch {
            // Ignore unreadable / missing files
          }
        }
        return matches;
      },

      outline: async (filePath: string) => {
        const full = path.isAbsolute(filePath) ? filePath : path.resolve(this.cwd, filePath);
        return await extractCodeOutlineForPath(full);
      },

      exists: async (filePath: string) => {
        try {
          const full = path.isAbsolute(filePath) ? filePath : path.resolve(this.cwd, filePath);
          await fs.access(full);
          return true;
        } catch {
          return false;
        }
      },

      stat: async (filePath: string) => {
        const full = path.isAbsolute(filePath) ? filePath : path.resolve(this.cwd, filePath);
        const st = await fs.stat(full);
        return {
          isDirectory: st.isDirectory(),
          isFile: st.isFile(),
          size: st.size,
        };
      },

      extractLinesContaining: (content: string, sub: string | RegExp) => {
        const regex = sub instanceof RegExp ? sub : new RegExp(String(sub), 'i');
        const lines = content.split(/\r?\n/);
        const out: Array<{ line: number; text: string }> = [];
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            out.push({ line: i + 1, text: lines[i] });
          }
        }
        return out;
      },
    };

    // Prepare sandbox environment
    const sandbox: Record<string, unknown> = {
      dac: dacApi,
      tools: dacApi, // Alias matching OpenCode
      console: {
        log: safeLog,
        info: safeLog,
        warn: safeLog,
        error: safeLog,
      },
      JSON,
      Math,
      Date,
      RegExp,
      Array,
      Object,
      String,
      Number,
      Boolean,
      Promise,
      setTimeout,
      clearTimeout,
      ...(options.extraBindings || {}),
    };

    const context = vm.createContext(sandbox);

    // Normalize source: strip outer markdown fences if present
    let cleanCode = String(code || '').trim();
    if (cleanCode.startsWith('```')) {
      cleanCode = cleanCode
        .replace(/^```[a-zA-Z0-9_-]*\r?\n/, '')
        .replace(/\r?\n\s*```\s*$/, '')
        .trim();
    }

    // Wrap in async immediately invoked function if not already wrapped
    const isAsync = /\bawait\b|\breturn\b/.test(cleanCode);
    const wrappedCode = isAsync
      ? `(async () => {\n${cleanCode}\n})()`
      : `(() => {\n${cleanCode}\n})()`;

    try {
      const script = new vm.Script(wrappedCode, {
        filename: 'codemode_script.js',
      });

      const rawPromise = script.runInContext(context, {
        timeout: timeoutMs,
      });

      const timeoutPromise = new Promise((_, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`CodeMode execution timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      });

      const rawResult = await Promise.race([Promise.resolve(rawPromise), timeoutPromise]);

      let value = rawResult;
      // Cap output size if stringified
      if (typeof value === 'string' && value.length > maxOutputChars) {
        value = `${value.slice(0, maxOutputChars)}\n...[output truncated by CodeMode maxOutputChars limit]`;
      }

      return {
        ok: true,
        value,
        logs,
        durationMs: Date.now() - startMs,
      };
    } catch (err: any) {
      return {
        ok: false,
        logs,
        durationMs: Date.now() - startMs,
        error: `CODEMODE_EXECUTION_ERROR: ${err?.message || String(err)}`,
      };
    }
  }
}
