import http from 'node:http';
import https from 'node:https';

const keepAliveHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 32 });
const keepAliveHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 32 });

type ToolCallAccum = {
  id: string;
  name: string;
  arguments: string;
};

export type OpenAiChatCompletionResult = {
  ok: boolean;
  status: number;
  message: Record<string, unknown>;
  usage?: unknown;
  reasoningContent?: string;
  streamedText?: string;
};

function parseSseJsonBlocks(buffer: string): { events: string[]; rest: string } {
  const events: string[] = [];
  let rest = buffer;
  while (true) {
    const idx = rest.indexOf('\n\n');
    if (idx < 0) break;
    const block = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    const dataLine = block
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('data:'));
    if (!dataLine) continue;
    const payload = dataLine.slice(5).trim();
    if (payload === '[DONE]') continue;
    events.push(payload);
  }
  return { events, rest };
}

/**
 * OpenAI-compatible chat completion with streaming preferred (faster TTFB + incremental UI).
 * Falls back to non-stream JSON body when stream fails or returns non-SSE.
 */
export async function requestOpenAiChatCompletion(params: {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
  streamPreferred?: boolean;
  onContentDelta?: (text: string) => void;
  onReasoningDelta?: (text: string) => void;
}): Promise<OpenAiChatCompletionResult> {
  const timeoutMs = params.timeoutMs ?? 120_000;
  const parsedUrl = new URL(params.url);
  const isHttps = parsedUrl.protocol === 'https:';
  const streamPreferred = params.streamPreferred !== false;

  const runNonStream = (): Promise<OpenAiChatCompletionResult> =>
    new Promise((resolve, reject) => {
      const payload = JSON.stringify({ ...params.body, stream: false });
      const reqFn = isHttps ? https.request : http.request;
      const req = reqFn(
        parsedUrl,
        {
          method: 'POST',
          agent: isHttps ? keepAliveHttpsAgent : keepAliveHttpAgent,
          headers: {
            ...params.headers,
            'Content-Length': String(Buffer.byteLength(payload, 'utf-8')),
          },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(Buffer.from(c)));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8');
            const status = res.statusCode ?? 500;
            if (status < 200 || status >= 300) {
              resolve({
                ok: false,
                status,
                message: {},
              });
              return;
            }
            try {
              const data = JSON.parse(text || '{}') as any;
              const msg = data?.choices?.[0]?.message ?? {};
              resolve({
                ok: true,
                status,
                message: msg,
                usage: data?.usage,
                reasoningContent:
                  typeof msg.reasoning_content === 'string'
                    ? msg.reasoning_content
                    : typeof msg.reasoning === 'string'
                      ? msg.reasoning
                      : undefined,
              });
            } catch (err) {
              reject(err);
            }
          });
        }
      );
      req.on('timeout', () => req.destroy(new Error(`Request timed out after ${timeoutMs}ms`)));
      req.on('error', reject);
      params.signal?.addEventListener('abort', () => req.destroy(new Error('CAPABILITY_CANCELLED')), {
        once: true,
      });
      req.write(payload);
      req.end();
    });

  if (!streamPreferred) {
    return runNonStream();
  }

  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ ...params.body, stream: true });
    const reqFn = isHttps ? https.request : http.request;
    let sseBuffer = '';
    let content = '';
    let reasoning = '';
    const toolByIndex = new Map<number, ToolCallAccum>();
    let usage: unknown;
    let settled = false;

    const finish = (result: OpenAiChatCompletionResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const buildMessageFromStreamParts = (): Record<string, unknown> => {
      const tool_calls = [...toolByIndex.entries()]
        .sort((a, b) => a[0] - b[0])
        .filter(([, v]) => v.name.trim().length > 0)
        .map(([, v]) => ({
          id: v.id || `call_${Date.now()}`,
          type: 'function',
          function: { name: v.name, arguments: v.arguments || '{}' },
        }));
      return {
        role: 'assistant',
        content: content || null,
        ...(tool_calls.length > 0 ? { tool_calls } : {}),
        ...(reasoning ? { reasoning_content: reasoning } : {}),
      };
    };

    const tryFinalizeOpenStream = (): boolean => {
      if (content.trim().length === 0 && !reasoning && toolByIndex.size === 0) {
        return false;
      }
      const message = buildMessageFromStreamParts();
      finish({
        ok: true,
        status: 200,
        message,
        usage,
        reasoningContent: reasoning || undefined,
        streamedText: content || undefined,
      });
      return true;
    };

    const handleSsePayload = (jsonText: string) => {
      if (jsonText === '[DONE]') {
        tryFinalizeOpenStream();
        return;
      }
      let data: any;
      try {
        data = JSON.parse(jsonText);
      } catch {
        return;
      }
      if (data?.usage) usage = data.usage;
      const choice = data?.choices?.[0];
      const delta = choice?.delta ?? {};
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        content += delta.content;
        params.onContentDelta?.(delta.content);
      }
      const rc =
        typeof delta.reasoning_content === 'string'
          ? delta.reasoning_content
          : typeof delta.reasoning === 'string'
            ? delta.reasoning
            : '';
      if (rc) {
        reasoning += rc;
        params.onReasoningDelta?.(rc);
      }
      const tcs = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const tc of tcs) {
        const idx = typeof tc.index === 'number' ? tc.index : 0;
        const prev = toolByIndex.get(idx) ?? { id: '', name: '', arguments: '' };
        if (typeof tc.id === 'string' && tc.id) prev.id = tc.id;
        const fn = tc.function ?? {};
        if (typeof fn.name === 'string' && fn.name) prev.name = fn.name;
        if (typeof fn.arguments === 'string') prev.arguments += fn.arguments;
        toolByIndex.set(idx, prev);
      }
      if (choice?.finish_reason || choice?.finishReason) {
        tryFinalizeOpenStream();
      }
    };

    const req = reqFn(
      parsedUrl,
      {
        method: 'POST',
        agent: isHttps ? keepAliveHttpsAgent : keepAliveHttpAgent,
        headers: {
          ...params.headers,
          'Content-Length': String(Buffer.byteLength(payload, 'utf-8')),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 500;
        const ctype = String(res.headers['content-type'] || '');
        if (status < 200 || status >= 300 || !/text\/event-stream/i.test(ctype)) {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(Buffer.from(c)));
          res.on('end', () => {
            void runNonStream().then(finish).catch(reject);
          });
          return;
        }
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          sseBuffer += chunk;
          const parsed = parseSseJsonBlocks(sseBuffer);
          sseBuffer = parsed.rest;
          for (const ev of parsed.events) handleSsePayload(ev);
        });
        res.on('end', () => {
          if (!settled) {
            if (sseBuffer.trim()) {
              const parsed = parseSseJsonBlocks(`${sseBuffer}\n\n`);
              for (const ev of parsed.events) handleSsePayload(ev);
            }
            if (!settled && tryFinalizeOpenStream()) {
              return;
            }
            if (!settled) {
              void runNonStream().then(finish).catch(reject);
            }
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });
    req.on('error', (err) => {
      if (settled) return;
      void runNonStream().then(finish).catch(() => reject(err));
    });
    params.signal?.addEventListener(
      'abort',
      () => req.destroy(new Error('CAPABILITY_CANCELLED')),
      { once: true }
    );
    req.write(payload);
    req.end();
  });
}
