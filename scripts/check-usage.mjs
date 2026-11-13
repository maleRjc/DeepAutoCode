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

const created = await bridge('session.create', {
  title: 'usage check',
  workspaceRoot: 'E:\\AutoCode\\DeepAutoCode-New',
  executionMode: 'auto',
});
const sessionId = created?.data?.sessionId;
console.log('session', sessionId, created?.data?.manifest?.providerId, created?.data?.manifest?.modelId);

const events = [];
const ws = new WebSocket('ws://127.0.0.1:3840/ws');
ws.on('message', (raw) => {
  try {
    const msg = JSON.parse(String(raw));
    if (msg.category === 'event' && msg.sessionId === sessionId) {
      events.push(`${((Date.now() - t0) / 1000).toFixed(0)}s ${msg.type} ${JSON.stringify(msg.payload).slice(0, 200)}`);
    }
  } catch {}
});
await new Promise((r) => ws.on('open', r));

const t0 = Date.now();
await bridge('session.send', { prompt: '只回复 OK' }, sessionId);
while (Date.now() - t0 < 180000) {
  await new Promise((r) => setTimeout(r, 1500));
  if (events.some((e) => e.includes('assistant.text.done') || e.includes('runtime.error'))) break;
}
console.log('EVENTS:');
for (const e of events) console.log('  ' + e);
ws.close();
process.exit(0);
