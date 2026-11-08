/**
 * Stage W: gitignore-style ignore rules for Agent indexing / search / reads.
 * Loads `.cursorignore`, `.deepautocodeignore`, and optionally `.gitignore`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export interface IgnoreRuleSet {
  patterns: string[];
  /** Absolute workspace root */
  root: string;
  sources: string[];
}

const DEFAULT_DIR_IGNORES = [
  'node_modules/',
  '.git/',
  'dist/',
  'build/',
  'out/',
  'coverage/',
  '.deepautocode-data/',
  '.venv/',
  'venv/',
  '__pycache__/',
  'CMakeFiles/',
  '.next/',
  '.turbo/',
  '.deepautocode/worktrees/',
];

/** Convert a single gitignore-style pattern to a matcher. */
export function patternToMatcher(pattern: string): {
  negate: boolean;
  dirOnly: boolean;
  match: (relPath: string, isDir: boolean) => boolean;
} | null {
  let raw = String(pattern || '').trim();
  if (!raw || raw.startsWith('#')) return null;
  let negate = false;
  if (raw.startsWith('!')) {
    negate = true;
    raw = raw.slice(1);
  }
  let dirOnly = false;
  if (raw.endsWith('/')) {
    dirOnly = true;
    raw = raw.slice(0, -1);
  }
  // Absolute-from-root patterns
  const anchored = raw.startsWith('/');
  if (anchored) raw = raw.slice(1);

  const escaped = raw
    .replace(/\\/g, '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '§§DOUBLESTAR§§')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/§§DOUBLESTAR§§/g, '.*');

  let re: RegExp;
  try {
    if (anchored) {
      re = new RegExp(`^${escaped}(?:/|$)`);
    } else if (raw.includes('/')) {
      re = new RegExp(`(?:^|/)${escaped}(?:/|$)`);
    } else {
      // basename match anywhere
      re = new RegExp(`(?:^|/)${escaped}(?:/|$)`);
    }
  } catch {
    return null;
  }

  return {
    negate,
    dirOnly,
    match(relPath: string, isDir: boolean) {
      const norm = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
      if (dirOnly && !isDir && !norm.endsWith('/')) {
        // also match files under the directory: pattern "build/" ignores build/**
        if (!re.test(`${norm}/`) && !re.test(norm)) return false;
        // For files, only match if path is under a matching dir segment
        const parts = norm.split('/');
        for (let i = 0; i < parts.length; i++) {
          const prefix = parts.slice(0, i + 1).join('/');
          if (re.test(prefix) || re.test(`${prefix}/`)) return true;
        }
        return false;
      }
      return re.test(norm) || (isDir && re.test(`${norm}/`));
    },
  };
}

export class IgnoreMatcher {
  private readonly matchers: Array<ReturnType<typeof patternToMatcher>> = [];

  constructor(patterns: string[]) {
    for (const p of patterns) {
      const m = patternToMatcher(p);
      if (m) this.matchers.push(m);
    }
  }

  /** Return true if the relative path should be ignored. */
  ignores(relPath: string, isDir = false): boolean {
    const norm = relPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (!norm) return false;
    let ignored = false;
    for (const m of this.matchers) {
      if (!m) continue;
      if (m.match(norm, isDir)) {
        ignored = !m.negate;
      }
    }
    return ignored;
  }
}

export async function loadIgnoreRules(
  workspaceRoot: string,
  options?: { includeGitignore?: boolean }
): Promise<IgnoreRuleSet> {
  const root = path.resolve(workspaceRoot);
  const sources: string[] = ['<defaults>'];
  const patterns = [...DEFAULT_DIR_IGNORES];

  const files = [
    '.cursorignore',
    '.deepautocodeignore',
    ...(options?.includeGitignore === false ? [] : ['.gitignore']),
  ];

  for (const name of files) {
    try {
      const raw = await fs.readFile(path.join(root, name), 'utf-8');
      const lines = raw.split(/\r?\n/);
      let count = 0;
      for (const line of lines) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        patterns.push(t);
        count += 1;
      }
      if (count > 0) sources.push(name);
    } catch {
      // missing is fine
    }
  }

  return { root, patterns, sources };
}

export async function createIgnoreMatcher(
  workspaceRoot: string,
  options?: { includeGitignore?: boolean }
): Promise<IgnoreMatcher> {
  const rules = await loadIgnoreRules(workspaceRoot, options);
  return new IgnoreMatcher(rules.patterns);
}
