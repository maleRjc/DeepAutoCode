import http from 'node:http';
import { StringDecoder } from 'node:string_decoder';

export interface GatewayDelta {
  text?: string;
  reasoning?: string;
}

export interface GatewayProxy {
  port: number;
  close(): void;
}

/**
 * A tiny HTTP proxy in front of an OpenAI-compatible gateway.
 *
 * Two jobs:
 * 1. Optionally inject `chat_template_kwargs.enable_thinking=false` (local vLLM GLM).
 * 2. Observe the SSE stream and forward delta fragments to the kernel, which
 *    turns them into real-time UI events. The DSH SDK protocol only reports
 *    committed messages, so this proxy is the seam that makes token streaming
 *    visible without patching the harness.
 */
export async function startGatewayProxy(options: {
  targetOrigin: string;
  disableThinking: boolean;
  onDelta?: (delta: GatewayDelta) => void;
}): Promise<GatewayProxy> {
  const target = new URL(options.targetOrigin);

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      const headers: http.OutgoingHttpHeaders = { ...req.headers };
      delete headers.host;

      if (
        options.disableThinking &&
        req.method === 'POST' &&
        /\/chat\/completions$/i.test(req.url ?? '')
      ) {
        try {
          const json = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
          json.chat_template_kwargs = {
            ...(json.chat_template_kwargs as Record<string, unknown> | undefined),
            enable_thinking: false,
          };
          body = Buffer.from(JSON.stringify(json), 'utf8');
          headers['content-type'] = 'application/json';
        } catch {
          // leave the body untouched when it is not JSON
        }
      }
      headers['content-length'] = String(body.length);

      const upstream = http.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || 80,
          path: req.url,
          method: req.method,
          headers,
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          const contentType = String(upstreamRes.headers['content-type'] ?? '');
          const isEventStream = /text\/event-stream/i.test(contentType);

          if (!isEventStream || !options.onDelta) {
            upstreamRes.pipe(res);
            return;
          }

          const decoder = new StringDecoder('utf8');
          let pending = '';
          upstreamRes.on('data', (chunk: Buffer) => {
            const text = decoder.write(chunk);
            pending += text;
            let index = pending.indexOf('\n');
            while (index >= 0) {
              const line = pending.slice(0, index).trim();
              pending = pending.slice(index + 1);
              if (line.startsWith('data:')) {
                const payload = line.slice(5).trim();
                if (payload && payload !== '[DONE]') {
                  try {
                    const parsed = JSON.parse(payload) as Record<string, any>;
                    const choice = parsed?.choices?.[0];
                    const delta = choice?.delta ?? {};
                    const textDelta =
                      typeof delta.content === 'string'
                        ? delta.content
                        : typeof choice?.text === 'string'
                          ? choice.text
                          : undefined;
                    const reasoningDelta =
                      typeof delta.reasoning_content === 'string'
                        ? delta.reasoning_content
                        : typeof delta.reasoning === 'string'
                          ? delta.reasoning
                          : undefined;
                    if (textDelta || reasoningDelta) {
                      options.onDelta?.({ text: textDelta, reasoning: reasoningDelta });
                    }
                  } catch {
                    // ignore malformed SSE payloads
                  }
                }
              }
              index = pending.indexOf('\n');
            }
            res.write(chunk);
          });
          upstreamRes.on('end', () => {
            decoder.end();
            res.end();
          });
        }
      );
      upstream.on('error', (err) => {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({ error: { message: `gateway proxy: ${err.message}` } }));
      });
      upstream.end(body);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    port,
    close: () => {
      server.close();
      server.closeAllConnections?.();
    },
  };
}
