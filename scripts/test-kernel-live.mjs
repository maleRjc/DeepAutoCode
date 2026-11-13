import WebSocket from 'ws';

const base = 'http://127.0.0.1:3841';
const bridge = async (type, payload = {}, sessionId) => {
  const res = await fetch(`${base}/api/bridge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category: 'request', type, requestId: `t_${Math.random()}`, payload, sessionId }),
  });
  return res.json();
};

console.log('UPDATE PROVIDER', JSON.stringify(await bridge('provider.update', {
  providerId: 'deepseek',
  modelId: 'deepseek-flash',
  apiEndpoint: 'https://api.deepseek.com/v1',
  apiKey: 'sk-smoke-test-not-a-real-key',
})).slice(0, 300));

const created = await bridge('session.create', {
  title: 'DSH kernel live test',
  workspaceRoot: 'E:\\AutoCode\\DeepAutoCode-New',
  executionMode: 'auto',
});
const sessionId = created?.data?.sessionId;
console.log('CREATE', sessionId, created?.data?.manifest?.providerId, created?.data?.manifest?.modelId);
if (!sessionId) process.exit(1);

const events = [];
const ws = new WebSocket('ws://127.0.0.1:3841/ws');
ws.on('message', (raw) => {
  try {
    const msg = JSON.parse(String(raw));
    if (msg.category === 'event' && msg.sessionId === sessionId) {
      events.push(`${msg.type} ${JSON.stringify(msg.payload).slice(0, 240)}`);
    }
  } catch {}
});
await new Promise((r) => ws.on('open', r));

const started = Date.now();
console.log('SEND', JSON.stringify(await bridge('session.send', { prompt: '回复 OK 两个字母即可。' }, sessionId)).slice(0, 200));

for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  if (events.some((e) => e.startsWith('assistant.text.done') || e.startsWith('runtime.error'))) break;
  if (events.length && i % 5 === 0) console.log(`  ...${((Date.now() - started) / 1000).toFixed(0)}s events=${events.length}`);
}
console.log(`EVENTS after ${((Date.now() - started) / 1000).toFixed(1)}s:`);
for (const ev of events) console.log('  ' + ev);
ws.close();
process.exit(0);
