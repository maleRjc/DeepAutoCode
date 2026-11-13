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
  title: 'credential fallback test',
  workspaceRoot: 'E:\\AutoCode\\DeepAutoCode-New',
  executionMode: 'auto',
});
const sessionId = created?.data?.sessionId;
console.log('session', sessionId, created?.data?.manifest?.providerId);
if (!sessionId) process.exit(1);

const events = [];
const ws = new WebSocket('ws://127.0.0.1:3840/ws');
ws.on('message', (raw) => {
  try {
    const msg = JSON.parse(String(raw));
    if (msg.category === 'event' && msg.sessionId === sessionId) {
      events.push(`${msg.type} ${JSON.stringify(msg.payload).slice(0, 200)}`);
    }
  } catch {}
});
await new Promise((r) => ws.on('open', r));

const t0 = Date.now();
await bridge('session.send', { prompt: '回复 OK' }, sessionId);
while (Date.now() - t0 < 45000) {
  await new Promise((r) => setTimeout(r, 1000));
  if (events.some((e) => e.startsWith('runtime.error') || e.startsWith('assistant.text.done'))) break;
}
console.log(`events after ${((Date.now() - t0) / 1000).toFixed(1)}s:`);
for (const e of events) console.log('  ' + e);
ws.close();
process.exit(0);
