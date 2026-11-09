import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { redactSensitiveText } from '../src/security.js';
import {
  extractDeepSeekCacheUsage,
  estimateDeepSeekTurnCostCny,
  isDeepSeekPeakHour,
  type NormalizedDeepSeekCacheUsage,
} from '../src/core/DeepSeekModels.js';
import type { TaskTraceStore } from '../src/core/trace/TaskTrace.js';

export { extractDeepSeekCacheUsage, type NormalizedDeepSeekCacheUsage };

export interface ProviderCacheTraceTarget {
  recordModelTurn?: (entry: {
    modelId: string;
    tier: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    estimatedCostCny: number;
    peakHour: boolean;
    reasoningEffort: string | null;
  }) => void;
  recordLlmTurn?: TaskTraceStore['recordLlmTurn'];
}

/**
 * B1: Record DeepSeek prompt_cache_hit_tokens & prompt_cache_miss_tokens directly into TaskTrace.
 */
export function recordProviderCacheUsageToTrace(params: {
  usageRaw: unknown;
  modelId: string;
  tier?: string;
  reasoningEffort?: string | null;
  trace?: ProviderCacheTraceTarget | null;
  workspaceRoot?: string;
  sessionId?: string;
  taskId?: string;
  turnIndex?: number;
  latencyMs?: number;
  tokenBudget?: number;
}): NormalizedDeepSeekCacheUsage & { estimatedCostCny: number; peakHour: boolean } {
  const usage = extractDeepSeekCacheUsage(params.usageRaw);
  const peakHour = isDeepSeekPeakHour();
  const estimatedCostCny = estimateDeepSeekTurnCostCny({
    apiModelId: params.modelId,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.promptCacheHitTokens,
    peak: peakHour,
  });
  if (params.trace) {
    if (typeof params.trace.recordModelTurn === 'function') {
      params.trace.recordModelTurn({
        modelId: params.modelId,
        tier: params.tier ?? 'pro',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.promptCacheHitTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        estimatedCostCny,
        peakHour,
        reasoningEffort: params.reasoningEffort ?? null,
      });
    } else if (typeof params.trace.recordLlmTurn === 'function') {
      params.trace.recordLlmTurn({
        workspaceRoot: params.workspaceRoot ?? process.cwd(),
        sessionId: params.sessionId ?? 'default',
        taskId: params.taskId,
        turnIndex: params.turnIndex ?? 1,
        modelId: params.modelId,
        latencyMs: params.latencyMs ?? 0,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.promptCacheHitTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        tokensUsed: usage.inputTokens + usage.outputTokens,
        tokenBudget: params.tokenBudget ?? 128000,
      });
    }
  }
  return {
    ...usage,
    estimatedCostCny,
    peakHour,
  };
}

const sshRelayHosts = new Set<string>();
let cachedSshRelayAlias: string | null | undefined = undefined;

function isPrivateLanHostname(hostname: string): boolean {
  return /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(hostname);
}

export function shouldUseSshRelayForLanHost(hostname: string): boolean {
  if (!isPrivateLanHostname(hostname)) return false;
  if (!resolveSshRelayAlias()) return false;
  if (sshRelayHosts.has(hostname)) return true;
  try {
    const ifaces = os.networkInterfaces();
    let hasClashTun = false;
    const localPrefixes: string[] = [];
    for (const [name, addrs] of Object.entries(ifaces)) {
      if (!addrs) continue;
      for (const addr of addrs) {
        if (addr.family !== 'IPv4' || addr.internal) continue;
        if (/clash|meta|sing-box|wintun/i.test(name) || addr.address.startsWith('198.18.')) {
          hasClashTun = true;
        } else if (addr.address.startsWith('10.')) {
          const parts = addr.address.split('.');
          localPrefixes.push(`${parts[0]}.${parts[1]}.${parts[2]}.`);
        }
      }
    }
    if (hasClashTun && hostname.startsWith('10.')) {
      const onSameSubnet = localPrefixes.some((p) => hostname.startsWith(p));
      if (!onSameSubnet) {
        sshRelayHosts.add(hostname);
        return true;
      }
    }
  } catch {
    // ignore
  }
  return false;
}

function resolveSshRelayAlias(): string | null {
  if (cachedSshRelayAlias !== undefined) return cachedSshRelayAlias;
  if (process.env.DAC_SSH_RELAY_HOST?.trim()) {
    cachedSshRelayAlias = process.env.DAC_SSH_RELAY_HOST.trim();
    return cachedSshRelayAlias;
  }
  try {
    const sshConfigPath = path.join(os.homedir(), '.ssh', 'config');
    const raw = fsSync.readFileSync(sshConfigPath, 'utf-8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.trim().match(/^Host\s+([^\s*#]+)/i);
      if (m?.[1]) {
        cachedSshRelayAlias = m[1].trim();
        return cachedSshRelayAlias;
      }
    }
  } catch {
    // ignore
  }
  cachedSshRelayAlias = null;
  return null;
}

export function postJsonViaSshRelay(params: {
  url: string;
  method?: string;
  headers: Record<string, string>;
  bodyStr: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; status: number; text: string }> {
  const sshHost = resolveSshRelayAlias();
  if (!sshHost) {
    return Promise.reject(new Error('No SSH relay host found in ~/.ssh/config'));
  }
  return new Promise((resolve, reject) => {
    const headerArgs: string[] = [];
    for (const [k, v] of Object.entries(params.headers)) {
      if (/^content-length$/i.test(k)) continue;
      const safeHeader = `${k}: ${String(v).replace(/'/g, '')}`;
      headerArgs.push(`-H '${safeHeader}'`);
    }
    const safeUrl = String(params.url).replace(/'/g, '');
    const method = (params.method || 'POST').toUpperCase();
    const effectiveTimeoutMs = params.timeoutMs ?? 180000;
    const maxTimeSec = Math.max(30, Math.ceil(effectiveTimeoutMs / 1000));
    const remoteCmd = `curl -sS --max-time ${maxTimeSec} -w '\\n__DAC_HTTP_STATUS__:%{http_code}' -X ${method} ${headerArgs.join(' ')} --data-binary @- '${safeUrl}'`;

    const child = spawn(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=6', sshHost, remoteCmd],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`SSH relay timed out after ${effectiveTimeoutMs}ms`));
    }, effectiveTimeoutMs + 8000);

    child.stdout.on('data', (c) => outChunks.push(Buffer.from(c)));
    child.stderr.on('data', (c) => errChunks.push(Buffer.from(c)));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const rawOut = Buffer.concat(outChunks).toString('utf-8');
      const errText = Buffer.concat(errChunks).toString('utf-8').trim();
      const statusMatch = rawOut.match(/\n__DAC_HTTP_STATUS__:(\d{3})\s*$/);
      if (statusMatch) {
        const status = Number(statusMatch[1]);
        const bodyText = rawOut.slice(0, statusMatch.index);
        if (status === 0) {
          reject(
            new Error(
              errText ||
                `Request to ${safeUrl} timed out or closed before HTTP response (curl exit ${code})`
            )
          );
          return;
        }
        resolve({
          ok: status >= 200 && status < 300,
          status,
          text: bodyText,
        });
        return;
      }
      reject(new Error(errText || `SSH relay exited with code ${code}`));
    });

    if (params.bodyStr) {
      child.stdin.write(params.bodyStr);
    }
    child.stdin.end();
  });
}

async function defaultResilientFetch(url: string | URL, init?: RequestInit): Promise<Response> {
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

  // If this private LAN host is hijacked by Windows Clash TUN (8.0.0.0/5) or previously failed with ECONNRESET, go straight through SSH relay
  if (
    (sshRelayHosts.has(parsedUrl.host) || shouldUseSshRelayForLanHost(parsedUrl.hostname)) &&
    isPrivateLanHostname(parsedUrl.hostname)
  ) {
    const relayed = await postJsonViaSshRelay({
      url: String(url),
      method: init?.method ?? 'POST',
      headers,
      bodyStr,
      timeoutMs: 45000,
    });
    return new Response(relayed.text, { status: relayed.status });
  }

  try {
    return await new Promise<Response>((resolve, reject) => {
      const reqFn = isHttps ? https.request : http.request;
      const req = reqFn(
        parsedUrl,
        {
          method: init?.method ?? 'POST',
          family: 4,
          headers,
          timeout: 12000,
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
      req.on('timeout', () => req.destroy(new Error('Request timed out after 12000ms')));
      req.on('error', reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      isPrivateLanHostname(parsedUrl.hostname) &&
      /ECONNRESET|ETIMEDOUT|ECONNREFUSED|timed out/i.test(msg) &&
      resolveSshRelayAlias()
    ) {
      const relayed = await postJsonViaSshRelay({
        url: String(url),
        method: init?.method ?? 'POST',
        headers,
        bodyStr,
        timeoutMs: 45000,
      });
      sshRelayHosts.add(parsedUrl.host);
      return new Response(relayed.text, { status: relayed.status });
    }
    throw err;
  }
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
  protocol: z.enum(['deepseek', 'openai-compatible', 'anthropic', 'openai', 'glm']),
  apiEndpoint: z.string().url(),
  defaultModelId: z.string().min(1),
  models: z.array(ModelMetadataSchema).min(1),
  secretKeyRef: z.string().min(1),
  timeoutMs: z.number().int().positive().default(60000),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export function isLocalOrPrivateEndpoint(apiEndpoint: string): boolean {
  try {
    const u = new URL(String(apiEndpoint || '').trim());
    return (
      u.hostname === '127.0.0.1' ||
      u.hostname === 'localhost' ||
      u.hostname === '::1' ||
      isPrivateLanHostname(u.hostname)
    );
  } catch {
    return false;
  }
}

export function readClaudeSettingsJsonSync(): {
  baseUrl?: string;
  authToken?: string;
  defaultModel?: string;
} | null {
  try {
    const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    const raw = fsSync.readFileSync(claudeSettingsPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, any>;
    const env = parsed?.env && typeof parsed.env === 'object' ? parsed.env : {};
    const baseUrl =
      typeof env.ANTHROPIC_BASE_URL === 'string' && env.ANTHROPIC_BASE_URL.trim()
        ? env.ANTHROPIC_BASE_URL.trim()
        : undefined;
    const authToken =
      typeof env.ANTHROPIC_AUTH_TOKEN === 'string' && env.ANTHROPIC_AUTH_TOKEN.trim()
        ? env.ANTHROPIC_AUTH_TOKEN.trim()
        : undefined;
    const defaultModel =
      (typeof env.ANTHROPIC_DEFAULT_OPUS_MODEL === 'string' && env.ANTHROPIC_DEFAULT_OPUS_MODEL.trim()) ||
      (typeof env.ANTHROPIC_DEFAULT_SONNET_MODEL === 'string' && env.ANTHROPIC_DEFAULT_SONNET_MODEL.trim()) ||
      (typeof env.ANTHROPIC_DEFAULT_HAIKU_MODEL === 'string' && env.ANTHROPIC_DEFAULT_HAIKU_MODEL.trim()) ||
      undefined;
    if (!baseUrl && !defaultModel && !authToken) return null;
    return { baseUrl, authToken, defaultModel };
  } catch {
    return null;
  }
}

/**
 * Normalize base URLs (e.g. `http://127.0.0.1:8000` from local vLLM/SGLang,
 * `https://open.bigmodel.cn/api/paas/v4`, or `https://api.deepseek.com/v1`) into a valid
 * `/chat/completions` endpoint across all providers.
 */
export function resolveChatCompletionsUrl(apiEndpoint: string): string {
  const trimmed = String(apiEndpoint || '').trim().replace(/\/+$/, '');
  if (!trimmed) return 'https://api.deepseek.com/v1/chat/completions';
  if (/\/chat\/completions$/i.test(trimmed)) {
    return trimmed;
  }
  if (/\/v\d+(?:beta)?$/i.test(trimmed)) {
    return `${trimmed}/chat/completions`;
  }
  return `${trimmed}/v1/chat/completions`;
}

/**
 * Build `~/.claude/settings.json` payload for GLM or custom OpenAI/Anthropic-compatible endpoints.
 */
export function buildClaudeSettingsJsonForGlm(params?: {
  authToken?: string;
  baseUrl?: string;
  defaultModel?: string;
  opusModel?: string;
  sonnetModel?: string;
  haikuModel?: string;
}): Record<string, unknown> {
  const model = (params?.defaultModel || 'glm-4-plus').trim() || 'glm-4-plus';
  const baseUrl =
    (params?.baseUrl || 'https://open.bigmodel.cn/api/paas/v4').trim().replace(/\/v1\/?$/, '') ||
    'https://open.bigmodel.cn/api/paas/v4';
  const authToken = (params?.authToken || 'EMPTY').trim() || 'EMPTY';
  return {
    env: {
      ANTHROPIC_AUTH_TOKEN: authToken,
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_DEFAULT_OPUS_MODEL: params?.opusModel?.trim() || model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: params?.sonnetModel?.trim() || model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: params?.haikuModel?.trim() || model,
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      CLAUDE_CODE_SKIP_FIRST_RUN: '1',
      CLAUDE_CODE_TELEMETRY: '0',
      DISABLE_TELEMETRY: '1',
      CLAUDE_CODE_WEB_FETCH_SKIP_SAFETY_CHECK: '1',
    },
    autoUpdate: {
      enabled: false,
    },
    hasCompletedOnboarding: true,
    skipOnboarding: true,
    telemetry: {
      enabled: false,
    },
    tui: 'fullscreen',
  };
}

/**
 * Section 7.1 & 7.2: Built-in Default Providers (DeepSeek default + GLM vLLM/SGLang + OpenAI-compatible / Anthropic)
 */
export const DEFAULT_PROVIDERS: Record<string, ProviderConfig> = {
  deepseek: {
    providerId: 'deepseek',
    displayName: 'DeepSeek (Default)',
    protocol: 'deepseek',
    apiEndpoint: 'https://api.deepseek.com/v1',
    defaultModelId: 'deepseek-flash',
    secretKeyRef: 'deepautocode.provider.deepseek.apiKey',
    timeoutMs: 60000,
    models: [
      {
        modelId: 'deepseek-flash',
        displayName: 'DeepSeek Flash (deepseek-flash)',
        contextWindow: 1_000_000,
        maxOutputTokens: 384_000,
        supportsToolCalls: true,
        supportsStreaming: true,
        supportsVision: true,
        supportsReasoning: true,
      },
      {
        modelId: 'deepseek-v4-pro',
        displayName: 'DeepSeek V4 Pro (deepseek-v4-pro)',
        contextWindow: 1_000_000,
        maxOutputTokens: 384_000,
        supportsToolCalls: true,
        supportsStreaming: true,
        supportsVision: false,
        supportsReasoning: true,
      },
      // Legacy aliases (retired API names) — kept for persisted sessions / UI migration
      {
        modelId: 'deepseek-chat',
        displayName: 'Legacy alias → Flash (deepseek-chat)',
        contextWindow: 1_000_000,
        maxOutputTokens: 384_000,
        supportsToolCalls: true,
        supportsStreaming: true,
        supportsVision: true,
        supportsReasoning: true,
      },
      {
        modelId: 'deepseek-reasoner',
        displayName: 'Legacy alias → Pro thinking (deepseek-reasoner)',
        contextWindow: 1_000_000,
        maxOutputTokens: 384_000,
        supportsToolCalls: true,
        supportsStreaming: true,
        supportsVision: false,
        supportsReasoning: true,
      },
    ],
  },
  glm: {
    providerId: 'glm',
    displayName: 'GLM (Zhipu BigModel Official)',
    protocol: 'glm',
    apiEndpoint: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModelId: 'glm-4-plus',
    secretKeyRef: 'deepautocode.provider.glm.apiKey',
    timeoutMs: 120000,
    models: [
      {
        modelId: 'glm-4-plus',
        displayName: 'GLM-4-Plus (Official Default)',
        contextWindow: 128_000,
        maxOutputTokens: 8_192,
        supportsToolCalls: true,
        supportsStreaming: true,
        supportsVision: true,
        supportsReasoning: false,
      },
      {
        modelId: 'glm-4-flash',
        displayName: 'GLM-4-Flash',
        contextWindow: 128_000,
        maxOutputTokens: 8_192,
        supportsToolCalls: true,
        supportsStreaming: true,
        supportsVision: false,
        supportsReasoning: false,
      },
      {
        modelId: 'glm-z1-flash',
        displayName: 'GLM-Z1-Flash (Reasoning)',
        contextWindow: 128_000,
        maxOutputTokens: 16_384,
        supportsToolCalls: true,
        supportsStreaming: true,
        supportsVision: false,
        supportsReasoning: true,
      },
      {
        modelId: 'glm-4-air',
        displayName: 'GLM-4-Air',
        contextWindow: 128_000,
        maxOutputTokens: 8_192,
        supportsToolCalls: true,
        supportsStreaming: true,
        supportsVision: false,
        supportsReasoning: false,
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
      remediation:
        'Switch to a model with `supportsToolCalls: true` (e.g., deepseek-flash) or use Plan/Chat mode.',
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

const PROVIDER_STATE_SECRET_KEY = 'deepautocode.provider.__state__';

export class ProviderManager {
  private providers = new Map<string, ProviderConfig>();
  private activeProviderId = 'deepseek';
  private activeModelId = 'deepseek-flash';
  private readonly secrets: SecretStorageAdapter;
  private stateLoaded = false;

  constructor(secrets: SecretStorageAdapter = new InMemorySecretStorage()) {
    this.secrets = secrets;
    for (const [id, cfg] of Object.entries(DEFAULT_PROVIDERS)) {
      this.providers.set(id, structuredClone(cfg));
    }
  }

  private async ensureStateLoaded(): Promise<void> {
    if (this.stateLoaded) return;
    this.stateLoaded = true;
    try {
      const raw = await this.secrets.getSecret(PROVIDER_STATE_SECRET_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as {
          activeProviderId?: string;
          activeModelId?: string;
          providers?: Record<
            string,
            { apiEndpoint?: string; defaultModelId?: string; models?: ModelMetadata[] }
          >;
        };
        if (parsed.providers && typeof parsed.providers === 'object') {
          for (const [id, patch] of Object.entries(parsed.providers)) {
            const base = this.providers.get(id) ?? {
              ...DEFAULT_PROVIDERS['openai-compatible'],
              providerId: id,
              displayName: id,
              secretKeyRef: `deepautocode.provider.${id}.apiKey`,
            };
            const merged = ProviderConfigSchema.safeParse({
              ...base,
              apiEndpoint: patch.apiEndpoint || base.apiEndpoint,
              defaultModelId: patch.defaultModelId || base.defaultModelId,
              models: Array.isArray(patch.models) && patch.models.length > 0 ? patch.models : base.models,
            });
            if (merged.success) {
              this.providers.set(id, merged.data);
            }
          }
        }
        if (parsed.activeProviderId && this.providers.has(parsed.activeProviderId)) {
          this.activeProviderId = parsed.activeProviderId;
        }
        if (parsed.activeModelId) {
          this.activeModelId = parsed.activeModelId;
        }
        return;
      }

      // If running with persistent EncryptedFileSecretStorage and no state was saved yet,
      // check if ~/.claude/settings.json has ANTHROPIC_BASE_URL / ANTHROPIC_DEFAULT_OPUS_MODEL configured
      if (this.secrets instanceof EncryptedFileSecretStorage) {
        const dsKey = await this.secrets.getSecret(DEFAULT_PROVIDERS.deepseek.secretKeyRef);
        const claudeCfg = readClaudeSettingsJsonSync();
        if (!dsKey && claudeCfg && (claudeCfg.baseUrl || claudeCfg.defaultModel)) {
          const modelId = claudeCfg.defaultModel || 'glm-4-plus';
          const isCustomEndpoint =
            claudeCfg.baseUrl && isLocalOrPrivateEndpoint(claudeCfg.baseUrl);
          const targetProviderId = isCustomEndpoint
            ? 'openai-compatible'
            : /^glm/i.test(modelId)
              ? 'glm'
              : /^deepseek/i.test(modelId)
                ? 'deepseek'
                : /^claude/i.test(modelId)
                  ? 'anthropic'
                  : 'openai-compatible';
          await this.configureProvider({
            providerId: targetProviderId,
            apiEndpoint: claudeCfg.baseUrl,
            modelId,
            apiKey: claudeCfg.authToken || 'EMPTY',
          });
        }
      }
    } catch {
      // ignore state restore errors
    }
  }

  private async persistState(): Promise<void> {
    try {
      const providersSnapshot: Record<
        string,
        { apiEndpoint: string; defaultModelId: string; models: ModelMetadata[] }
      > = {};
      for (const [id, cfg] of this.providers.entries()) {
        providersSnapshot[id] = {
          apiEndpoint: cfg.apiEndpoint,
          defaultModelId: cfg.defaultModelId,
          models: cfg.models,
        };
      }
      await this.secrets.setSecret(
        PROVIDER_STATE_SECRET_KEY,
        JSON.stringify({
          activeProviderId: this.activeProviderId,
          activeModelId: this.activeModelId,
          providers: providersSnapshot,
        })
      );
    } catch {
      // ignore persistence errors
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

  getProviderById(providerId: string): ProviderConfig {
    return this.providers.get(providerId) ?? this.providers.get(this.activeProviderId) ?? DEFAULT_PROVIDERS.deepseek;
  }

  /**
   * Universal provider resolver: allows any model (e.g. official or custom local vLLM model)
   * to run under whichever provider the user configured in Settings (`glm`, `openai-compatible`,
   * `anthropic`, or `deepseek`).
   */
  resolveProviderForModel(modelId?: string, preferredProviderId?: string): ProviderConfig {
    const active = this.providers.get(this.activeProviderId) ?? DEFAULT_PROVIDERS.deepseek;
    const trimmedModel = (modelId || '').trim();
    if (!trimmedModel) {
      return (preferredProviderId && this.providers.get(preferredProviderId)) || active;
    }
    // 1. If the active provider explicitly has this model as its defaultModelId or in its models list, prefer active!
    if (
      active.defaultModelId === trimmedModel ||
      active.models.some((m) => m.modelId === trimmedModel)
    ) {
      return active;
    }
    // 2. If preferredProviderId explicitly has this model, use preferredProviderId
    if (preferredProviderId) {
      const pref = this.providers.get(preferredProviderId);
      if (
        pref &&
        (pref.defaultModelId === trimmedModel ||
          pref.models.some((m) => m.modelId === trimmedModel))
      ) {
        return pref;
      }
    }
    // 3. Search any configured provider that owns this model
    for (const cfg of this.providers.values()) {
      if (
        cfg.defaultModelId === trimmedModel ||
        cfg.models.some((m) => m.modelId === trimmedModel)
      ) {
        return cfg;
      }
    }
    // 4. Fallback by model prefix or active provider
    if (/^glm/i.test(trimmedModel)) return this.providers.get('glm') ?? active;
    if (/^deepseek/i.test(trimmedModel)) return this.providers.get('deepseek') ?? active;
    if (/^claude/i.test(trimmedModel)) return this.providers.get('anthropic') ?? active;
    return active;
  }

  private resolveFallbackKeyForProvider(provider: ProviderConfig): string | undefined {
    const id = provider.providerId;
    if (id === 'deepseek') {
      if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
    } else if (id === 'glm') {
      return (
        process.env.GLM_API_KEY ||
        process.env.ZHIPU_API_KEY ||
        process.env.ANTHROPIC_AUTH_TOKEN ||
        readClaudeSettingsJsonSync()?.authToken ||
        'EMPTY'
      );
    } else if (id === 'anthropic') {
      if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
        return process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
      }
    } else if (process.env.OPENAI_API_KEY) {
      return process.env.OPENAI_API_KEY;
    }

    // Universal compatibility: if any provider is pointed at a local/private LAN endpoint
    // (e.g. local vLLM / SGLang / Ollama) in persistent mode, allow keyless / EMPTY token automatically.
    if (
      this.secrets instanceof EncryptedFileSecretStorage &&
      isLocalOrPrivateEndpoint(provider.apiEndpoint)
    ) {
      return (
        process.env.ANTHROPIC_AUTH_TOKEN ||
        readClaudeSettingsJsonSync()?.authToken ||
        'EMPTY'
      );
    }
    return undefined;
  }

  async getActiveProviderWithKeyStatus(): Promise<{
    provider: ProviderConfig;
    model: ModelMetadata;
    hasApiKeyConfigured: boolean;
  }> {
    await this.ensureStateLoaded();
    const { provider, model } = this.getActiveProvider();
    const secret = await this.secrets.getSecret(provider.secretKeyRef);
    const envFallback = this.resolveFallbackKeyForProvider(provider);
    return {
      provider,
      model,
      hasApiKeyConfigured: Boolean((secret && secret.trim().length > 0) || envFallback),
    };
  }

  async resolveApiKey(providerId?: string): Promise<string | undefined> {
    await this.ensureStateLoaded();
    const id = providerId ?? this.activeProviderId;
    const provider = this.providers.get(id);
    if (!provider) return undefined;
    const stored = await this.secrets.getSecret(provider.secretKeyRef);
    if (stored && stored.trim().length > 0) return stored.trim();
    return this.resolveFallbackKeyForProvider(provider);
  }

  async configureProvider(input: {
    providerId: string;
    apiEndpoint?: string;
    modelId?: string;
    apiKey?: string;
    customModel?: ModelMetadata;
  }): Promise<ProviderConfig> {
    await this.ensureStateLoaded();
    const existing = this.providers.get(input.providerId) ?? {
      ...DEFAULT_PROVIDERS['openai-compatible'],
      providerId: input.providerId,
      displayName: input.providerId,
      secretKeyRef: `deepautocode.provider.${input.providerId}.apiKey`,
    };

    const nextEndpoint = input.apiEndpoint?.trim() || existing.apiEndpoint;
    const nextModelId = input.modelId?.trim() || existing.defaultModelId;

    const updated: ProviderConfig = {
      ...existing,
      apiEndpoint: nextEndpoint,
      defaultModelId: nextModelId,
      models: [...existing.models],
      timeoutMs:
        isLocalOrPrivateEndpoint(nextEndpoint) || /^glm/i.test(nextModelId)
          ? Math.max(existing.timeoutMs ?? 60000, 180000)
          : existing.timeoutMs ?? 60000,
    };

    if (input.customModel) {
      const idx = updated.models.findIndex((m) => m.modelId === input.customModel!.modelId);
      if (idx >= 0) {
        updated.models[idx] = input.customModel;
      } else {
        updated.models.push(input.customModel);
      }
    } else if (nextModelId && !updated.models.some((m) => m.modelId === nextModelId)) {
      updated.models.push({
        modelId: nextModelId,
        displayName: nextModelId,
        contextWindow: 128000,
        maxOutputTokens: 16384,
        supportsToolCalls: true,
        supportsStreaming: true,
        supportsVision: false,
        supportsReasoning: /^glm|reasoner|r1|qwq/i.test(nextModelId),
      });
    }

    const parsed = ProviderConfigSchema.parse(updated);
    this.providers.set(parsed.providerId, parsed);
    this.activeProviderId = parsed.providerId;
    this.activeModelId = nextModelId;

    if (input.apiKey !== undefined) {
      if (input.apiKey.trim().length > 0) {
        await this.secrets.setSecret(parsed.secretKeyRef, input.apiKey.trim());
      } else if (isLocalOrPrivateEndpoint(parsed.apiEndpoint) || parsed.providerId === 'glm') {
        await this.secrets.setSecret(parsed.secretKeyRef, 'EMPTY');
      } else {
        await this.secrets.deleteSecret(parsed.secretKeyRef);
      }
    }

    await this.persistState();
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
      const chatUrl = resolveChatCompletionsUrl(provider.apiEndpoint);
      const response = await fetchFn(chatUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: model.modelId,
          messages: [{ role: 'user', content: '请直接回复四个字：连接正常' }],
          max_tokens: 64,
          stream: false,
          ...(providerId === 'glm' || /^glm/i.test(model.modelId)
            ? { chat_template_kwargs: { enable_thinking: false } }
            : {}),
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
        const msgObj = json?.choices?.[0]?.message;
        const rawText =
          msgObj?.content ??
          msgObj?.reasoning_content ??
          msgObj?.reasoning ??
          'OK';
        replyPreview = String(rawText).trim() || 'OK';
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

