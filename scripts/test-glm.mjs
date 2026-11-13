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
  providerId: 'openai-compatible',
  apiEndpoint: process.env.DAC_GATEWAY_URL || 'http://10.0.0.10:8000',
  modelId: process.env.DAC_MODEL || 'your-model',
});

const created = await bridge('session.create', {
  title: 'glm live test',
  workspaceRoot: 'E:\\AutoCode\\DeepAutoCode-New',
  executionMode: 'auto',
});
const sessionId = created?.data?.sessionId;
console.log('session', sessionId, created?.data?.manifest?.providerId, created?.data?.manifest?.modelId);
if (!sessionId) process.exit(1);

const events = [];
const ws = new WebSocket('ws://127.0.0.1:3840/ws');
ws.on('message', (raw) => {
  try {
    const msg = JSON.parse(String(raw));
    if (msg.category === 'event' && msg.sessionId === sessionId) {
      events.push(`${((Date.now() - t0) / 1000).toFixed(0)}s ${msg.type} ${JSON.stringify(msg.payload).slice(0, 240)}`);
    }
  } catch {}
});
await new Promise((r) => ws.on('open', r));

const t0 = Date.now();
await bridge('session.send', { prompt: '只回复 OK 两个字母' }, sessionId);

while (Date.now() - t0 < 240000) {
  await new Promise((r) => setTimeout(r, 2000));
  if (events.some((e) => e.includes('runtime.error') || e.includes('assistant.text.done'))) break;
  if (events.length && events.length % 3 === 0) console.log('...waiting', events.length);
}
console.log('EVENTS:');
for (const e of events) console.log('  ' + e);
ws.close();
process.exit(0);
