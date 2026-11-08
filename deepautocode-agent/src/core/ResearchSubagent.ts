/**
 * Read-only multi-round research subagent.
 * Round 1: searches / path hits
 * Round 2: outline + focused reads around matches
 * Round 3: related symbol expansion
 * Round 4: task-guided follow-up
 * Optional: budgeted nested LLM decompose + synthesis (heuristic fallback).
 * Returns a size-capped evidence digest for the parent Agent.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { extractCodeOutlineForPath } from './CodeOutline.js';
import {
  searchIndexedFiles,
  WorkspaceFileIndex,
  type SearchIndexedFilesOptions,
} from './WorkspaceFileIndex.js';
import {
  decomposeResearchHeuristic,
  decomposeResearchTask,
  type LlmDecomposeFn,
} from './ResearchDecompose.js';

export interface ResearchSubagentParams {
  workspaceRoot: string;
  task: string;
  queries?: string[];
  files?: string[];
  index?: WorkspaceFileIndex;
  /** Max exploration rounds (default 4 for research, 2 for planner) */
  maxRounds?: number;
  /** Soft cap on report characters */
  maxReportChars?: number;
  /** Optional override for search (e.g. SSH grep) */
  search?: (query: string) => Promise<string>;
  /** Optional override for reading a relative file */
  readFile?: (relPath: string) => Promise<string>;
  /** Optional short LLM call to refine research questions */
  llmDecompose?: LlmDecomposeFn;
  /**
   * Optional budgeted nested LLM to synthesize a short conclusion from evidence.
   * Keep under ~1500 tokens; failures are ignored (heuristic report remains).
   */
  llmSynthesize?: (input: {
    task: string;
    evidence: string;
  }) => Promise<string>;
}

export interface ResearchSubagentResult {
  ok: true;
  role: 'research' | 'planner';
  task: string;
  rounds: number;
  filesInspected: string[];
  queries: string[];
  report: string;
  /** Suggested follow-up todos for planner / manage_todo */
  suggestedTodos?: string[];
  /** Decomposed research questions */
  questions?: string[];
  decomposeSource?: 'heuristic' | 'llm' | 'hybrid';
}

/** Derive follow-up search strings from task intent (callers/tests/errors/imports). */
export function buildGuidedFollowUpQueries(task: string, baseQueries: string[]): string[] {
  const t = task.toLowerCase();
  const primary = baseQueries[0] || extractQueriesFromTask(task)[0];
  if (!primary) return [];
  const out: string[] = [];
  const push = (q: string) => {
    if (q && !out.includes(q) && !baseQueries.includes(q)) out.push(q);
  };

  if (/(?:caller|调用|引用|usage|used by|谁在用)/i.test(task)) {
    push(primary);
    push(`import.*${primary}`);
  }
  if (/(?:test|测试|spec|单元)/i.test(task) || /test/i.test(t)) {
    push(`${primary}.test`);
    push(`${primary}.spec`);
    push(`describe.*${primary}`);
  }
  if (/(?:error|bug|fail|crash|报错|失败|异常|fix)/i.test(task)) {
    push(`throw`);
    push(`${primary}.*Error`);
    push(`TODO.*${primary}`);
  }
  if (/(?:import|依赖|export|接口|api)/i.test(task)) {
    push(`from ['"].*${primary}`);
    push(`export.*${primary}`);
  }
  if (/(?:config|配置|verify|门禁)/i.test(task)) {
    push('verify.json');
    push('tsconfig');
  }
  // Always try one related identifier pattern
  push(`${primary}(`);
  return out.slice(0, 5);
}

function extractQueriesFromTask(task: string): string[] {
  const out: string[] = [];
  const ident = task.match(/\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g) || [];
  for (const w of ident) {
    if (
      /^(the|and|for|with|from|this|that|into|file|code|find|how|what|where|when|please|investigate|research|explore|look|check)$/i.test(
        w
      )
    ) {
      continue;
    }
    if (!out.includes(w)) out.push(w);
    if (out.length >= 6) break;
  }
  return out;
}

function collectPathsFromSearch(text: string, limit = 12): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const re = /([a-zA-Z0-9_./\\-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|c|cc|cpp|cxx|h|hpp|cuh?))\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const p = m[1].replace(/\\/g, '/').replace(/^\.\//, '');
    if (seen.has(p)) continue;
    seen.add(p);
    paths.push(p);
    if (paths.length >= limit) break;
  }
  return paths;
}

function extractMatchLines(searchOut: string, filePath: string, limit = 6): number[] {
  const lines: number[] = [];
  const re = new RegExp(
    `${filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+):`,
    'g'
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(searchOut)) !== null) {
    const n = Number(m[1]);
    if (n > 0 && !lines.includes(n)) lines.push(n);
    if (lines.length >= limit) break;
  }
  return lines;
}

async function defaultRead(root: string, rel: string): Promise<string> {
  return fs.readFile(path.resolve(root, rel), 'utf-8');
}

/**
 * Run multi-round read-only research and return a compact evidence report.
 */
export async function runResearchSubagent(
  params: ResearchSubagentParams
): Promise<ResearchSubagentResult> {
  const root = path.resolve(params.workspaceRoot);
  const maxRounds = Math.max(1, Math.min(5, params.maxRounds ?? 4));
  const maxReportChars = params.maxReportChars ?? 6500;
  const index = params.index ?? new WorkspaceFileIndex(root);

  const decomposed = params.llmDecompose
    ? await decomposeResearchTask(params.task, { llmDecompose: params.llmDecompose })
    : decomposeResearchHeuristic(params.task);

  const queries = [
    ...(params.queries || []),
    ...decomposed.searchQueries,
    ...extractQueriesFromTask(params.task),
  ]
    .map((q) => q.trim())
    .filter(Boolean)
    .filter((q, i, arr) => arr.indexOf(q) === i)
    .slice(0, 10);

  const readFile =
    params.readFile || ((rel: string) => defaultRead(root, rel));
  const search =
    params.search ||
    (async (query: string) =>
      searchIndexedFiles({
        root,
        index,
        query,
        mode: 'auto',
        maxMatches: 30,
        contextLines: 2,
      } as SearchIndexedFilesOptions));

  const sections: string[] = [
    `# Research report`,
    `Task: ${params.task}`,
    `Decompose (${decomposed.source}):`,
    ...decomposed.questions.map((q, i) => `${i + 1}. ${q}`),
    `Queries: ${queries.join(', ') || '(none)'}`,
  ];
  const inspected = new Set<string>();
  let rounds = 0;
  let lastSearchBlob = '';

  // Seed with explicit files
  for (const f of params.files || []) {
    const rel = f.replace(/\\/g, '/').replace(/^\.\//, '');
    if (rel) inspected.add(rel);
  }

  for (let round = 1; round <= maxRounds; round++) {
    rounds = round;
    if (round === 1) {
      const searchParts: string[] = [];
      for (const q of queries.slice(0, 5)) {
        try {
          const hit = await search(q);
          searchParts.push(`### Search \`${q}\`\n${String(hit).slice(0, 1800)}`);
          for (const p of collectPathsFromSearch(String(hit), 8)) inspected.add(p);
        } catch {
          // ignore
        }
      }
      lastSearchBlob = searchParts.join('\n\n');
      if (searchParts.length) sections.push(`## Round 1 — Search\n${searchParts.join('\n\n')}`);
      continue;
    }

    if (round === 2) {
      const targets = Array.from(inspected).slice(0, 8);
      if (targets.length === 0) break;
      const fileParts: string[] = [];
      for (const rel of targets) {
        try {
          const content = await readFile(rel);
          const outline = extractCodeOutlineForPath(rel, content, 36).join('\n');
          const matchLines = extractMatchLines(lastSearchBlob, rel, 4);
          let window = '';
          if (matchLines.length > 0) {
            const lines = content.split(/\r?\n/);
            const chunks: string[] = [];
            for (const ln of matchLines.slice(0, 3)) {
              const s = Math.max(1, ln - 8);
              const e = Math.min(lines.length, ln + 12);
              chunks.push(
                lines
                  .slice(s - 1, e)
                  .map((l, i) => `${s + i}: ${l}`)
                  .join('\n')
              );
            }
            window = chunks.join('\n...\n');
          } else {
            window = content.split(/\r?\n/).slice(0, 40).map((l, i) => `${i + 1}: ${l}`).join('\n');
          }
          fileParts.push(
            `### \`${rel}\` (${content.split(/\r?\n/).length} lines)\n[Outline]\n${
              outline || '(none)'
            }\n[Window]\n${window.slice(0, 1600)}`
          );
          inspected.add(rel);
        } catch {
          fileParts.push(`### \`${rel}\`\n(read failed)`);
        }
      }
      sections.push(`## Round 2 — Outline & focused reads\n${fileParts.join('\n\n')}`);
      continue;
    }

    if (round === 3) {
      // Expand: symbol search for top query against outlines of new path hits
      const expandQ = queries[0];
      if (!expandQ) break;
      try {
        const sym = await searchIndexedFiles({
          root,
          index,
          query: expandQ,
          mode: 'symbol',
          maxMatches: 20,
        });
        const morePaths = collectPathsFromSearch(sym, 6);
        const extras: string[] = [];
        for (const rel of morePaths) {
          if (inspected.has(rel)) continue;
          inspected.add(rel);
          try {
            const content = await readFile(rel);
            const outline = extractCodeOutlineForPath(rel, content, 20).join('\n');
            extras.push(`### \`${rel}\`\n${outline || content.slice(0, 600)}`);
          } catch {
            // ignore
          }
          if (extras.length >= 4) break;
        }
        sections.push(
          `## Round 3 — Symbol expansion\n${sym.slice(0, 1500)}${
            extras.length ? `\n\n${extras.join('\n\n')}` : ''
          }`
        );
      } catch {
        // ignore
      }
      continue;
    }

    if (round === 4) {
      // Task-guided follow-up queries derived from the objective (callers, tests, errors, imports)
      const guided = buildGuidedFollowUpQueries(params.task, queries);
      if (guided.length === 0) break;
      const parts: string[] = [];
      for (const q of guided.slice(0, 4)) {
        try {
          const looksRegex = /[.*+?^${}()|[\]\\]/.test(q);
          const hit = looksRegex
            ? await searchIndexedFiles({
                root,
                index,
                query: q,
                mode: 'content',
                regex: true,
                maxMatches: 25,
                contextLines: 2,
              })
            : await search(q);
          const hitStr = String(hit);
          parts.push(`### Guided \`${q}\`\n${hitStr.slice(0, 1200)}`);
          for (const p of collectPathsFromSearch(hitStr, 5)) {
            if (inspected.has(p)) continue;
            inspected.add(p);
            try {
              const content = await readFile(p);
              const outline = extractCodeOutlineForPath(p, content, 16).join('\n');
              parts.push(`#### New file \`${p}\`\n${outline || content.slice(0, 500)}`);
            } catch {
              // ignore
            }
          }
        } catch {
          // ignore
        }
      }
      if (parts.length) {
        sections.push(`## Round 4 — Task-guided follow-up\n${parts.join('\n\n')}`);
      }
    }
  }

  let report = sections.join('\n\n');
  if (report.length > maxReportChars) {
    report = `${report.slice(0, maxReportChars)}\n...[research report truncated]...`;
  }

  let synthesizeSource: 'none' | 'llm' = 'none';
  if (typeof params.llmSynthesize === 'function') {
    try {
      const synthesis = await params.llmSynthesize({
        task: params.task,
        evidence: report.slice(0, 5000),
      });
      const text = String(synthesis || '').trim();
      if (text) {
        synthesizeSource = 'llm';
        report = `## Nested-LLM synthesis\n${text.slice(0, 2000)}\n\n---\n${report}`;
        if (report.length > maxReportChars) {
          report = `${report.slice(0, maxReportChars)}\n...[research report truncated]...`;
        }
      }
    } catch {
      // keep heuristic evidence report
    }
  }

  const suggestedTodos = [
    `Investigate: ${params.task}`.slice(0, 200),
    ...Array.from(inspected)
      .slice(0, 4)
      .map((f) => `Review / edit ${f}`),
    'Apply fixes and run workspace verify',
  ];

  return {
    ok: true,
    role: 'research',
    task: params.task,
    rounds,
    filesInspected: Array.from(inspected),
    queries,
    report:
      synthesizeSource === 'llm'
        ? report
        : report,
    suggestedTodos,
    questions: decomposed.questions,
    decomposeSource: decomposed.source,
  };
}

/**
 * Planner role: research + structured plan steps for manage_todo / write_artifact.
 */
export async function runPlannerSubagent(
  params: ResearchSubagentParams
): Promise<ResearchSubagentResult & { planMarkdown: string }> {
  const research = await runResearchSubagent({ ...params, maxRounds: params.maxRounds ?? 2 });
  const steps = [
    '1. Confirm root cause from evidence above (cite file:line).',
    '2. Edit the minimal set of files (prefer edit_file / apply_patch).',
    '3. Run workspace verify gate and fix remaining diagnostics.',
    '4. Summarize changes with evidence (compile/test output).',
  ];
  const planMarkdown = [
    `# Plan: ${params.task}`,
    '',
    '## Evidence summary',
    research.report.slice(0, 2500),
    '',
    '## Steps',
    ...steps,
    '',
    '## Candidate files',
    ...research.filesInspected.slice(0, 10).map((f) => `- \`${f}\``),
  ].join('\n');

  return {
    ...research,
    role: 'planner',
    report: `${planMarkdown}\n\n---\n${research.report}`.slice(0, params.maxReportChars ?? 7000),
    planMarkdown,
    suggestedTodos: [
      ...steps.map((s) => s.replace(/^\d+\.\s*/, '')),
      ...research.filesInspected.slice(0, 3).map((f) => `Touch ${f} if needed`),
    ],
  };
}
