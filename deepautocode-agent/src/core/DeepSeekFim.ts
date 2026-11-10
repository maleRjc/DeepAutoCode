import http from 'node:http';
import https from 'node:https';
import { DEEPSEEK_FLASH, isGlmModelId } from './DeepSeekModels.js';
import {
  postJsonViaSshRelay,
  resolveChatCompletionsUrl,
  shouldUseSshRelayForLanHost,
} from '../../providers/index.js';

export interface DeepSeekFimParams {
  apiKey: string;
  prompt: string;
  suffix?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Override base, default https://api.deepseek.com/beta */
  betaBaseUrl?: string;
  /** Optional active provider apiEndpoint (e.g. local vLLM / GLM / OpenAI-compatible) */
  apiEndpoint?: string;
  providerId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; text: string }>;
}

export interface DeepSeekFimResult {
  ok: boolean;
  text: string;
  model: string;
  error?: string;
}

function defaultPostJson(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ ok: boolean; status: number; text: string }> {
  const parsed = new URL(url);
  if (shouldUseSshRelayForLanHost(parsed.hostname)) {
    return postJsonViaSshRelay({
      url,
      method: 'POST',
      headers,
      bodyStr: body,
      timeoutMs,
    });
  }
  const isHttps = parsed.protocol === 'https:';
  return new Promise((resolve, reject) => {
    const reqFn = isHttps ? https.request : http.request;
    const req = reqFn(
      parsed,
      {
        method: 'POST',
        family: 4,
        headers: {
          ...headers,
          'Content-Length': String(Buffer.byteLength(body, 'utf-8')),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          const status = res.statusCode ?? 500;
          resolve({ ok: status >= 200 && status < 300, status, text });
        });
      }
    );
    const onAbort = () => req.destroy(new Error('FIM aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('timeout', () => req.destroy(new Error(`FIM timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * DeepSeek FIM (Fill-In-the-Middle) via Beta Completions API.
 * Only supported on deepseek-flash in non-thinking mode.
 */
export async function completeDeepSeekFim(
  params: DeepSeekFimParams
): Promise<DeepSeekFimResult> {
  const model = params.model || DEEPSEEK_FLASH;
  const maxTokens = Math.max(16, Math.min(256, Number(params.maxTokens ?? 128)));
  const customEndpoint = (params.apiEndpoint || '').trim();
  const useChatFimMode =
    !params.betaBaseUrl &&
    Boolean(
      isGlmModelId(model, params.providerId) ||
        (customEndpoint && !/api\.deepseek\.com/i.test(customEndpoint))
    );

  if (useChatFimMode) {
    const chatUrl = resolveChatCompletionsUrl(
      customEndpoint || 'https://open.bigmodel.cn/api/paas/v4'
    );
    const suffixBlock = params.suffix ? `\n<SUFFIX>\n${params.suffix}\n</SUFFIX>` : '';
    const fimBody = JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content:
            'You are an inline code completion engine. Output ONLY the exact code that should be inserted at <CURSOR>, with no markdown fences and no explanation.',
        },
        {
          role: 'user',
          content: `<PREFIX>\n${params.prompt}<CURSOR>${suffixBlock}`,
        },
      ],
      max_tokens: maxTokens,
      temperature: params.temperature ?? 0,
      stream: false,
      ...(isGlmModelId(model, params.providerId)
        ? { chat_template_kwargs: { enable_thinking: false } }
        : {}),
    });

    try {
      const response = params.fetchImpl
        ? await params.fetchImpl(chatUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${params.apiKey}`,
            },
            body: fimBody,
          })
        : await defaultPostJson(
            chatUrl,
            {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${params.apiKey}`,
            },
            fimBody,
            params.timeoutMs ?? 8_000,
            params.signal
          );
      if (!response.ok) {
        return {
          ok: false,
          text: '',
          model,
          error: `HTTP ${response.status}: ${String(response.text || '').slice(0, 200)}`,
        };
      }
      const data = JSON.parse(response.text || '{}') as any;
      const rawText = String(
        data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? ''
      )
        .replace(/^```[a-zA-Z0-9_-]*\r?\n/, '')
        .replace(/\r?\n```$/, '');
      return { ok: true, text: rawText, model };
    } catch (err) {
      return {
        ok: false,
        text: '',
        model,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const betaBase = (params.betaBaseUrl || 'https://api.deepseek.com/beta').replace(/\/$/, '');
  const url = `${betaBase}/completions`;
  const body = JSON.stringify({
    model,
    prompt: params.prompt,
    suffix: params.suffix ?? '',
    max_tokens: maxTokens,
    temperature: params.temperature ?? 0,
    stream: false,
  });

  try {
    const response = params.fetchImpl
      ? await params.fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${params.apiKey}`,
          },
          body,
        })
      : await defaultPostJson(
          url,
          {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${params.apiKey}`,
          },
          body,
          params.timeoutMs ?? 8_000,
          params.signal
        );

    if (!response.ok) {
      return {
        ok: false,
        text: '',
        model,
        error: `HTTP ${response.status}: ${String(response.text || '').slice(0, 200)}`,
      };
    }
    const data = JSON.parse(response.text || '{}') as any;
    const text = String(data?.choices?.[0]?.text ?? '');
    return { ok: true, text, model };
  } catch (err) {
    return {
      ok: false,
      text: '',
      model,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
