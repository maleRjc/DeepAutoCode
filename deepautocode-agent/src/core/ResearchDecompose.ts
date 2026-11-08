/**
 * Decompose a research/goal task into concrete search questions.
 * Heuristic always available; optional LLM callback for sharper splits.
 */
import { extractFailedTestHints } from './BuildDiagnostics.js';

export interface DecomposedResearch {
  questions: string[];
  searchQueries: string[];
  source: 'heuristic' | 'llm' | 'hybrid';
}

const STOP = new Set(
  [
    'the', 'and', 'for', 'with', 'from', 'this', 'that', 'into', 'file', 'code', 'find', 'how',
    'what', 'where', 'when', 'please', 'investigate', 'research', 'explore', 'look', 'check',
    'fix', 'bug', 'issue', 'why', 'does', 'not', 'work', '帮我', '一下', '什么', '怎么',
  ].map((s) => s.toLowerCase())
);

function extractIdents(text: string, limit = 8): string[] {
  const out: string[] = [];
  const ident = text.match(/\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g) || [];
  for (const w of ident) {
    if (STOP.has(w.toLowerCase())) continue;
    if (!out.includes(w)) out.push(w);
    if (out.length >= limit) break;
  }
  // Also catch path-like tokens
  const paths = text.match(/[a-zA-Z0-9_./-]+\.(?:[cm]?[jt]sx?|py|go|rs|c|cc|cpp|h|hpp)\b/g) || [];
  for (const p of paths) {
    if (!out.includes(p)) out.push(p);
    if (out.length >= limit + 4) break;
  }
  return out;
}

/**
 * Pure heuristic decomposition — no network.
 */
export function decomposeResearchHeuristic(task: string): DecomposedResearch {
  const cleaned = String(task || '').trim();
  const idents = extractIdents(cleaned);
  const primary = idents[0];
  const questions: string[] = [];
  const searchQueries: string[] = [...idents.slice(0, 5)];

  questions.push(`What is the concrete objective: ${cleaned.slice(0, 160)}?`);
  if (primary) {
    questions.push(`Where is \`${primary}\` defined and what are its signatures?`);
    questions.push(`Which files call or import \`${primary}\`?`);
  }
  if (/(?:error|fail|bug|crash|报错|失败|异常|wrong)/i.test(cleaned)) {
    questions.push('What error/test failure evidence exists and which file:line owns it?');
    const failHints = extractFailedTestHints(cleaned, 4);
    for (const h of failHints) searchQueries.push(h);
    if (primary) searchQueries.push(`${primary}Error`, 'FAILED');
  }
  if (/(?:test|测试|spec)/i.test(cleaned)) {
    questions.push('Which tests cover this behavior and how are they invoked?');
    if (primary) searchQueries.push(`${primary}.test`, `${primary}.spec`);
  }
  if (/(?:perf|性能|slow|latency)/i.test(cleaned)) {
    questions.push('Where is the hot path and what metrics/logs indicate slowness?');
  }
  if (/(?:api|接口|endpoint|route)/i.test(cleaned)) {
    questions.push('Which HTTP/RPC handlers and schemas are involved?');
  }
  questions.push('What minimal edit set + verify command would prove the fix?');

  // Dedup search queries
  const uniq: string[] = [];
  for (const q of searchQueries) {
    const t = q.trim();
    if (t && !uniq.includes(t)) uniq.push(t);
  }

  return {
    questions: questions.slice(0, 8),
    searchQueries: uniq.slice(0, 10),
    source: 'heuristic',
  };
}

/**
 * Parse LLM JSON/text listing of questions / queries.
 */
export function parseLlmDecomposeResponse(text: string): { questions: string[]; searchQueries: string[] } {
  const raw = String(text || '').trim();
  const questions: string[] = [];
  const searchQueries: string[] = [];
  try {
    const jsonStart = raw.indexOf('{');
    const jsonEnd = raw.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
      if (Array.isArray(parsed.questions)) {
        for (const q of parsed.questions) {
          if (String(q).trim()) questions.push(String(q).trim().slice(0, 200));
        }
      }
      if (Array.isArray(parsed.searchQueries)) {
        for (const q of parsed.searchQueries) {
          if (String(q).trim()) searchQueries.push(String(q).trim().slice(0, 80));
        }
      }
    }
  } catch {
    // fall through to line parse
  }
  if (questions.length === 0) {
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:\d+[.)]|[-*])\s+(.*)$/);
      if (m?.[1]) questions.push(m[1].trim().slice(0, 200));
    }
  }
  return {
    questions: questions.slice(0, 8),
    searchQueries: searchQueries.slice(0, 10),
  };
}

export type LlmDecomposeFn = (task: string) => Promise<string>;

/**
 * Heuristic first; optionally enrich with a short LLM decompose call.
 */
export async function decomposeResearchTask(
  task: string,
  options?: { llmDecompose?: LlmDecomposeFn; timeoutMs?: number }
): Promise<DecomposedResearch> {
  const base = decomposeResearchHeuristic(task);
  if (!options?.llmDecompose) return base;

  const timeoutMs = options.timeoutMs ?? 8000;
  try {
    const llmText = await Promise.race([
      options.llmDecompose(task),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('decompose timeout')), timeoutMs)
      ),
    ]);
    const parsed = parseLlmDecomposeResponse(llmText);
    const questions = [...parsed.questions, ...base.questions]
      .filter((q, i, arr) => q && arr.indexOf(q) === i)
      .slice(0, 8);
    const searchQueries = [...parsed.searchQueries, ...base.searchQueries]
      .filter((q, i, arr) => q && arr.indexOf(q) === i)
      .slice(0, 10);
    return {
      questions: questions.length ? questions : base.questions,
      searchQueries: searchQueries.length ? searchQueries : base.searchQueries,
      source: parsed.questions.length || parsed.searchQueries.length ? 'hybrid' : 'heuristic',
    };
  } catch {
    return base;
  }
}
