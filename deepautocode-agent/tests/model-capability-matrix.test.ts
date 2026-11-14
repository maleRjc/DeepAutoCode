import { describe, expect, it } from 'vitest';
import {
  adaptRequestBodyForModel,
  adaptToolsForModel,
  resolveModelCapability,
} from '../src/core/ModelCapabilityRegistry.js';

describe('ModelCapabilityMatrix', () => {
  it('resolves DeepSeek reasoner profile correctly', () => {
    const profile = resolveModelCapability('deepseek-reasoner');
    expect(profile.family).toBe('deepseek');
    expect(profile.thinkingSupport).toBe(true);
    expect(profile.contextWindow).toBe(128_000);
    expect(profile.reasoningField).toBe('reasoning_content');
  });

  it('resolves GLM-4 profile and clamps temperature to 0..1', () => {
    const profile = resolveModelCapability('glm-4-plus');
    expect(profile.family).toBe('glm');
    expect(profile.toolDialect).toBe('glm');
    expect(profile.temperatureClamping.max).toBe(1.0);

    const body = adaptRequestBodyForModel({
      modelId: 'glm-4-plus',
      body: { temperature: 1.5, max_tokens: 4096 },
    });
    expect(body.temperature).toBe(1.0);
    expect(body.max_tokens).toBe(4096);
  });

  it('adapts tools for GLM family by trimming schema descriptions', () => {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'read_files',
          description:
            'Read one or more files in the workspace with optional start_line and end_line (1-based inclusive). Can read multiple files in a single call.',
          parameters: {
            type: 'object',
            properties: {
              files: {
                type: 'array',
                description: 'List of files to read with optional line ranges for deep analysis',
                items: { type: 'string' },
              },
            },
          },
        },
      },
    ];

    const adapted = adaptToolsForModel(tools, 'glm-4');
    expect(adapted[0].function.description.length).toBeLessThanOrEqual(96);
    // Parameters descriptions should also be trimmed
    const paramDesc = adapted[0].function.parameters.properties.files.description;
    expect(paramDesc.length).toBeLessThanOrEqual(44);
  });

  it('handles OpenAI o1/o3 max_completion_tokens and thinking omission', () => {
    const profile = resolveModelCapability('o1-mini');
    expect(profile.family).toBe('openai');
    expect(profile.maxTokensField).toBe('max_completion_tokens');

    const body = adaptRequestBodyForModel({
      modelId: 'o1-mini',
      body: { temperature: 0.7, max_tokens: 8000 },
      isThinking: true,
    });
    expect(body.max_completion_tokens).toBe(8000);
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined(); // Omitted when thinking
  });

  it('resolves Qwen and Claude profiles', () => {
    const qwen = resolveModelCapability('qwen-max');
    expect(qwen.family).toBe('qwen');
    expect(qwen.contextWindow).toBe(32_768);

    const claude = resolveModelCapability('claude-3-5-sonnet-20241022');
    expect(claude.family).toBe('claude');
    expect(claude.contextWindow).toBe(200_000);
    expect(claude.promptCaching).toBe(true);
  });
});
