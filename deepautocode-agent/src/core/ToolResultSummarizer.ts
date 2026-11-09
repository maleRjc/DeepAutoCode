/**
 * Deterministic summaries for older tool outputs during context compaction.
 * Prefer extracting paths, errors, exit codes, and key hits over blind truncation.
 */

export interface ToolResultTuple {
  paths: string[];
  errors: string[];
  exitCode: number | null;
  matchedLines: string[];
}

const PATH_RE =
  /([a-zA-Z0-9_./\\-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|c|cc|cpp|cxx|h|hpp|cuh?|json|md))\b/g;
const ERROR_RE =
  /(?:error|ERROR|FAILED|SEMANTIC_DIAGNOSTICS_FAILED|OLD_TEXT_NOT_FOUND|HUNK_NOT_FOUND|fatal error)[^\n]{0,160}/g;
const EXIT_RE = /"exitCode"\s*:\s*(-?\d+)|exit(?:ed\s+with\s+code|Code)?\s*[=:]?\s*(-?\d+)/i;
const LINE_HIT_RE =
  />?\s*([a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9]+):(\d+):\s*([^\n]{0,120})/g;

function uniqueLimited(items: string[], limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    const s = raw.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

function asText(output: unknown): string {
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output ?? '');
  } catch {
    return String(output ?? '');
  }
}

function extractFromObject(output: unknown): string[] {
  const lines: string[] = [];
  if (!output || typeof output !== 'object') return lines;
  const o = output as Record<string, unknown>;
  if (o.ok === false && o.error) lines.push(`error: ${String(o.error).slice(0, 200)}`);
  if (typeof o.filePath === 'string') lines.push(`file: ${o.filePath}`);
  if (typeof o.exitCode === 'number') lines.push(`exitCode: ${o.exitCode}`);
  if (typeof o.command === 'string') lines.push(`command: ${String(o.command).slice(0, 120)}`);
  if (typeof o.semanticErrors === 'string' && o.semanticErrors.trim()) {
    lines.push(`semanticErrors:\n${o.semanticErrors.slice(0, 600)}`);
  }
  if (typeof o.mandatoryNextStep === 'string') {
    lines.push(`next: ${o.mandatoryNextStep.slice(0, 200)}`);
  }
  if (typeof o.mandatoryFixHint === 'string') {
    lines.push(`fix: ${o.mandatoryFixHint.slice(0, 200)}`);
  }
  if (Array.isArray(o.files)) {
    for (const f of o.files.slice(0, 6)) {
      if (f && typeof f === 'object') {
        const fr = f as Record<string, unknown>;
        lines.push(
          `- ${fr.filePath || '?'}: ok=${fr.ok}${fr.error ? ` err=${String(fr.error).slice(0, 80)}` : ''}`
        );
      }
    }
  }
  if (typeof o.report === 'string' && o.report.length > 0) {
    lines.push(`report_excerpt:\n${o.report.slice(0, 700)}`);
  }
  if (typeof o.digest === 'string' && o.digest.length > 0) {
    lines.push(`digest_excerpt:\n${o.digest.slice(0, 700)}`);
  }
  if (typeof o.content === 'string' && o.content.length > 400) {
    const content = o.content;
    const pathHits = uniqueLimited(Array.from(content.matchAll(PATH_RE)).map((m) => m[1]), 8);
    if (pathHits.length) lines.push(`paths: ${pathHits.join(', ')}`);
    lines.push(`content_head:\n${content.slice(0, 500)}`);
  } else if (typeof o.content === 'string') {
    lines.push(`content:\n${o.content}`);
  }
  if (typeof o.stdout === 'string' && o.stdout.trim()) {
    const errLines = uniqueLimited(Array.from(o.stdout.matchAll(ERROR_RE)).map((m) => m[0]), 5);
    lines.push(
      errLines.length
        ? `stdout_errors:\n${errLines.join('\n')}`
        : `stdout_tail:\n${o.stdout.slice(-500)}`
    );
  }
  if (typeof o.stderr === 'string' && o.stderr.trim()) {
    lines.push(`stderr_tail:\n${o.stderr.slice(-400)}`);
  }
  return lines;
}

/**
 * C2: Extract structured 4-tuple (paths, errors, exitCode, matchedLines) from any tool output.
 */
export function extractToolResultTuple(
  _toolName: string | undefined,
  output: unknown
): ToolResultTuple {
  const text = asText(output);
  const paths = uniqueLimited(Array.from(text.matchAll(PATH_RE)).map((m) => m[1]), 12);
  const errors = uniqueLimited(Array.from(text.matchAll(ERROR_RE)).map((m) => m[0]), 8);
  if (output && typeof output === 'object') {
    const o = output as Record<string, unknown>;
    if (typeof o.filePath === 'string' && !paths.includes(o.filePath)) {
      paths.unshift(o.filePath);
    }
    if (typeof o.error === 'string' && o.error.trim() && !errors.includes(o.error.trim())) {
      errors.unshift(o.error.trim().slice(0, 200));
    }
  }
  const matchedLines: string[] = [];
  LINE_HIT_RE.lastIndex = 0;
  let hm: RegExpExecArray | null;
  while ((hm = LINE_HIT_RE.exec(text)) !== null) {
    matchedLines.push(`${hm[1]}:${hm[2]}: ${hm[3]}`);
    if (matchedLines.length >= 10) break;
  }
  let exitCode: number | null = null;
  if (output && typeof output === 'object' && typeof (output as any).exitCode === 'number') {
    exitCode = (output as any).exitCode;
  } else {
    const exitMatch = EXIT_RE.exec(text);
    if (exitMatch) {
      const parsed = Number(exitMatch[1] ?? exitMatch[2]);
      if (Number.isFinite(parsed)) exitCode = parsed;
    }
  }
  return {
    paths,
    errors,
    exitCode,
    matchedLines,
  };
}

/**
 * Build a compact, information-preserving summary of a tool result.
 */
export function summarizeToolOutput(
  toolName: string | undefined,
  output: unknown,
  originalCharsOrOptions?: number | { maxChars?: number },
  options?: { maxChars?: number }
): string {
  const text = asText(output);
  const originalChars =
    typeof originalCharsOrOptions === 'number' ? originalCharsOrOptions : text.length;
  const opts =
    typeof originalCharsOrOptions === 'object' && originalCharsOrOptions !== null
      ? originalCharsOrOptions
      : options;
  const maxChars = opts?.maxChars ?? 1800;
  const name = toolName || 'tool';
  const structured = extractFromObject(output);
  const tuple = extractToolResultTuple(toolName, output);

  const parts: string[] = [
    `[compacted summary of ${name} — original ${originalChars} chars]`,
  ];
  if (tuple.exitCode !== null) {
    parts.push(`[ToolTuple exitCode=${tuple.exitCode}]`);
  }
  if (structured.length) parts.push(structured.join('\n'));
  if (tuple.exitCode !== null && !structured.some((l) => l.startsWith('exitCode:'))) {
    parts.push(`exitCode: ${tuple.exitCode}`);
  }
  if (tuple.paths.length) parts.push(`paths: ${tuple.paths.join(', ')}`);
  if (tuple.errors.length) parts.push(`signals:\n- ${tuple.errors.join('\n- ')}`);
  if (tuple.matchedLines.length) parts.push(`line_hits:\n- ${tuple.matchedLines.join('\n- ')}`);

  // Keep a short head for unstructured blobs when extraction is thin
  if (parts.length <= 2) {
    parts.push(text.slice(0, 900));
  }

  let summary = parts.join('\n');
  if (summary.length > maxChars) {
    summary = `${summary.slice(0, Math.max(200, maxChars - 40))}\n...[summary truncated]...`;
  }
  return summary;
}

export function shouldCompactToolOutput(output: unknown, minChars = 1600): boolean {
  return asText(output).length > minChars;
}
