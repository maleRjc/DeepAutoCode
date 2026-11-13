import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client';

const repo = 'E:\\AutoCode\\DeepAutoCode-New';
const patchDir = path.join(repo, '.deepautocode-data', 'kernel');
await fs.mkdir(patchDir, { recursive: true });
const patchPath = path.join(patchDir, 'pi-ai-gateway.yml');
await fs.writeFile(
  patchPath,
  [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      dac-gateway:',
    "        displayName: 'DeepAutoCode Gateway'",
    '        api: openai-completions',
    '        baseURL: "http://127.0.0.1:8009/v1"',
    '        apiKeyEnv: DAC_LLM_API_KEY',
    '        models:',
    '          - id: "mock-model"',
    '            name: "Mock Model"',
    '            contextWindow: 128000',
    '            maxTokens: 8192',
    '',
  ].join('\n'),
  'utf8'
);

const client = new HarnessClient({
  dshHome: path.join(os.homedir(), '.dsh'),
  profile: 'sdk',
  patches: [patchPath],
  env: { ...process.env, DAC_LLM_API_KEY: 'test-key' },
  initializeTimeoutMs: 120000,
});
client.start();
client.onRequest(async () => ({ outcome: 'allowed-once' }));

try {
  const init = await client.initialize({
    cwd: repo,
    provider: 'dac-gateway',
    model: 'mock-model',
    approvalRequests: true,
  });
  console.log('INIT_OK', JSON.stringify(init));

  const sid = `dsh_${Math.random().toString(36).slice(2)}`;
  const sub = client.subscribeSessionTree(sid);
  const accepted = await client.prompt(sid, [{ type: 'text', text: 'hi' }]);
  console.log('PROMPT', accepted);

  const timer = setTimeout(() => {
    console.log('TIMEOUT');
    process.exit(1);
  }, 60000);

  for (;;) {
    const n = await sub.next();
    if (n.method === 'session.event') {
      const ev = n.params.event;
      if (ev.type === 'assistant/message') {
        const text = (ev.data?.message?.content ?? [])
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('');
        console.log('ASSISTANT_TEXT', JSON.stringify(text));
      }
      if (ev.type === 'turn/end') console.log('TURN_END', JSON.stringify(ev.data?.reason));
    }
    if (n.method === 'session.status' && n.params.sessionId === sid && n.params.status === 'idle') break;
  }
  clearTimeout(timer);
  console.log('DONE');
} catch (err) {
  console.error('GATEWAY_FAIL', err?.message || err);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
