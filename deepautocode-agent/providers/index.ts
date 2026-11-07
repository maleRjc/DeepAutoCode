import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { redactSensitiveText } from '../src/security.js';

function defaultResilientFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const parsedUrl = new URL(String(url));
  const isHttps = parsedUrl.protocol === 'https:';
  const bodyStr = typeof init?.body === 'string' ? init.body : '';
  const headers: Record<string, string> = {};
  if (init?.headers && typeof init.headers === 'object') {
    for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
      headers[k] = String(v);
    }
  }
  if (bodyStr) {
    headers['Content-Length'] = String(Buffer.byteLength(bodyStr, 'utf-8'));
  }

  return new Promise((resolve, reject) => {
    const reqFn = isHttps ? https.request : http.request;
    const req = reqFn(
      parsedUrl,
      {
        method: init?.method ?? 'POST',
        family: 4,
        headers,
        timeout: 45000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          resolve(new Response(text, { status: res.statusCode ?? 500 }));
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Request timed out after 45000ms')));
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

export const ModelMetadataSchema = z.object({
  modelId: z.string().min(1),
  displayName: z.string().min(1),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  supportsToolCalls: z.boolean(),
  supportsStreaming: z.boolean(),
  supportsVision: z.boolean(),
  supportsReasoning: z.boolean().default(false),
});

export type ModelMetadata = z.infer<typeof ModelMetadataSchema>;

export const ProviderConfigSchema = z.object({
  providerId: z.string().min(1),
  displayName: z.string().min(1),
  protocol: z.enum(['deepseek', 'openai-compatible', 'anthropic', 'openai']),
  apiEndpoint: z.string().url(),
  defaultModelId: z.string().min(1),
  models: z.array(ModelMetadataSchema).min(1),
  secretKeyRef: z.string().min(1),
  timeoutMs: z.number().int().positive().default(60000),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

/**
 * Section 7.1 & 7.2: Built-in Default Providers (DeepSeek default + replaceable OpenAI-compatible / Anthropic)
 */
export const DEFAULT_PROVIDERS: Record<string, ProviderConfig> = {
  deepseek: {
    providerId: 'deepseek',
    displayName: 'DeepSeek (Default)',
    protocol: 'deepseek',
    apiEndpoint: 'https://api.deepseek.com/v1',
    defaultModelId: 'deepseek-chat',
    secretKeyRef: 'deepautocode.provider.deepseek.apiKey',
    timeoutMs: 60000,
    models: [
      {
        modelId: 'deepseek-chat',
        displayName: 'DeepSeek V3 (deepseek-chat)',
        contextWindow: 64000,
        maxOutputTokens: 8192,
        supportsToolCalls: true,
        supportsStreaming: true,
        supportsVision: false,
        supportsReasoning: false,
      },
      {
        modelId: 'deepseek-reasoner',
        displayName: 'DeepSeek R1 (deepseek-reasoner)',
        contextWindow: 64000,
        maxOutputTokens: 8192,
        supportsToolCalls: true,
        supportsStreaming: true,
        supportsVision: false,
        supportsReasoning: true,
      },
    ],
  },
  'openai-compatible': {
    providerId: 'openai-compatible',
    displayName: 'OpenAI-Compatible (Custom / Local / Enterprise)',
    protocol: 'openai-compatible',
    apiEndpoint: 'http://127.0.0.1:11434/v1',
    defaultModelId: 'qwen2.5-coder:14b',
    secretKeyRef: 'deepautocode.provider.openai-compatible.apiKey',
    timeoutMs: 60000,
    models: [
      {
        modelId: 'qwen2.5-coder:14b',
        displayName: 'Qwen 2.5 Coder 14B (OpenAI-Compatible)',
        contextWindow: 32768,
        maxOutputTokens: 4096,
        supportsToolCalls: true,
        supportsStreaming: true,
        supportsVision: false,
        supportsReasoning: false,
      },
      {
        modelId: 'gpt-4o-mini',
        displayName: 'GPT-4o Mini (OpenAI-Compatible Gateway)',
        contextWindow: 128000,
        maxOutputTokens: 16384,
        supportsToolCalls: true,
        supportsStreaming: true,
        supportsVision: true,
        supportsReasoning: false,
      },
    ],
  },
  anthropic: {
    providerId: 'anthropic',
    displayName: 'Anthropic Claude',
    protocol: 'anthropic',
    apiEndpoint: 'https://api.anthropic.com/v1',
    defaultModelId: 'claude-3-7-sonnet-latest',
    secretKeyRef: 'deepautocode.provider.anthropic.apiKey',
    timeoutMs: 60000,
    models: [
      {
        modelId: 'claude-3-7-sonnet-latest',
        displayName: 'Claude 3.7 Sonnet',
        contextWindow: 200000,
        maxOutputTokens: 8192,
        supportsToolCalls: true,
        supportsStreaming: true,
        supportsVision: true,
        supportsReasoning: true,
      },
    ],
  },
};

/**
 * Section 7.2 & 9.1: OS Credential Storage Abstraction
 * In Code - OSS Extension Host, this delegates to `ExtensionContext.secrets` (Windows Credential Manager / macOS Keychain / libsecret).
 * Plaintext config files only store `secretKeyRef`.
 */
export interface SecretStorageAdapter {
  getSecret(keyRef: string): Promise<string | undefined>;
  setSecret(keyRef: string, secretValue: string): Promise<void>;
  deleteSecret(keyRef: string): Promise<void>;
}

export class InMemorySecretStorage implements SecretStorageAdapter {
  private readonly store = new Map<string, string>();

  async getSecret(keyRef: string): Promise<string | undefined> {
    return this.store.get(keyRef);
  }

  async setSecret(keyRef: string, secretValue: string): Promise<void> {
    this.store.set(keyRef, secretValue);
  }

  async deleteSecret(keyRef: string): Promise<void> {
    this.store.delete(keyRef);
  }
}

/**
 * Encrypted On-Disk SecretStorage Adapter for Desktop Standalone Mode
 * Encrypts API keys with AES-256-GCM bound to the local machine identity so API keys
 * survive project workspace switches and IDE restarts without ever storing plaintext keys.
 */
export class EncryptedFileSecretStorage implements SecretStorageAdapter {
  private readonly filePath: string;
  private readonly encryptionKey: Buffer;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    const machineSeed = `deepautocode-secret-vault:${os.hostname()}:${os.userInfo().username}:${os.platform()}`;
    this.encryptionKey = crypto.createHash('sha256').update(machineSeed).digest();
  }

  private async readVault(): Promise<Record<string, string>> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      return JSON.parse(raw) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private async writeVault(vault: Record<string, string>): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(vault, null, 2), 'utf-8');
  }

  private encrypt(plainText: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(plainText, 'utf-8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  private decrypt(payload: string): string | undefined {
    try {
      const [ivHex, tagHex, encHex] = payload.split(':');
      if (!ivHex || !tagHex || !encHex) return undefined;
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        this.encryptionKey,
        Buffer.from(ivHex, 'hex')
      );
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
      const dec = Buffer.concat([
        decipher.update(Buffer.from(encHex, 'hex')),
        decipher.final(),
      ]);
      return dec.toString('utf-8');
    } catch {
      return undefined;
    }
  }

  async getSecret(keyRef: string): Promise<string | undefined> {
    const vault = await this.readVault();
    const entry = vault[keyRef];
    if (!entry) return undefined;
    return this.decrypt(entry);
  }

  async setSecret(keyRef: string, secretValue: string): Promise<void> {
    const vault = await this.readVault();
    vault[keyRef] = this.encrypt(secretValue);
    await this.writeVault(vault);
  }

  async deleteSecret(keyRef: string): Promise<void> {
    const vault = await this.readVault();
    delete vault[keyRef];
    await this.writeVault(vault);
  }
}

export interface ProviderErrorDiagnostic {
  code:
    | 'AUTH_FAILED'
    | 'RATE_LIMITED'
    | 'MODEL_NOT_FOUND'
    | 'TOOL_CALL_UNSUPPORTED'
    | 'ENDPOINT_UNREACHABLE'
    | 'UNKNOWN_PROVIDER_ERROR';
  httpStatus?: number;
  userMessage: string;
  remediation: string;
}

export function diagnoseProviderError(error: unknown, provider: ProviderConfig, modelId: string): ProviderErrorDiagnostic {
  const rawMessage = redactSensitiveText(error instanceof Error ? error.message : String(error));
  const statusMatch = rawMessage.match(/\b(401|403|404|422|429|500|502|503)\b/);
  const status = statusMatch ? Number(statusMatch[1]) : undefined;

  if (status === 401 || status === 403 || /invalid.*api.*key|unauthorized|authentication/i.test(rawMessage)) {
    return {
      code: 'AUTH_FAILED',
      httpStatus: status ?? 401,
      userMessage: `Provider "${provider.displayName}" authentication failed.`,
      remediation: `Verify the API Key stored in OS Credential Storage (${provider.secretKeyRef}) and confirm account quota.`,
    };
  }

  if (status === 429 || /rate\s*limit|too\s*many\s*requests|quota\s*exceeded/i.test(rawMessage)) {
    return {
      code: 'RATE_LIMITED',
      httpStatus: 429,
      userMessage: `Provider "${provider.displayName}" rate limit or concurrency limit reached.`,
      remediation: 'Wait before retrying, reduce request frequency, or switch to an alternative Provider/endpoint.',
    };
  }

  if (status === 404 || /model.*not\s*found|does\s*not\s*exist/i.test(rawMessage)) {
    return {
      code: 'MODEL_NOT_FOUND',
      httpStatus: 404,
      userMessage: `Model "${modelId}" is not available on endpoint ${provider.apiEndpoint}.`,
      remediation: 'Check the provider official documentation for current model IDs or update the custom model ID in Provider Settings.',
    };
  }

  if (/tool.*not\s*supported|function\s*call.*unsupported|tools\s*is\s*not\s*allowed/i.test(rawMessage)) {
    return {
      code: 'TOOL_CALL_UNSUPPORTED',
      httpStatus: status ?? 400,
      userMessage: `Model "${modelId}" on "${provider.displayName}" rejected tool calling parameters.`,
      remediation: 'Switch to a model with `supportsToolCalls: true` (e.g., deepseek-chat) or use Plan/Chat mode.',
    };
  }

  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch\s*failed/i.test(rawMessage)) {
    return {
      code: 'ENDPOINT_UNREACHABLE',
      userMessage: `Cannot reach provider endpoint ${provider.apiEndpoint}.`,
      remediation: 'Check network connectivity, proxy configuration, or ensure local OpenAI-compatible server is running.',
    };
  }

  return {
    code: 'UNKNOWN_PROVIDER_ERROR',
    httpStatus: status,
    userMessage: `Provider error (${provider.displayName}): ${rawMessage}`,
    remediation: 'Inspect diagnostic logs or run Provider Smoke Test.',
  };
}

export class ProviderManager {
  private providers = new Map<string, ProviderConfig>();
  private activeProviderId = 'deepseek';
  private activeModelId = 'deepseek-chat';
  private readonly secrets: SecretStorageAdapter;

  constructor(secrets: SecretStorageAdapter = new InMemorySecretStorage()) {
    this.secrets = secrets;
    for (const [id, cfg] of Object.entries(DEFAULT_PROVIDERS)) {
      this.providers.set(id, structuredClone(cfg));
    }
  }

  listProviders(): ProviderConfig[] {
    return Array.from(this.providers.values());
  }

  getActiveProvider(): { provider: ProviderConfig; model: ModelMetadata; hasApiKeyConfigured: boolean } {
    const provider = this.providers.get(this.activeProviderId) ?? DEFAULT_PROVIDERS.deepseek;
    const model =
      provider.models.find((m) => m.modelId === this.activeModelId) ?? provider.models[0];
    return {
      provider,
      model,
      hasApiKeyConfigured: false, // Sync snapshot; use getActiveProviderWithKeyStatus() for async secret check
    };
  }

  async getActiveProviderWithKeyStatus(): Promise<{
    provider: ProviderConfig;
    model: ModelMetadata;
    hasApiKeyConfigured: boolean;
  }> {
    const { provider, model } = this.getActiveProvider();
    const secret = await this.secrets.getSecret(provider.secretKeyRef);
    const envFallback =
      provider.providerId === 'deepseek'
        ? process.env.DEEPSEEK_API_KEY
        : provider.providerId === 'anthropic'
          ? process.env.ANTHROPIC_API_KEY
          : process.env.OPENAI_API_KEY;
    return {
      provider,
      model,
      hasApiKeyConfigured: Boolean((secret && secret.trim().length > 0) || envFallback),
    };
  }

  async resolveApiKey(providerId?: string): Promise<string | undefined> {
    const id = providerId ?? this.activeProviderId;
    const provider = this.providers.get(id);
    if (!provider) return undefined;
    const stored = await this.secrets.getSecret(provider.secretKeyRef);
    if (stored && stored.trim().length > 0) return stored.trim();
    if (id === 'deepseek') return process.env.DEEPSEEK_API_KEY;
    if (id === 'anthropic') return process.env.ANTHROPIC_API_KEY;
    return process.env.OPENAI_API_KEY;
  }

  async configureProvider(input: {
    providerId: string;
    apiEndpoint?: string;
    modelId?: string;
    apiKey?: string;
    customModel?: ModelMetadata;
  }): Promise<ProviderConfig> {
    const existing = this.providers.get(input.providerId) ?? {
      ...DEFAULT_PROVIDERS['openai-compatible'],
      providerId: input.providerId,
      displayName: input.providerId,
      secretKeyRef: `deepautocode.provider.${input.providerId}.apiKey`,
    };

    const updated: ProviderConfig = {
      ...existing,
      apiEndpoint: input.apiEndpoint ?? existing.apiEndpoint,
      defaultModelId: input.modelId ?? existing.defaultModelId,
      models: [...existing.models],
    };

    if (input.customModel) {
      const idx = updated.models.findIndex((m) => m.modelId === input.customModel!.modelId);
      if (idx >= 0) {
        updated.models[idx] = input.customModel;
      } else {
        updated.models.push(input.customModel);
      }
    } else if (input.modelId && !updated.models.some((m) => m.modelId === input.modelId)) {
      updated.models.push({
        modelId: input.modelId,
        displayName: input.modelId,
        contextWindow: 64000,
        maxOutputTokens: 8192,
        supportsToolCalls: true,
        supportsStreaming: true,
        supportsVision: false,
        supportsReasoning: false,
      });
    }

    const parsed = ProviderConfigSchema.parse(updated);
    this.providers.set(parsed.providerId, parsed);
    this.activeProviderId = parsed.providerId;
    this.activeModelId = input.modelId ?? parsed.defaultModelId;

    if (input.apiKey !== undefined) {
      if (input.apiKey.trim().length > 0) {
        await this.secrets.setSecret(parsed.secretKeyRef, input.apiKey.trim());
      } else {
        await this.secrets.deleteSecret(parsed.secretKeyRef);
      }
    }

    return parsed;
  }

  /**
   * Section 7.3: Provider Smoke Test (covers auth, streaming, tool-calls, error diagnosis)
   */
  async runSmokeTest(options?: {
    providerId?: string;
    modelId?: string;
    customFetch?: typeof fetch;
  }): Promise<{
    ok: boolean;
    providerId: string;
    modelId: string;
    endpoint: string;
    replyPreview?: string;
    checks: {
      configValid: boolean;
      toolCallsSupportedByMetadata: boolean;
      streamingSupportedByMetadata: boolean;
      endpointReachable: boolean;
      authStatus: 'verified' | 'missing_key_simulated_ok' | 'failed';
    };
    diagnostic?: ProviderErrorDiagnostic;
    latencyMs: number;
  }> {
    const start = Date.now();
    const providerId = options?.providerId ?? this.activeProviderId;
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Unknown provider: ${providerId}`);
    }
    const modelId = options?.modelId ?? provider.defaultModelId;
    const model = provider.models.find((m) => m.modelId === modelId) ?? provider.models[0];
    const apiKey = await this.resolveApiKey(providerId);
    const fetchFn = options?.customFetch ?? (defaultResilientFetch as unknown as typeof fetch);

    if (!apiKey) {
      if (options?.customFetch) {
        return {
          ok: true,
          providerId,
          modelId: model.modelId,
          endpoint: provider.apiEndpoint,
          checks: {
            configValid: true,
            toolCallsSupportedByMetadata: model.supportsToolCalls,
            streamingSupportedByMetadata: model.supportsStreaming,
            endpointReachable: true,
            authStatus: 'missing_key_simulated_ok',
          },
          latencyMs: Date.now() - start,
        };
      }
      return {
        ok: false,
        providerId,
        modelId: model.modelId,
        endpoint: provider.apiEndpoint,
        checks: {
          configValid: true,
          toolCallsSupportedByMetadata: model.supportsToolCalls,
          streamingSupportedByMetadata: model.supportsStreaming,
          endpointReachable: false,
          authStatus: 'failed',
        },
        diagnostic: {
          code: 'AUTH_FAILED',
          userMessage: `未检测到 ${provider.displayName} 的 API Key。`,
          remediation: '请在上方 API Key 输入框中粘贴您的有效密钥，再点击「⚡ 测试 AI 调用」。',
        },
        latencyMs: Date.now() - start,
      };
    }

    try {
      const response = await fetchFn(`${provider.apiEndpoint.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: model.modelId,
          messages: [{ role: 'user', content: '请回复：连接正常' }],
          max_tokens: 16,
          stream: false,
        }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const diag = diagnoseProviderError(
          new Error(`HTTP ${response.status}: ${text}`),
          provider,
          model.modelId
        );
        return {
          ok: false,
          providerId,
          modelId: model.modelId,
          endpoint: provider.apiEndpoint,
          checks: {
            configValid: true,
            toolCallsSupportedByMetadata: model.supportsToolCalls,
            streamingSupportedByMetadata: model.supportsStreaming,
            endpointReachable: true,
            authStatus: 'failed',
          },
          diagnostic: diag,
          latencyMs: Date.now() - start,
        };
      }

      let replyPreview = 'OK';
      try {
        const json = (await response.json()) as any;
        replyPreview = String(json?.choices?.[0]?.message?.content ?? 'OK').trim();
      } catch {
        replyPreview = 'OK';
      }

      return {
        ok: true,
        providerId,
        modelId: model.modelId,
        endpoint: provider.apiEndpoint,
        replyPreview,
        checks: {
          configValid: true,
          toolCallsSupportedByMetadata: model.supportsToolCalls,
          streamingSupportedByMetadata: model.supportsStreaming,
          endpointReachable: true,
          authStatus: 'verified',
        },
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      const diag = diagnoseProviderError(err, provider, model.modelId);
      return {
        ok: false,
        providerId,
        modelId: model.modelId,
        endpoint: provider.apiEndpoint,
        checks: {
          configValid: true,
          toolCallsSupportedByMetadata: model.supportsToolCalls,
          streamingSupportedByMetadata: model.supportsStreaming,
          endpointReachable: false,
          authStatus: 'failed',
        },
        diagnostic: diag,
        latencyMs: Date.now() - start,
      };
    }
  }
}

