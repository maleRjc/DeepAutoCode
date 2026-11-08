/**
 * Deterministic summaries for older tool outputs during context compaction.
 * Prefer extracting paths, errors, exit codes, and key hits over blind truncation.
 */

const PATH_RE =
  /([a-zA-Z0-9_./\\-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|c|cc|cpp|cxx|h|hpp|cuh?|json|md))\b/g;
const ERROR_RE =
  /(?:error|ERROR|FAILED|SEMANTIC_DIAGNOSTICS_FAILED|OLD_TEXT_NOT_FOUND|HUNK_NOT_FOUND|fatal error)[^\n]{0,160}/g;
const EXIT_RE = /"exitCode"\s*:\s*(-?\d+)|exit(?:Code)?\s*[=:]\s*(-?\d+)/i;
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
 * Build a compact, information-preserving summary of a tool result.
 */
export function summarizeToolOutput(
  toolName: string | undefined,
  output: unknown,
  originalChars: number,
  options?: { maxChars?: number }
): string {
  const maxChars = options?.maxChars ?? 1800;
  const name = toolName || 'tool';
  const structured = extractFromObject(output);
  const text = asText(output);

  const paths = uniqueLimited(Array.from(text.matchAll(PATH_RE)).map((m) => m[1]), 10);
  const errors = uniqueLimited(Array.from(text.matchAll(ERROR_RE)).map((m) => m[0]), 6);
  const hits: string[] = [];
  LINE_HIT_RE.lastIndex = 0;
  let hm: RegExpExecArray | null;
  while ((hm = LINE_HIT_RE.exec(text)) !== null) {
    hits.push(`${hm[1]}:${hm[2]}: ${hm[3]}`);
    if (hits.length >= 8) break;
  }
  const exit = EXIT_RE.exec(text);

  const parts: string[] = [
    `[compacted summary of ${name} — original ${originalChars} chars]`,
  ];
  if (structured.length) parts.push(structured.join('\n'));
  if (exit) parts.push(`exitCode: ${exit[1] || exit[2]}`);
  if (paths.length) parts.push(`paths: ${paths.join(', ')}`);
  if (errors.length) parts.push(`signals:\n- ${errors.join('\n- ')}`);
  if (hits.length) parts.push(`line_hits:\n- ${hits.join('\n- ')}`);

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
