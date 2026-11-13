import WebSocket from 'ws';

const base = 'http://127.0.0.1:3840';
const bridge = async (type, payload = {}, sessionId) => {
  const res = await fetch(`${base}/api/bridge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category: 'request', type, requestId: `t_${Math.random()}`, payload, sessionId }),
  });
  return res.json();
};

await bridge('provider.update', {
  providerId: 'deepseek',
  apiEndpoint: 'https://api.deepseek.com/v1',
  modelId: 'deepseek-flash',
});

const created = await bridge('session.create', {
  title: 'deepseek regression',
  workspaceRoot: 'E:\\AutoCode\\DeepAutoCode-New',
  executionMode: 'auto',
});
const sessionId = created?.data?.sessionId;
console.log('provider=', created?.data?.manifest?.providerId, 'model=', created?.data?.manifest?.modelId);

const events = [];
const ws = new WebSocket('ws://127.0.0.1:3840/ws');
ws.on('message', (raw) => {
  try {
    const msg = JSON.parse(String(raw));
    if (msg.category === 'event' && msg.sessionId === sessionId) {
      events.push(`${((Date.now() - t0) / 1000).toFixed(0)}s ${msg.type} ${JSON.stringify(msg.payload).slice(0, 160)}`);
    }
  } catch {}
});
await new Promise((r) => ws.on('open', r));

const t0 = Date.now();
await bridge('session.send', { prompt: '只回复 OK 两个字母' }, sessionId);
while (Date.now() - t0 < 180000) {
  await new Promise((r) => setTimeout(r, 1000));
  if (events.some((e) => e.includes('assistant.text.done') || e.includes('runtime.error'))) break;
}
console.log('EVENTS:');
for (const e of events) console.log('  ' + e);

// Restore the GLM provider the user was using.
await bridge('provider.update', {
  providerId: 'openai-compatible',
  apiEndpoint: 'http://10.0.0.10:8000',
  modelId: 'your-model',
});
console.log('restored provider -> openai-compatible / your-model');
ws.close();
process.exit(0);
