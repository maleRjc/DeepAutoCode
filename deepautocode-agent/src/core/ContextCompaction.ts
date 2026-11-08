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
  /** Estimated tool-result tokens in the conversation */
  estimatedToolTokens: number;
  /** 0-1 fill ratio when a budget is known; otherwise based on soft caps */
  fillRatio: number;
  reason: string;
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
  if (budget) {
    fillRatio = Math.min(1, Math.max(used / budget, estimatedToolTokens / Math.max(budget * 0.6, 1)));
  } else {
    // Soft ladders without an explicit budget
    if (toolChars >= 140_000) fillRatio = 0.95;
    else if (toolChars >= 80_000) fillRatio = 0.75;
    else if (toolChars >= 36_000) fillRatio = 0.55;
    else fillRatio = toolChars / 36_000;
  }

  if (fillRatio < 0.45 && toolChars < 36_000) {
    return {
      shouldCompact: false,
      keepRecentMessages: 4,
      minCharsToSummarize: 1600,
      summaryMaxChars: 1800,
      estimatedToolTokens,
      fillRatio,
      reason: 'below-compaction-threshold',
    };
  }

  if (fillRatio >= 0.85 || toolChars >= 140_000) {
    return {
      shouldCompact: true,
      keepRecentMessages: 2,
      minCharsToSummarize: 400,
      summaryMaxChars: 900,
      estimatedToolTokens,
      fillRatio,
      reason: 'critical-context-pressure',
    };
  }
  if (fillRatio >= 0.65 || toolChars >= 80_000) {
    return {
      shouldCompact: true,
      keepRecentMessages: 3,
      minCharsToSummarize: 800,
      summaryMaxChars: 1200,
      estimatedToolTokens,
      fillRatio,
      reason: 'high-context-pressure',
    };
  }
  return {
    shouldCompact: true,
    keepRecentMessages: 4,
    minCharsToSummarize: 1600,
    summaryMaxChars: 1800,
    estimatedToolTokens,
    fillRatio,
    reason: 'moderate-context-pressure',
  };
}
