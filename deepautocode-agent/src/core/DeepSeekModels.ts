/**
 * DeepSeek V4 API model IDs, legacy aliases, thinking controls, peak pricing helpers.
 * Official catalog (2026): deepseek-flash + deepseek-v4-pro; chat/reasoner retired.
 */

export const DEEPSEEK_FLASH = 'deepseek-flash';
export const DEEPSEEK_V4_PRO = 'deepseek-v4-pro';
export const DEEPSEEK_AUTO = 'deepseek-auto';

export type DeepSeekApiModelId = typeof DEEPSEEK_FLASH | typeof DEEPSEEK_V4_PRO;
export type DeepSeekReasoningEffort = 'low' | 'high' | 'max';

export interface DeepSeekRequestControls {
  apiModelId: DeepSeekApiModelId;
  thinkingEnabled: boolean;
  reasoningEffort: DeepSeekReasoningEffort | null;
  /** True when the call should omit temperature (thinking mode). */
  isThinking: boolean;
}

const LEGACY_TO_FLASH = new Set([
  'deepseek-chat',
  'deepseek-v4-flash',
  'deepseek-v4-flash-vision-exp',
  'force-fast',
]);

const LEGACY_THINKING_ALIASES = new Set([
  'deepseek-reasoner',
  'force-reasoner',
]);

/** Map any UI / legacy id to a concrete API model id (not deepseek-auto). */
export function normalizeDeepSeekApiModelId(modelId: string): DeepSeekApiModelId {
  const id = String(modelId || '').trim();
  if (!id || id === DEEPSEEK_AUTO) return DEEPSEEK_FLASH;
  if (id === DEEPSEEK_V4_PRO || /v4-pro/i.test(id)) return DEEPSEEK_V4_PRO;
  if (LEGACY_TO_FLASH.has(id) || /flash|chat/i.test(id)) return DEEPSEEK_FLASH;
  if (LEGACY_THINKING_ALIASES.has(id) || /reasoner|r1/i.test(id)) return DEEPSEEK_FLASH;
  if (/deepseek/i.test(id)) return DEEPSEEK_FLASH;
  return DEEPSEEK_FLASH;
}

export function isDeepSeekModelId(modelId: string): boolean {
  return /deepseek/i.test(String(modelId || ''));
}

export function isLegacyReasonerAlias(modelId: string): boolean {
  const id = String(modelId || '').trim();
  return LEGACY_THINKING_ALIASES.has(id) || /reasoner|r1/i.test(id);
}

/**
 * Build OpenAI-compatible DeepSeek request controls for a routed turn.
 */
export function buildDeepSeekRequestControls(params: {
  apiModelId: string;
  thinkingEnabled: boolean;
  reasoningEffort?: DeepSeekReasoningEffort | null;
}): DeepSeekRequestControls {
  const apiModelId = normalizeDeepSeekApiModelId(params.apiModelId);
  const thinkingEnabled = Boolean(params.thinkingEnabled);
  const reasoningEffort = thinkingEnabled
    ? (params.reasoningEffort ?? 'high')
    : null;
  return {
    apiModelId,
    thinkingEnabled,
    reasoningEffort,
    isThinking: thinkingEnabled,
  };
}

/** OpenAI Chat Completions body extras for DeepSeek thinking mode. */
export function deepSeekChatBodyExtras(controls: DeepSeekRequestControls): Record<string, unknown> {
  const extras: Record<string, unknown> = {
    thinking: { type: controls.thinkingEnabled ? 'enabled' : 'disabled' },
  };
  if (controls.thinkingEnabled && controls.reasoningEffort) {
    extras.reasoning_effort = controls.reasoningEffort;
  }
  return extras;
}

/**
 * Peak hours: 01:00–04:00 and 06:00–10:00 UTC, Mon–Fri
 * (= Beijing 09:00–12:00 and 14:00–18:00), excluding weekends.
 * Chinese public holidays are treated as off-peak (not calendared here).
 */
export function isDeepSeekPeakHour(now: Date = new Date()): boolean {
  const day = now.getUTCDay(); // 0=Sun … 6=Sat
  if (day === 0 || day === 6) return false;
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const inMorning = minutes >= 1 * 60 && minutes < 4 * 60;
  const inAfternoon = minutes >= 6 * 60 && minutes < 10 * 60;
  return inMorning || inAfternoon;
}

/** CNY per 1M tokens (official CN pricing). */
export const DEEPSEEK_PRICE_CNY_PER_M = {
  flash: {
    offPeak: { cacheHit: 0.02, cacheMiss: 1.0, output: 4.0 },
    peak: { cacheHit: 0.04, cacheMiss: 2.0, output: 8.0 },
  },
  pro: {
    offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
    peak: { cacheHit: 0.3, cacheMiss: 9.0, output: 27.0 },
  },
} as const;

export function estimateDeepSeekTurnCostCny(params: {
  apiModelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  peak?: boolean;
}): number {
  const isPro = normalizeDeepSeekApiModelId(params.apiModelId) === DEEPSEEK_V4_PRO;
  const band = params.peak ?? isDeepSeekPeakHour() ? 'peak' : 'offPeak';
  const table = isPro
    ? DEEPSEEK_PRICE_CNY_PER_M.pro[band]
    : DEEPSEEK_PRICE_CNY_PER_M.flash[band];
  const cacheRead = Math.max(0, Number(params.cacheReadTokens ?? 0));
  const input = Math.max(0, Number(params.inputTokens ?? 0));
  const output = Math.max(0, Number(params.outputTokens ?? 0));
  const miss = Math.max(0, input - cacheRead);
  return (
    (cacheRead / 1_000_000) * table.cacheHit +
    (miss / 1_000_000) * table.cacheMiss +
    (output / 1_000_000) * table.output
  );
}

export function formatCostCny(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return '¥0';
  if (cost < 0.01) return `¥${cost.toFixed(4)}`;
  return `¥${cost.toFixed(3)}`;
}

export type AgentLoopPhase = 'plan' | 'exec' | 'verify';

/**
 * B2: Phase-aware Thinking budget grading:
 * - Planning / multi-file architecture -> 'high'
 * - Single-file edit / standard execution -> 'low'
 * - Debug / verify failure retry -> 'max'
 */
export function resolvePhaseReasoningEffort(
  phaseOrParams:
    | AgentLoopPhase
    | {
        phase: AgentLoopPhase;
        isRetryAfterFailure?: boolean;
        isDebugOrVerifyRetry?: boolean;
        consecutiveMistakes?: number;
        isArchitectureTask?: boolean;
      },
  options?: {
    isRetryAfterFailure?: boolean;
    isDebugOrVerifyRetry?: boolean;
    consecutiveMistakes?: number;
    isArchitectureTask?: boolean;
  }
): DeepSeekReasoningEffort {
  const phase = typeof phaseOrParams === 'string' ? phaseOrParams : phaseOrParams.phase;
  const opts = typeof phaseOrParams === 'string' ? options : phaseOrParams;
  if (
    opts?.isRetryAfterFailure ||
    opts?.isDebugOrVerifyRetry ||
    (typeof opts?.consecutiveMistakes === 'number' && opts.consecutiveMistakes > 0)
  ) {
    return 'max';
  }
  if (phase === 'plan' || opts?.isArchitectureTask) {
    return 'high';
  }
  if (phase === 'verify') {
    return 'high';
  }
  return 'low';
}

export interface NormalizedDeepSeekCacheUsage {
  inputTokens: number;
  outputTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  cacheWriteTokens: number;
  cacheHitRatio: number;
}

/**
 * B1: Normalize DeepSeek / OpenAI-compatible usage payload including
 * `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`.
 */
export function extractDeepSeekCacheUsage(usageRaw: unknown): NormalizedDeepSeekCacheUsage {
  const u = (usageRaw && typeof usageRaw === 'object' ? usageRaw : {}) as Record<string, any>;
  const inputTokens = Math.max(
    0,
    Number(u.prompt_tokens ?? u.input_tokens ?? u.inputTokens ?? 0) || 0
  );
  const outputTokens = Math.max(
    0,
    Number(u.completion_tokens ?? u.output_tokens ?? u.outputTokens ?? 0) || 0
  );
  const hitRaw =
    u.prompt_cache_hit_tokens ??
    u.cache_read_input_tokens ??
    u.cacheReadTokens ??
    u.prompt_tokens_details?.cached_tokens ??
    0;
  const promptCacheHitTokens = Math.max(0, Math.min(inputTokens || Number(hitRaw) || 0, Number(hitRaw) || 0));
  const missRaw = u.prompt_cache_miss_tokens;
  const promptCacheMissTokens =
    typeof missRaw === 'number' && Number.isFinite(missRaw)
      ? Math.max(0, missRaw)
      : Math.max(0, inputTokens - promptCacheHitTokens);
  const cacheWriteTokens = Math.max(
    0,
    Number(u.cache_creation_input_tokens ?? u.cacheWriteTokens ?? 0) || 0
  );
  const effectiveInput = Math.max(inputTokens, promptCacheHitTokens + promptCacheMissTokens);
  const cacheHitRatio =
    effectiveInput > 0 ? Number((promptCacheHitTokens / effectiveInput).toFixed(4)) : 0;

  return {
    inputTokens: effectiveInput,
    outputTokens,
    promptCacheHitTokens,
    promptCacheMissTokens,
    cacheWriteTokens,
    cacheHitRatio,
  };
}
