/**
 * Model Capability & Compatibility Matrix
 * Inspired by OpenCode's models-dev & model-resolver.
 * Provides fine-grained capability profiles, parameter adapters, and tool schema sanitization
 * for diverse open-source and commercial LLM families (DeepSeek, GLM, Qwen, Claude, OpenAI).
 */

import {
  trimToolDescriptionForGlm,
  trimToolDescriptionForGlmAggressive,
  trimToolJsonSchemaForGlm,
} from './GlmToolSchema.js';
import {
  isDeepSeekModelId,
  normalizeDeepSeekApiModelId,
  deepSeekChatBodyExtras,
  buildDeepSeekRequestControls,
  type DeepSeekReasoningEffort,
} from './DeepSeekModels.js';

export type ModelFamily = 'deepseek' | 'glm' | 'qwen' | 'claude' | 'openai' | 'custom';

export type ToolDialect = 'standard' | 'glm' | 'deepseek' | 'compact';

export interface ModelCapabilityProfile {
  modelId: string;
  family: ModelFamily;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsStreaming: boolean;
  supportsNativeTools: boolean;
  toolDialect: ToolDialect;
  reasoningField?: 'reasoning_content' | 'thinking';
  maxTokensField: 'max_tokens' | 'max_completion_tokens';
  temperatureClamping: {
    min?: number;
    max?: number;
    omitWhenThinking?: boolean;
    defaultTemperature?: number;
  };
  thinkingSupport: boolean;
  promptCaching: boolean;
}

const DEFAULT_PROFILE: ModelCapabilityProfile = {
  modelId: 'unknown',
  family: 'custom',
  displayName: 'Custom Model',
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
  supportsStreaming: true,
  supportsNativeTools: true,
  toolDialect: 'standard',
  reasoningField: undefined,
  maxTokensField: 'max_tokens',
  temperatureClamping: { min: 0.0, max: 2.0, omitWhenThinking: false },
  thinkingSupport: false,
  promptCaching: false,
};

const KNOWN_PROFILES: Record<string, Partial<ModelCapabilityProfile>> = {
  // DeepSeek Family
  'deepseek-chat': {
    family: 'deepseek',
    displayName: 'DeepSeek Chat',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    toolDialect: 'deepseek',
    thinkingSupport: false,
    promptCaching: true,
  },
  'deepseek-flash': {
    family: 'deepseek',
    displayName: 'DeepSeek Flash',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    toolDialect: 'deepseek',
    thinkingSupport: false,
    promptCaching: true,
  },
  'deepseek-v4-pro': {
    family: 'deepseek',
    displayName: 'DeepSeek V4 Pro',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    toolDialect: 'deepseek',
    thinkingSupport: true,
    reasoningField: 'reasoning_content',
    promptCaching: true,
    temperatureClamping: { omitWhenThinking: true },
  },
  'deepseek-reasoner': {
    family: 'deepseek',
    displayName: 'DeepSeek Reasoner (R1)',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    toolDialect: 'deepseek',
    thinkingSupport: true,
    reasoningField: 'reasoning_content',
    promptCaching: true,
    temperatureClamping: { omitWhenThinking: true },
  },

  // GLM Family (Zhipu AI)
  'glm-4-plus': {
    family: 'glm',
    displayName: 'GLM-4 Plus',
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    toolDialect: 'glm',
    thinkingSupport: false,
    promptCaching: false,
    temperatureClamping: { min: 0.1, max: 1.0, defaultTemperature: 0.7 },
  },
  'glm-4-air': {
    family: 'glm',
    displayName: 'GLM-4 Air',
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    toolDialect: 'glm',
    thinkingSupport: false,
    promptCaching: false,
    temperatureClamping: { min: 0.1, max: 1.0, defaultTemperature: 0.7 },
  },
  'glm-4-flash': {
    family: 'glm',
    displayName: 'GLM-4 Flash',
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    toolDialect: 'glm',
    thinkingSupport: false,
    promptCaching: false,
    temperatureClamping: { min: 0.1, max: 1.0, defaultTemperature: 0.7 },
  },
  'glm-4': {
    family: 'glm',
    displayName: 'GLM-4 Standard',
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    toolDialect: 'glm',
    thinkingSupport: false,
    promptCaching: false,
    temperatureClamping: { min: 0.1, max: 1.0, defaultTemperature: 0.7 },
  },

  // Qwen Family (Alibaba Cloud)
  'qwen-2.5-coder': {
    family: 'qwen',
    displayName: 'Qwen 2.5 Coder',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    toolDialect: 'standard',
    thinkingSupport: false,
    promptCaching: true,
  },
  'qwen-max': {
    family: 'qwen',
    displayName: 'Qwen Max',
    contextWindow: 32_768,
    maxOutputTokens: 8_192,
    toolDialect: 'standard',
    thinkingSupport: false,
    promptCaching: true,
  },
  'qwen-plus': {
    family: 'qwen',
    displayName: 'Qwen Plus',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    toolDialect: 'standard',
    thinkingSupport: false,
    promptCaching: true,
  },
  'qwq-32b-preview': {
    family: 'qwen',
    displayName: 'QwQ 32B Preview',
    contextWindow: 32_768,
    maxOutputTokens: 8_192,
    toolDialect: 'standard',
    thinkingSupport: true,
    reasoningField: 'reasoning_content',
    temperatureClamping: { omitWhenThinking: true },
  },

  // Anthropic Claude
  'claude-3-5-sonnet': {
    family: 'claude',
    displayName: 'Claude 3.5 Sonnet',
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    toolDialect: 'standard',
    thinkingSupport: true,
    reasoningField: 'thinking',
    promptCaching: true,
  },

  // OpenAI
  'gpt-4o': {
    family: 'openai',
    displayName: 'GPT-4o',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    toolDialect: 'standard',
    maxTokensField: 'max_tokens',
    thinkingSupport: false,
    promptCaching: true,
  },
  'o1': {
    family: 'openai',
    displayName: 'OpenAI o1',
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    toolDialect: 'standard',
    maxTokensField: 'max_completion_tokens',
    thinkingSupport: true,
    temperatureClamping: { omitWhenThinking: true },
    promptCaching: true,
  },
  'o3-mini': {
    family: 'openai',
    displayName: 'OpenAI o3-mini',
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    toolDialect: 'standard',
    maxTokensField: 'max_completion_tokens',
    thinkingSupport: true,
    temperatureClamping: { omitWhenThinking: true },
    promptCaching: true,
  },
};

/**
 * Resolve full capability profile for any given modelId.
 */
export function resolveModelCapability(modelId: string): ModelCapabilityProfile {
  const rawId = String(modelId || '').trim();
  const lower = rawId.toLowerCase();

  // 1. Direct match in known profiles
  if (KNOWN_PROFILES[lower]) {
    return { ...DEFAULT_PROFILE, modelId: rawId, ...KNOWN_PROFILES[lower] };
  }

  // 2. DeepSeek matching heuristics
  if (isDeepSeekModelId(lower)) {
    const canonical = normalizeDeepSeekApiModelId(lower);
    const base = KNOWN_PROFILES[canonical] || KNOWN_PROFILES['deepseek-flash'];
    return {
      ...DEFAULT_PROFILE,
      modelId: rawId,
      family: 'deepseek',
      displayName: rawId,
      toolDialect: 'deepseek',
      promptCaching: true,
      ...base,
    };
  }

  // 3. GLM matching heuristics
  if (/glm/i.test(lower)) {
    return {
      ...DEFAULT_PROFILE,
      modelId: rawId,
      family: 'glm',
      displayName: rawId,
      contextWindow: 128_000,
      maxOutputTokens: 4_096,
      toolDialect: 'glm',
      temperatureClamping: { min: 0.1, max: 1.0, defaultTemperature: 0.7 },
    };
  }

  // 4. Qwen matching heuristics
  if (/qwen|qwq/i.test(lower)) {
    const isReasoning = /qwq|r1/i.test(lower);
    return {
      ...DEFAULT_PROFILE,
      modelId: rawId,
      family: 'qwen',
      displayName: rawId,
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      toolDialect: 'standard',
      thinkingSupport: isReasoning,
      reasoningField: isReasoning ? 'reasoning_content' : undefined,
      temperatureClamping: isReasoning ? { omitWhenThinking: true } : { min: 0.0, max: 2.0 },
    };
  }

  // 5. Claude matching heuristics
  if (/claude/i.test(lower)) {
    return {
      ...DEFAULT_PROFILE,
      modelId: rawId,
      family: 'claude',
      displayName: rawId,
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
      promptCaching: true,
    };
  }

  // 6. OpenAI o-series heuristics
  if (/^o[13]/i.test(lower)) {
    return {
      ...DEFAULT_PROFILE,
      modelId: rawId,
      family: 'openai',
      displayName: rawId,
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      maxTokensField: 'max_completion_tokens',
      thinkingSupport: true,
      temperatureClamping: { omitWhenThinking: true },
    };
  }

  return { ...DEFAULT_PROFILE, modelId: rawId };
}

/**
 * Adapt OpenAI-format tool definitions for specific model families.
 * For GLM: compresses tool descriptions and schemas to avoid prompt bloat / parsing errors.
 */
export function adaptToolsForModel(
  tools: any[],
  modelId: string,
  aggressive: boolean = false
): any[] {
  if (!Array.isArray(tools) || tools.length === 0) return tools;
  const profile = resolveModelCapability(modelId);

  if (profile.toolDialect === 'glm') {
    return tools.map((tool) => {
      if (!tool || tool.type !== 'function' || !tool.function) return tool;
      const fn = tool.function;
      const desc = aggressive
        ? trimToolDescriptionForGlmAggressive(fn.description)
        : trimToolDescriptionForGlm(fn.description);
      const parameters = trimToolJsonSchemaForGlm(fn.parameters);
      return {
        ...tool,
        function: {
          ...fn,
          description: desc,
          parameters,
        },
      };
    });
  }

  return tools;
}

/**
 * Adapt HTTP request payload for model-specific quirks:
 * - Omits temperature when model is in thinking mode
 * - Maps max_tokens to max_completion_tokens when required
 * - Clamps temperature to allowed range
 * - Adds DeepSeek thinking body extras
 */
export function adaptRequestBodyForModel(params: {
  modelId: string;
  body: Record<string, unknown>;
  isThinking?: boolean;
  reasoningEffort?: DeepSeekReasoningEffort | null;
}): Record<string, unknown> {
  const { modelId, isThinking, reasoningEffort } = params;
  const profile = resolveModelCapability(modelId);
  const out: Record<string, unknown> = { ...params.body };

  // 1. Max tokens field alignment
  if (profile.maxTokensField === 'max_completion_tokens') {
    if ('max_tokens' in out && !('max_completion_tokens' in out)) {
      out.max_completion_tokens = out.max_tokens;
      delete out.max_tokens;
    }
  } else {
    if ('max_completion_tokens' in out && !('max_tokens' in out)) {
      out.max_tokens = out.max_completion_tokens;
      delete out.max_completion_tokens;
    }
  }

  // 2. Temperature clamping & thinking omission
  const thinkingActive = Boolean(isThinking && profile.thinkingSupport);
  if (thinkingActive && profile.temperatureClamping.omitWhenThinking) {
    delete out.temperature;
    delete out.top_p;
  } else if (typeof out.temperature === 'number') {
    const min = profile.temperatureClamping.min ?? 0.0;
    const max = profile.temperatureClamping.max ?? 2.0;
    out.temperature = Math.max(min, Math.min(max, out.temperature));
  }

  // 3. DeepSeek extras
  if (profile.family === 'deepseek') {
    const controls = buildDeepSeekRequestControls({
      apiModelId: modelId,
      thinkingEnabled: thinkingActive,
      reasoningEffort: reasoningEffort ?? (thinkingActive ? 'high' : null),
    });
    const extras = deepSeekChatBodyExtras(controls);
    Object.assign(out, extras);
  }

  return out;
}

