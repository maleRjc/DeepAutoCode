/**
 * Shared parser for compiler / test diagnostics used by Agent auto-heal
 * and the IDE Problems panel.
 */

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface BuildDiagnostic {
  file: string;
  line: number;
  column?: number;
  severity: DiagnosticSeverity;
  message: string;
  source: string;
}

export interface ParseBuildDiagnosticsOptions {
  maxItems?: number;
  defaultSource?: string;
}

const FILE_LOC =
  /([a-zA-Z0-9_./\\-]+\.(?:c|cc|cpp|cxx|cu|cuh|h|hh|hpp|hxx|py|ts|tsx|js|jsx|mjs|cjs|go|rs|java|kt|cs)):(\d+)(?::(\d+))?/i;

/**
 * Parse GCC/Clang/hipcc/nvcc/tsc/eslint/rustc/python-style diagnostics from build output.
 */
export function parseBuildDiagnostics(
  stdout: string,
  stderr = '',
  options?: ParseBuildDiagnosticsOptions
): BuildDiagnostic[] {
  const maxItems = options?.maxItems ?? 80;
  const defaultSource = options?.defaultSource ?? 'build';
  const combined = `${stdout || ''}\n${stderr || ''}`;
  const out: BuildDiagnostic[] = [];
  const seen = new Set<string>();

  const patterns: Array<{
    re: RegExp;
    severity: DiagnosticSeverity;
    source: string;
    msgGroup: number;
  }> = [
    {
      re: new RegExp(
        `${FILE_LOC.source}:\\s*(?:fatal\\s+)?error:\\s*([^\\r\\n]+)`,
        'gi'
      ),
      severity: 'error',
      source: 'compiler',
      msgGroup: 4,
    },
    {
      re: new RegExp(`${FILE_LOC.source}:\\s*warning:\\s*([^\\r\\n]+)`, 'gi'),
      severity: 'warning',
      source: 'compiler',
      msgGroup: 4,
    },
    {
      // TypeScript: path(line,col): error TSxxxx: message
      re: /([a-zA-Z0-9_./\\-]+\.(?:ts|tsx|js|jsx))\((\d+),(\d+)\):\s*error\s+TS\d+:\s*([^\r\n]+)/gi,
      severity: 'error',
      source: 'tsc',
      msgGroup: 4,
    },
    {
      re: /([a-zA-Z0-9_./\\-]+\.(?:ts|tsx|js|jsx))\((\d+),(\d+)\):\s*warning\s+TS\d+:\s*([^\r\n]+)/gi,
      severity: 'warning',
      source: 'tsc',
      msgGroup: 4,
    },
    {
      // ESLint stylish-ish / unix: path:line:col: error message
      re: /([a-zA-Z0-9_./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs)):(\d+):(\d+):\s*(error|warning)\s+([^\r\n]+)/gi,
      severity: 'error',
      source: 'eslint',
      msgGroup: 5,
    },
    {
      // rustc: --> path:line:col
      re: /error(?:\[E\d+\])?:\s*([^\r\n]+)\r?\n\s*-->\s*([a-zA-Z0-9_./\\-]+\.rs):(\d+):(\d+)/gi,
      severity: 'error',
      source: 'rustc',
      msgGroup: 1,
    },
    {
      // Python traceback last frame-ish: File "path", line N
      re: /File\s+"([^"]+\.py)",\s+line\s+(\d+)(?:,\s+in\s+[^\r\n]+)?\r?\n\s*[^\r\n]+\r?\n([A-Za-z_][\w.]*Error:\s*[^\r\n]+)/gi,
      severity: 'error',
      source: 'python',
      msgGroup: 3,
    },
  ];

  for (const pat of patterns) {
    pat.re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pat.re.exec(combined)) !== null) {
      let file = '';
      let line = 0;
      let column: number | undefined;
      let message = '';
      let severity = pat.severity;

      if (pat.source === 'rustc') {
        message = match[1]?.trim() || 'error';
        file = match[2] || '';
        line = Number(match[3]) || 1;
        column = Number(match[4]) || undefined;
      } else if (pat.source === 'python') {
        file = match[1] || '';
        line = Number(match[2]) || 1;
        message = match[3]?.trim() || 'Error';
      } else if (pat.source === 'eslint') {
        file = match[1] || '';
        line = Number(match[2]) || 1;
        column = Number(match[3]) || undefined;
        severity = String(match[4]).toLowerCase() === 'warning' ? 'warning' : 'error';
        message = match[5]?.trim() || 'lint issue';
      } else if (pat.source === 'tsc') {
        file = match[1] || '';
        line = Number(match[2]) || 1;
        column = Number(match[3]) || undefined;
        message = match[4]?.trim() || 'TypeScript error';
      } else {
        file = match[1] || '';
        line = Number(match[2]) || 1;
        column = match[3] ? Number(match[3]) : undefined;
        message = match[pat.msgGroup]?.trim() || 'error';
      }

      file = String(file)
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .trim();
      if (!file || !line) continue;

      const key = `${file}:${line}:${severity}:${message.slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        file,
        line,
        column,
        severity,
        message: message.slice(0, 300),
        source: pat.source || defaultSource,
      });
      if (out.length >= maxItems) return out;
    }
  }

  return out;
}

export function formatDiagnosticsForPrompt(diags: BuildDiagnostic[], limit = 40): string {
  if (!diags.length) return '(no compiler/linter diagnostics)';
  return diags
    .slice(0, limit)
    .map(
      (d) =>
        `${d.severity.toUpperCase()} ${d.file}:${d.line}${
          d.column ? `:${d.column}` : ''
        } [${d.source}] ${d.message}`
    )
    .join('\n');
}

/**
 * Best-effort extraction of failing test / suite names from common runners
 * (vitest, jest, pytest, ctest, googletest).
 */
export function extractFailedTestHints(output: string, limit = 6): string[] {
  const text = String(output || '');
  const hints: string[] = [];
  const seen = new Set<string>();
  const patterns = [
    /(?:FAIL|✕|×|✗)\s+([^\n\r]{3,120})/gi,
    /FAILED\s+(?:tests?\/)?([^\s\n\r]{3,120})/gi,
    /(?:^|\n)\s*(?:FAIL|ERROR)\s+([A-Za-z0-9_./:-]+\.py(?:::\w+)*)/gi,
    /The following tests FAILED:\s*\n([\s\S]{0,800}?)(?:\n\n|\n\d+%|\nErrors)/i,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      let raw = (m[1] || '').trim();
      if (re.source.startsWith('The following')) {
        for (const line of raw.split(/\r?\n/)) {
          const name = line.replace(/^\s*[\d.]+\s*-\s*/, '').trim();
          if (name.length >= 3 && !seen.has(name)) {
            seen.add(name);
            hints.push(name.slice(0, 160));
            if (hints.length >= limit) return hints;
          }
        }
        continue;
      }
      raw = raw.replace(/\s+and\s+\d+\s+more.*$/i, '').trim();
      if (raw.length < 3 || seen.has(raw)) continue;
      seen.add(raw);
      hints.push(raw.slice(0, 160));
      if (hints.length >= limit) return hints;
    }
  }
  return hints;
}

/**
 * Rank definition-like search hits for F12 / jump-to-definition.
 */
export function rankDefinitionCandidates(
  symbol: string,
  matches: Array<{ file: string; line: number; preview: string }>
): Array<{ file: string; line: number; preview: string; score: number }> {
  const q = symbol.trim();
  if (!q) return [];
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const defRes = [
    new RegExp(
      `\\b(?:function|class|interface|type|enum|struct|def|fn|func|const|let|var)\\s+${escaped}\\b`
    ),
    new RegExp(`\\b${escaped}\\s*=\\s*(?:async\\s*)?(?:function\\b|\\()`),
    new RegExp(`\\b(?:pub\\s+)?(?:async\\s+)?fn\\s+${escaped}\\b`),
    new RegExp(`#\\s*define\\s+${escaped}\\b`),
    // C/C++ style: `static int foo(` / `void ns::foo(`
    new RegExp(
      `(?:^|\\s)(?:static\\s+|inline\\s+|virtual\\s+|constexpr\\s+)*(?:[A-Za-z_][\\w:<>*&\\s]+)\\s+${escaped}\\s*\\(`
    ),
  ];

  const scored = matches.map((m) => {
    const preview = m.preview || '';
    let score = 0;
    if (defRes.some((re) => re.test(preview))) score += 100;
    // Prefer definition-looking braces over call sites
    if (
      new RegExp(`\\b${escaped}\\s*\\([^;]*\\)\\s*\\{?\\s*$`).test(preview) &&
      !/\breturn\b/.test(preview)
    ) {
      score += 50;
    }
    if (new RegExp(`\\b${escaped}\\s*\\(`).test(preview)) score += 20;
    if (preview.includes(q)) score += 10;
    if (/\.(?:h|hpp|hh|tsx?|jsx?)$/i.test(m.file)) score += 5;
    // Downrank obvious call sites
    if (/\breturn\b/.test(preview) || /;\s*$/.test(preview)) score -= 30;
    return { ...m, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line);
}
