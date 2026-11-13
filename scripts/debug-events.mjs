import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client';

const client = new HarnessClient({
  dshHome: path.join(os.homedir(), '.dsh'),
  profile: 'sdk',
  initializeTimeoutMs: 120000,
});
client.start();
client.onRequest(async (method, params) => {
  console.log('REQUEST', method, JSON.stringify(params).slice(0, 200));
  return { outcome: 'allowed-once' };
});

const init = await client.initialize({
  cwd: 'E:\\AutoCode\\DeepAutoCode-New',
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  approvalRequests: true,
});
console.log('INIT', JSON.stringify(init));

const sid = `dsh_${crypto.randomUUID()}`;
const sub = client.subscribeSessionTree(sid);
const started = Date.now();
const promptPromise = client.prompt(sid, [{ type: 'text', text: '只回复 OK' }]);
promptPromise.then(
  (id) => console.log('PROMPT_ACCEPTED', id),
  (err) => console.log('PROMPT_FAILED', err?.message)
);

const timer = setTimeout(() => {
  console.log('DEBUG_TIMEOUT');
  process.exit(0);
}, 90000);

for (;;) {
  const n = await sub.next();
  const p = n.params;
  if (n.method === 'session.event') {
    const ev = p.event ?? {};
    console.log(`EVENT ${ev.type} ${JSON.stringify(ev).slice(0, 400)}`);
  } else {
    console.log(n.method, JSON.stringify(p).slice(0, 300));
  }
  if (
    n.method === 'session.status' &&
    p.sessionId === sid &&
    p.status === 'idle'
  ) {
    console.log('IDLE after', ((Date.now() - started) / 1000).toFixed(1), 's');
    clearTimeout(timer);
    break;
  }
}

await client.close().catch(() => {});
process.exit(0);
