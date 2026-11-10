/**
 * Cursor-aligned Composer context routing:
 * - Same chat thread by default (continue), dynamic trim — not static full history dump
 * - @mentions / path overlap / continuation cues increase relation score
 * - Low relation → trimmed context or fork (user setting), like starting a new Cursor chat
 */

import { classifyPromptIntent, promptRequestsWorkspaceArtifact } from './GoalSteering.js';

export type ComposerSessionTopic = 'deliverable' | 'debug-fix' | 'query' | 'general';

export type ComposerContextMode = 'continue_full' | 'continue_trimmed' | 'fork_session';

export interface ComposerContextPlan {
  mode: ComposerContextMode;
  relationScore: number;
  reason: string;
  /** Prior user+assistant pairs to include in model context (0–4). */
  historyMessagePairs: number;
  includeToolAudit: boolean;
  stripDeliverableFromAudit: boolean;
  focusBlock: 'deliverable' | 'engineering' | 'query' | 'neutral';
}

export interface ContextMessage {
  role: string;
  content: string;
}

function stripComposerIntentPrefixes(rawText: string): string {
  return String(rawText || '')
    .replace(/^\[(?:READ_ONLY_ANALYSIS|FORCE_AUTO_ACTION|INLINE_QUERY|INLINE_EDIT)\]\s*/i, '')
    .replace(/^\[Context Active File:[^\]]+\]\s*/i, '')
    .trim();
}

export function classifyComposerSessionTopic(rawText: string): ComposerSessionTopic {
  const cleaned = stripComposerIntentPrefixes(rawText);
  if (!cleaned) return 'general';
  if (promptRequestsWorkspaceArtifact(cleaned)) return 'deliverable';
  if (
    /(?:修复|bug|#wrong|sendrecv|编译失败|测试失败|根因|不对|hang|死锁|崩溃|segfault|FAILED|修一下|改一下|wrong\s*=|auto_build)/i.test(
      cleaned
    )
  ) {
    return 'debug-fix';
  }
  if (classifyPromptIntent(cleaned).intent === 'query-only') return 'query';
  return 'general';
}

export function inferPriorSessionTopicFromMessages(
  messages: ContextMessage[]
): ComposerSessionTopic | null {
  if (!messages?.length) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const topic = classifyComposerSessionTopic(m.content);
    if (topic !== 'general') return topic;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    if (/docs\/tutorials|\.pdf|pandoc|教程|生成.*文档/i.test(m.content)) return 'deliverable';
    if (/修复|#wrong|编译|测试失败/i.test(m.content)) return 'debug-fix';
  }
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  return lastUser ? classifyComposerSessionTopic(lastUser.content) : null;
}

const PATH_TOKEN =
  /(?:^|[\\/])?([a-zA-Z0-9_./\\-]+\.(?:c|cc|cpp|cxx|cu|cuh|h|hh|hpp|py|ts|tsx|js|jsx|go|rs|java|md|json|cmake|sh))/gi;

function extractPathTokens(text: string): string[] {
  const out = new Set<string>();
  const cleaned = String(text || '');
  for (const m of cleaned.matchAll(PATH_TOKEN)) {
    out.add(m[1].replace(/\\/g, '/').toLowerCase());
  }
  for (const m of cleaned.matchAll(/@([a-zA-Z0-9_./\\-]+)/g)) {
    out.add(m[1].replace(/\\/g, '/').toLowerCase());
  }
  return [...out];
}

function hasContinuationCue(text: string): boolean {
  return /(?:继续|还是不对|仍然|依然|上面|刚才|上一轮|按你的|基于此|接着|在此基础上|follow\s*up|same\s+issue|继续改)/i.test(
    text
  );
}

function hasFreshTaskCue(text: string): boolean {
  return /(?:新问题|另外一个|换个话题|不管上面|忽略之前|另起|重新开|new\s+chat|different\s+task)/i.test(
    text
  );
}

function topicAffinity(a: ComposerSessionTopic, b: ComposerSessionTopic): number {
  if (a === b) return 1;
  if (a === 'general' || b === 'general') return 0.5;
  const key = `${a}|${b}`;
  const table: Record<string, number> = {
    'query|debug-fix': 0.78,
    'debug-fix|query': 0.68,
    'query|general': 0.45,
    'debug-fix|general': 0.42,
    'deliverable|query': 0.22,
    'deliverable|debug-fix': 0.18,
    'query|deliverable': 0.2,
    'debug-fix|deliverable': 0.15,
  };
  return table[key] ?? 0.12;
}

function scoreRelation(newPrompt: string, messages: ContextMessage[]): number {
  const cleaned = stripComposerIntentPrefixes(newPrompt);
  if (!messages.length) return 1;

  let score = 0.52;
  if (hasFreshTaskCue(cleaned)) score -= 0.32;
  if (hasContinuationCue(cleaned)) score += 0.28;

  const priorTail = messages
    .slice(-8)
    .map((m) => m.content)
    .join('\n');
  const newPaths = extractPathTokens(cleaned);
  const oldPaths = new Set(extractPathTokens(priorTail));
  if (newPaths.length > 0) {
    const overlap = newPaths.filter((p) => oldPaths.has(p)).length;
    score += 0.22 * (overlap / newPaths.length);
  }
  if (/@\S+/.test(cleaned)) score += 0.12;

  const newTopic = classifyComposerSessionTopic(cleaned);
  const priorTopic = inferPriorSessionTopicFromMessages(messages);
  if (priorTopic) {
    score = score * 0.35 + topicAffinity(priorTopic, newTopic) * 0.65;
  }

  return Math.max(0, Math.min(1, score));
}

export function resolveComposerContextPlan(params: {
  newPrompt: string;
  messages: ContextMessage[];
  /** When true, fork_session may be chosen for low relation (webview). */
  allowFork?: boolean;
}): ComposerContextPlan {
  const cleaned = stripComposerIntentPrefixes(params.newPrompt);
  const newTopic = classifyComposerSessionTopic(cleaned);
  const priorTopic = inferPriorSessionTopicFromMessages(params.messages);
  const relationScore = scoreRelation(params.newPrompt, params.messages);

  if (!params.messages.length) {
    return {
      mode: 'continue_full',
      relationScore: 1,
      reason: '首条消息',
      historyMessagePairs: 0,
      includeToolAudit: false,
      stripDeliverableFromAudit: false,
      focusBlock:
        newTopic === 'deliverable'
          ? 'deliverable'
          : newTopic === 'debug-fix'
            ? 'engineering'
            : newTopic === 'query'
              ? 'query'
              : 'neutral',
    };
  }

  const FORK = 0.26;
  const TRIM = 0.52;

  let mode: ComposerContextMode = 'continue_full';
  if (hasFreshTaskCue(cleaned) && relationScore < 0.5) {
    mode = 'fork_session';
  } else if (
    params.allowFork !== false &&
    relationScore < FORK &&
    priorTopic &&
    newTopic !== priorTopic
  ) {
    mode = 'fork_session';
  } else if (
    relationScore < TRIM ||
    (priorTopic === 'deliverable' && newTopic !== 'deliverable' && !hasContinuationCue(cleaned))
  ) {
    mode = 'continue_trimmed';
  }

  const historyMessagePairs =
    mode === 'fork_session' ? 0 : mode === 'continue_trimmed' ? 1 : 3;

  const includeToolAudit = mode === 'continue_full' && relationScore >= 0.62;
  const stripDeliverableFromAudit =
    priorTopic === 'deliverable' && newTopic !== 'deliverable';

  const focusBlock =
    newTopic === 'deliverable'
      ? 'deliverable'
      : newTopic === 'debug-fix'
        ? 'engineering'
        : newTopic === 'query'
          ? 'query'
          : 'neutral';

  const reason =
    mode === 'fork_session'
      ? `与上文关联度 ${Math.round(relationScore * 100)}% — 按 Cursor 习惯新开对话，避免旧任务干扰`
      : mode === 'continue_trimmed'
        ? `关联度 ${Math.round(relationScore * 100)}% — 同会话续聊，仅保留最近一轮上下文（动态裁剪）`
        : `关联度 ${Math.round(relationScore * 100)}% — 同一任务线，延续会话上下文`;

  return {
    mode,
    relationScore,
    reason,
    historyMessagePairs,
    includeToolAudit,
    stripDeliverableFromAudit,
    focusBlock,
  };
}

export function historySliceBounds(
  totalMessages: number,
  plan: ComposerContextPlan
): { start: number; end: number } {
  if (totalMessages <= 1) return { start: 0, end: 0 };
  const priorCount = totalMessages - 1;
  const windowMessages = Math.min(
    priorCount,
    Math.max(0, plan.historyMessagePairs * 2)
  );
  if (windowMessages === 0) return { start: priorCount, end: priorCount };
  const end = priorCount;
  const start = Math.max(0, end - windowMessages);
  return { start, end };
}

export function buildContextRoutingPromptBlock(plan: ComposerContextPlan): string {
  const lines = [
    '[COMPOSER_CONTEXT_ROUTING — Cursor-style dynamic context]',
    `- Relation to prior turns: ${Math.round(plan.relationScore * 100)}% (${plan.reason})`,
    `- Mode: ${plan.mode}`,
  ];

  if (plan.mode === 'fork_session') {
    lines.push(
      'Treat this as a fresh task thread. Ignore unrelated prior tutorial/PDF/doc tooling unless the user @mentions those paths in THIS message.'
    );
  } else if (plan.mode === 'continue_trimmed') {
    lines.push(
      'Only the latest user message + the immediately preceding exchange are authoritative. Do not re-open finished deliverables (docs/tutorials/pdf) unless asked now.',
      'Prefer search_codebase / @file for new facts instead of re-running the same read_file loops from older turns.'
    );
  } else {
    lines.push(
      'Continue the same task arc. Reuse prior conclusions when still valid; use read_file only when workspace may have changed.'
    );
  }

  if (plan.focusBlock === 'engineering') {
    lines.push(
      'Focus: source/tests under src/, device/, test/. Never read_file .pdf — use .md or pandoc.',
      'Do not read package.json unless the user asks about Node tooling.'
    );
  } else if (plan.focusBlock === 'query') {
    lines.push('Focus: explain/diagnose with citations; avoid write_file unless the user explicitly requests a deliverable.');
  } else if (plan.focusBlock === 'deliverable') {
    lines.push('Focus: write_file the artifact first, then at most one pandoc/shell step.');
  }

  return lines.join('\n');
}

export function shouldForkComposerSession(
  newPrompt: string,
  messages: ContextMessage[],
  enabled = true
): boolean {
  if (!enabled || !messages.length) return false;
  return (
    resolveComposerContextPlan({ newPrompt, messages, allowFork: true }).mode === 'fork_session'
  );
}
