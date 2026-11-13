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

const created = await bridge('session.create', {
  title: 'Kernel smoke test',
  workspaceRoot: 'E:\\AutoCode\\DeepAutoCode-New',
  executionMode: 'auto',
});
console.log('CREATE', JSON.stringify(created).slice(0, 400));
const sessionId = created?.data?.sessionId;
if (!sessionId) process.exit(1);

const events = [];
const ws = new WebSocket('ws://127.0.0.1:3841/ws');
ws.on('message', (raw) => {
  try {
    const msg = JSON.parse(String(raw));
    if (msg.category === 'event' && msg.sessionId === sessionId) {
      events.push(`${msg.type} ${JSON.stringify(msg.payload).slice(0, 220)}`);
    }
  } catch {}
});
await new Promise((r) => ws.on('open', r));

const sent = await bridge('session.send', { prompt: '用一句话说明你是谁即可，不要修改文件。' }, sessionId);
console.log('SEND', JSON.stringify(sent).slice(0, 300));

await new Promise((r) => setTimeout(r, 25000));
console.log('EVENTS:');
for (const ev of events) console.log('  ' + ev);

const resumed = await bridge('session.resume', { sessionId, lastSequence: 0 }, sessionId);
console.log('RESUME messages=', JSON.stringify(resumed?.data?.messages ?? []).slice(0, 600));
ws.close();
process.exit(0);
