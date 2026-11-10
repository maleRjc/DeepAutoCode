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

export function isGlmModelId(modelId: string, providerId?: string): boolean {
  return (
    providerId === 'glm' ||
    /\bglm[-_0-9a-z.]*/i.test(String(modelId || ''))
  );
}

/** HTTP timeout for OpenAI-compatible chat/completions (tool-calling turns). */
export function resolveLlmPostTimeoutMs(params: {
  isReasonerModel: boolean;
  isGlmModel: boolean;
  isLocalInference: boolean;
  isSshMirrorWorkspace?: boolean;
}): number {
  if (params.isGlmModel) {
    return params.isSshMirrorWorkspace ? 360_000 : 300_000;
  }
  if (params.isReasonerModel || params.isLocalInference) {
    return 240_000;
  }
  return 120_000;
}

export interface GlmRequestControls {
  enableThinking: boolean;
  temperature: number;
  topP: number;
  chatTemplateKwargs: { enable_thinking: boolean };
  reason: string;
}

/**
 * Adaptive Thinking Gating & NVFP4 Sampling Controls for GLM-5.3-Flash / GLM models.
 * - Enables CoT thinking on PLAN phase, self-heal retries (`hasFailure` / `selfHealCount > 0`),
 *   `max` reasoning effort, or turn 1 with complex architectural/debugging prompts.
 * - Disables thinking on standard EXEC tool-calling turns and VERIFY turns for 5-10x faster execution
 *   with deterministic sampling (`temperature: 0.1, top_p: 0.85`).
 */
export function resolveGlmRequestControls(params: {
  modelId: string;
  providerId?: string;
  phase?: AgentLoopPhase | string;
  reasoningEffort?: DeepSeekReasoningEffort | null;
  turnIndex?: number;
  selfHealCount?: number;
  hasFailure?: boolean;
  userPrompt?: string;
  /** Compile / build-failure fix loop — prefer fast tool turns without CoT. */
  compileRemediationTurn?: boolean;
  /** When true, model may emit tool_calls this turn (exec). */
  toolCallingTurn?: boolean;
}): GlmRequestControls {
  const phase = params.phase ?? 'exec';
  const hasFailure = Boolean(params.hasFailure || (params.selfHealCount && params.selfHealCount > 0));
  const userPrompt = String(params.userPrompt || '');
  const wantsFastImplementation =
    (/(?:实现|编写|新增|添加|创建|修复|修改|落地|apply|implement)/i.test(userPrompt) ||
      /\b(?:error:|fatal error:|undeclared|should return a value)\b/i.test(userPrompt)) &&
    !/根因|架构|为什么|死锁|并发|排查|debug|root\s*cause/i.test(userPrompt);
  const isComplexFirstTurn =
    !wantsFastImplementation &&
    (params.turnIndex ?? 1) === 1 &&
    /架构|重构|死锁|并发|原因|为什么|根因|排查|debug|root\s*cause|architect|deadlock|race\s*condition/i.test(
      userPrompt
    );

  let enableThinking = false;
  let reason = 'exec-fast-tool-calling';
  if (
    params.compileRemediationTurn &&
    phase !== 'plan' &&
    (params.toolCallingTurn !== false || phase === 'exec')
  ) {
    enableThinking = false;
    reason = 'compile-remediation-fast';
  } else if (phase === 'plan') {
    enableThinking = true;
    reason = 'plan-phase';
  } else if (params.reasoningEffort === 'max') {
    enableThinking = true;
    reason = 'reasoning-effort-max';
  } else if (hasFailure && !wantsFastImplementation) {
    enableThinking = true;
    reason = 'self-heal-diagnosis';
  } else if (isComplexFirstTurn && phase !== 'verify') {
    enableThinking = true;
    reason = 'complex-first-turn';
  }

  return {
    enableThinking,
    temperature: enableThinking ? 0.6 : 0.1,
    topP: enableThinking ? 0.95 : 0.85,
    chatTemplateKwargs: { enable_thinking: enableThinking },
    reason,
  };
}

/**
 * Dynamic context token budget based on model family:
 * - GLM-5.3-Flash / 128K context models: 96,000 tokens (leaves ~32K headroom for output & system/tools within 131,072 max_model_len)
 * - DeepSeek 1M context models: 180,000 tokens (or configured budget)
 */
/** OpenAI `max_tokens` for chat completions (tool-calling turns). */
export function resolveNestedLlmMaxTokens(params: {
  modelId: string;
  providerId?: string;
  catalogMaxOutput?: number | null;
  role: 'subagent' | 'decompose' | 'synthesize';
}): number {
  const main = resolveModelMaxOutputTokens({
    modelId: params.modelId,
    providerId: params.providerId,
    catalogMaxOutput: params.catalogMaxOutput,
  });
  const glm = isGlmModelId(params.modelId, params.providerId);
  const ratio =
    params.role === 'subagent'
      ? glm
        ? 0.5
        : 0.35
      : params.role === 'decompose'
        ? glm
          ? 0.1
          : 0.06
        : glm
          ? 0.2
          : 0.12;
  const floor =
    params.role === 'subagent'
      ? glm
        ? 3_500
        : 1_500
      : params.role === 'decompose'
        ? glm
          ? 900
          : 400
        : glm
          ? 1_800
          : 500;
  return Math.min(main, Math.max(floor, Math.floor(main * ratio)));
}

export function resolveModelMaxOutputTokens(params: {
  modelId: string;
  providerId?: string;
  catalogMaxOutput?: number | null;
  fallback?: number;
}): number {
  const catalog = Number(params.catalogMaxOutput || 0);
  if (catalog > 0) {
    return Math.min(Math.max(catalog, 1024), 65_536);
  }
  if (isGlmModelId(params.modelId, params.providerId)) {
    if (/5\.3|z1/i.test(params.modelId)) {
      return 16_384;
    }
    return 8_192;
  }
  if (/reasoner|pro|r1|qwq/i.test(params.modelId)) {
    return 16_384;
  }
  return Number(params.fallback) > 0 ? Number(params.fallback) : 8_192;
}

export function resolveModelContextBudget(params: {
  modelId: string;
  providerId?: string;
  configuredBudget?: number | null;
}): number {
  if (isGlmModelId(params.modelId, params.providerId)) {
    const cfg = Number(params.configuredBudget || 0);
    return cfg > 0 && cfg <= 110_000 ? cfg : 96_000;
  }
  return Number(params.configuredBudget ?? 180_000) || 180_000;
}

/**
 * Resilient JSON parser for LLM tool-call arguments (handles 4-bit NVFP4 quantization glitches
 * such as markdown code fences, trailing commas before `}`/`]`, or missing closing `}`).
 */
export function parseToolArgumentsResilient(rawArgs: string): {
  ok: boolean;
  parsed: Record<string, unknown>;
  repairedText: string;
} {
  const trimmed = String(rawArgs || '').trim();
  if (!trimmed) {
    return { ok: true, parsed: {}, repairedText: '{}' };
  }
  try {
    const direct = JSON.parse(trimmed);
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
      return { ok: true, parsed: direct as Record<string, unknown>, repairedText: trimmed };
    }
  } catch {
    // try lightweight repairs below
  }

  let candidate = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  // Remove trailing commas before closing brace/bracket: `,"}` -> `"}`
  candidate = candidate.replace(/,\s*([}\]])/g, '$1');

  try {
    const obj = JSON.parse(candidate);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      return {
        ok: true,
        parsed: obj as Record<string, unknown>,
        repairedText: JSON.stringify(obj),
      };
    }
  } catch {
    // If missing a single closing `}` at the end, try appending `}`
    if (candidate.startsWith('{') && !candidate.endsWith('}')) {
      for (const suffix of ['}', '"}', '"\n}']) {
        try {
          const obj = JSON.parse(candidate + suffix);
          if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
            return {
              ok: true,
              parsed: obj as Record<string, unknown>,
              repairedText: JSON.stringify(obj),
            };
          }
        } catch {
          // continue
        }
      }
    }
  }

  return { ok: false, parsed: {}, repairedText: trimmed };
}
