/**
 * Token-budget-aware compaction policy for AgentLoop tool outputs.
 * Estimates ~4 chars/token; escalates aggressiveness as context fills.
 */

export interface CompactionPlan {
  /** Whether to run compaction at all */
  shouldCompact: boolean;
  /** Keep this many trailing messages untouched */
  keepRecentMessages: number;
  /** Only summarize outputs longer than this */
  minCharsToSummarize: number;
  /** Soft max length of a summary */
  summaryMaxChars: number;
  /** Soft per-tool result cap before summarization (chars) */
  perToolMaxChars: number;
  /** Estimated tool-result tokens in the conversation */
  estimatedToolTokens: number;
  /** 0-1 fill ratio when a budget is known; otherwise based on soft caps */
  fillRatio: number;
  /** True when fillRatio crosses the 80% warning threshold */
  warnBudget: boolean;
  reason: string;
  /** Ladder stage for Trace / UI */
  stage: 'none' | 'moderate' | 'high' | 'critical';
  /** What primarily drove the fill ratio this turn */
  trigger: 'none' | 'provider_tokens' | 'tool_chars' | 'hybrid';
}

export interface ResolveCompactionPlanParams {
  toolResultChars: number;
  /** Optional hard token budget for the run (from GoalState.tokenBudget) */
  tokenBudget?: number | null;
  /** Tokens already billed to the provider (from usage events) */
  tokensUsed?: number;
}

export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

/**
 * Resolve how aggressively to compact older tool outputs.
 */
export function resolveCompactionPlan(params: ResolveCompactionPlanParams): CompactionPlan {
  const toolChars = Math.max(0, params.toolResultChars || 0);
  const estimatedToolTokens = estimateTokensFromChars(toolChars);
  const budget =
    typeof params.tokenBudget === 'number' && params.tokenBudget > 0
      ? params.tokenBudget
      : null;
  const used = Math.max(0, params.tokensUsed || 0);

  let fillRatio = 0;
  let providerRatio = 0;
  let toolRatio = 0;
  if (budget) {
    providerRatio = used / budget;
    toolRatio = estimatedToolTokens / Math.max(budget * 0.6, 1);
    fillRatio = Math.min(1, Math.max(providerRatio, toolRatio));
  } else {
    // Soft ladders without an explicit budget
    if (toolChars >= 140_000) fillRatio = 0.95;
    else if (toolChars >= 80_000) fillRatio = 0.75;
    else if (toolChars >= 36_000) fillRatio = 0.55;
    else fillRatio = toolChars / 36_000;
    toolRatio = fillRatio;
  }

  const warnBudget = fillRatio >= 0.8;
  const trigger: CompactionPlan['trigger'] =
    fillRatio < 0.45 && toolChars < 36_000
      ? 'none'
      : budget && providerRatio >= 0.45 && providerRatio >= toolRatio * 0.95
        ? toolRatio >= 0.45
          ? 'hybrid'
          : 'provider_tokens'
        : toolRatio >= 0.45 || toolChars >= 36_000
          ? budget && providerRatio >= 0.45
            ? 'hybrid'
            : 'tool_chars'
          : budget && providerRatio >= 0.45
            ? 'provider_tokens'
            : 'none';

  if (fillRatio < 0.45 && toolChars < 36_000) {
    return {
      shouldCompact: false,
      keepRecentMessages: 4,
      minCharsToSummarize: 1600,
      summaryMaxChars: 1800,
      perToolMaxChars: 12_000,
      estimatedToolTokens,
      fillRatio,
      warnBudget,
      reason: 'below-compaction-threshold',
      stage: 'none',
      trigger,
    };
  }

  if (fillRatio >= 0.85 || toolChars >= 140_000) {
    return {
      shouldCompact: true,
      keepRecentMessages: 2,
      minCharsToSummarize: 400,
      summaryMaxChars: 900,
      perToolMaxChars: 2_500,
      estimatedToolTokens,
      fillRatio,
      warnBudget,
      reason:
        trigger === 'provider_tokens'
          ? 'critical-provider-token-pressure'
          : 'critical-context-pressure',
      stage: 'critical',
      trigger,
    };
  }
  if (fillRatio >= 0.65 || toolChars >= 80_000) {
    return {
      shouldCompact: true,
      keepRecentMessages: 3,
      minCharsToSummarize: 800,
      summaryMaxChars: 1200,
      perToolMaxChars: 4_000,
      estimatedToolTokens,
      fillRatio,
      warnBudget,
      reason:
        trigger === 'provider_tokens'
          ? 'high-provider-token-pressure'
          : 'high-context-pressure',
      stage: 'high',
      trigger,
    };
  }
  return {
    shouldCompact: true,
    keepRecentMessages: 4,
    minCharsToSummarize: 1600,
    summaryMaxChars: 1800,
    perToolMaxChars: 8_000,
    estimatedToolTokens,
    fillRatio,
    warnBudget,
    reason:
      trigger === 'provider_tokens'
        ? 'moderate-provider-token-pressure'
        : 'moderate-context-pressure',
    stage: 'moderate',
    trigger,
  };
}

export interface BudgetCompactionMessageItem {
  id?: string;
  role: 'user' | 'assistant' | 'tool' | 'system' | string;
  chars?: number;
  content?: unknown;
  pinned?: boolean;
}

export type ChatMessageLike = BudgetCompactionMessageItem;

export interface BudgetCompactionDecision {
  keep: Array<string | number>;
  summarize: Array<string | number>;
  drop: Array<string | number>;
  totalTokensBefore: number;
  softTokenBudget: number;
  overBudgetTokens: number;
}

/**
 * C1: Token-budget-driven compaction decision ({ keep, summarize, drop }).
 * Default softTokenBudget is 128,000 tokens.
 * - First user/system message + most recent `keepRecentCount` messages are placed in `keep`.
 * - Older messages within the summarize window (~60% of budget) are placed in `summarize`.
 * - Oldest excess tool/assistant messages when total exceeds softTokenBudget are placed in `drop`.
 */
export function decideBudgetCompaction(
  items: BudgetCompactionMessageItem[],
  options?: {
    softTokenBudget?: number;
    keepRecentCount?: number;
    preserveRecentMessages?: number;
  }
): BudgetCompactionDecision {
  const softTokenBudget = Math.max(1024, options?.softTokenBudget ?? 128_000);
  const keepRecentCount = Math.max(
    1,
    options?.keepRecentCount ?? options?.preserveRecentMessages ?? 4
  );
  const keep: Array<string | number> = [];
  const summarize: Array<string | number> = [];
  const drop: Array<string | number> = [];

  let totalTokensBefore = 0;
  const itemTokens = items.map((it, idx) => {
    const rawChars =
      typeof it.chars === 'number' && Number.isFinite(it.chars)
        ? it.chars
        : typeof it.content === 'string'
        ? it.content.length
        : JSON.stringify(it.content ?? '').length;
    const tokens = estimateTokensFromChars(rawChars);
    totalTokensBefore += tokens;
    return {
      ...it,
      id: it.id !== undefined ? it.id : idx,
      chars: rawChars,
      tokens,
    };
  });

  if (totalTokensBefore <= softTokenBudget) {
    for (const it of itemTokens) {
      keep.push(it.id);
    }
    return {
      keep,
      summarize,
      drop,
      totalTokensBefore,
      softTokenBudget,
      overBudgetTokens: 0,
    };
  }

  const recentStartIdx = Math.max(0, itemTokens.length - keepRecentCount);
  const pinnedIndices = new Set<number>();
  if (itemTokens.length > 0 && itemTokens[0].role === 'user') {
    pinnedIndices.add(0);
  }
  for (let i = 0; i < itemTokens.length; i++) {
    if (itemTokens[i].pinned || i >= recentStartIdx) {
      pinnedIndices.add(i);
    }
  }

  let runningKeptTokens = 0;
  for (const idx of pinnedIndices) {
    runningKeptTokens += itemTokens[idx].tokens;
  }

  // Walk newest-to-oldest among non-pinned messages: allocate remaining budget to keep, then summarize, then drop oldest
  const decisionByIdx = new Map<number, 'keep' | 'summarize' | 'drop'>();
  for (const idx of pinnedIndices) {
    decisionByIdx.set(idx, 'keep');
  }

  const summarizeTokenAllowance = Math.floor(softTokenBudget * 0.35);
  let summarizedRawTokens = 0;

  for (let i = itemTokens.length - 1; i >= 0; i--) {
    if (decisionByIdx.has(i)) continue;
    const it = itemTokens[i];
    if (runningKeptTokens + it.tokens <= softTokenBudget * 0.65) {
      runningKeptTokens += it.tokens;
      decisionByIdx.set(i, 'keep');
    } else if (summarizedRawTokens + it.tokens <= summarizeTokenAllowance * 4) {
      summarizedRawTokens += it.tokens;
      decisionByIdx.set(i, 'summarize');
    } else {
      decisionByIdx.set(i, 'drop');
    }
  }

  for (let i = 0; i < itemTokens.length; i++) {
    const d = decisionByIdx.get(i) ?? 'keep';
    if (d === 'keep') keep.push(itemTokens[i].id);
    else if (d === 'summarize') summarize.push(itemTokens[i].id);
    else drop.push(itemTokens[i].id);
  }

  return {
    keep,
    summarize,
    drop,
    totalTokensBefore,
    softTokenBudget,
    overBudgetTokens: Math.max(0, totalTokensBefore - softTokenBudget),
  };
}
