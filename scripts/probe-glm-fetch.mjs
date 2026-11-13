const url = 'http://10.0.0.10:8000/v1/chat/completions';
const body = (stream) =>
  JSON.stringify({
    model: 'your-model',
    messages: [{ role: 'user', content: '请直接回复四个字：连接正常' }],
    max_tokens: 64,
    stream,
    chat_template_kwargs: { enable_thinking: false },
  });

async function run(stream) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer EMPTY' },
      body: body(stream),
      signal: AbortSignal.timeout(60000),
    });
    console.log(`stream=${stream} status=${res.status} in ${Date.now() - started}ms`);
    const text = await res.text();
    console.log('  body:', text.slice(0, 300).replace(/\n/g, '\\n'));
  } catch (err) {
    console.log(`stream=${stream} FAIL in ${Date.now() - started}ms:`, err?.cause?.code || err?.message);
  }
}

await run(false);
await run(true);
process.exit(0);
