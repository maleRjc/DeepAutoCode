import { describe, expect, it } from 'vitest';
import http from 'node:http';
import { requestOpenAiChatCompletion } from '../src/runtime/OpenAiStreamChat.js';

describe('requestOpenAiChatCompletion stream finalize', () => {
  it('assembles message on SSE end without finish_reason (vLLM-style)', async () => {
    const sseBody = [
      'data: {"choices":[{"delta":{"content":"## 修复步骤"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"edit_file","arguments":"{\\"filePath\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.ts\\"}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');

    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(sseBody);
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const result = await requestOpenAiChatCompletion({
      url: `http://127.0.0.1:${port}/v1/chat/completions`,
      headers: { 'Content-Type': 'application/json' },
      body: { model: 'GLM-5.3-Flash', messages: [{ role: 'user', content: 'fix' }] },
      streamPreferred: true,
      timeoutMs: 5000,
    });

    server.close();

    expect(result.ok).toBe(true);
    expect(result.message.content).toBe('## 修复步骤');
    const tcs = result.message.tool_calls as any[];
    expect(Array.isArray(tcs)).toBe(true);
    expect(tcs[0]?.function?.name).toBe('edit_file');
    expect(String(tcs[0]?.function?.arguments)).toContain('a.ts');
  });
});
