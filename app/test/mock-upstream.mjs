// Fake Anthropic + OpenAI Responses upstream for local end-to-end tests.
// Returns realistic usage blocks and subscription rate-limit headers.
import http from 'node:http';

const port = Number(process.argv[2] || 18999);
const log = [];

function claudeHeaders(res) {
  const now = Math.floor(Date.now() / 1000);
  res.setHeader('anthropic-ratelimit-unified-status', 'allowed');
  res.setHeader('anthropic-ratelimit-unified-5h-utilization', '0.37');
  res.setHeader('anthropic-ratelimit-unified-5h-reset', String(now + 2 * 3600));
  res.setHeader('anthropic-ratelimit-unified-7d-utilization', '0.12');
  res.setHeader('anthropic-ratelimit-unified-7d-reset', String(now + 4 * 86400));
}
function codexHeaders(res) {
  res.setHeader('x-codex-primary-used-percent', '23');
  res.setHeader('x-codex-primary-window-minutes', '300');
  res.setHeader('x-codex-primary-reset-after-seconds', '5400');
  res.setHeader('x-codex-secondary-used-percent', '41');
  res.setHeader('x-codex-secondary-window-minutes', '10080');
  res.setHeader('x-codex-secondary-reset-after-seconds', '259200');
}

http
  .createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    let j = {};
    try { j = JSON.parse(body); } catch {}
    log.push({ path: req.url, model: j.model, auth: req.headers['x-api-key'] || req.headers.authorization });
    if (req.url === '/__log') { res.end(JSON.stringify(log)); return; }
    const auth = String(req.headers['x-api-key'] || req.headers.authorization || '');
    if (auth.includes('ratelimited')) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '120' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'mock: plan limit reached' } }));
      return;
    }
    if (req.url.includes('/messages')) {
      claudeHeaders(res);
      const usage = { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 3000, cache_creation_input_tokens: 500 };
      if (j.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify(d)}\n\n`);
        ev('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: j.model, content: [], stop_reason: null, usage: { ...usage, output_tokens: 1 } } });
        ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        for (const w of ['Hello', ' from', ' mock']) { ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: w } }); await new Promise((r) => setTimeout(r, 30)); }
        ev('content_block_stop', { type: 'content_block_stop', index: 0 });
        ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 40 } });
        ev('message_stop', { type: 'message_stop' });
        res.end();
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: j.model, content: [{ type: 'text', text: 'Hello from mock' }], stop_reason: 'end_turn', usage }));
      }
      return;
    }
    if (req.url.includes('/responses')) {
      codexHeaders(res);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const resp = { id: 'resp_1', object: 'response', model: j.model, status: 'completed', output: [{ type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'output_text', text: 'Hello from mock codex' }] }],
        usage: { input_tokens: 2000, input_tokens_details: { cached_tokens: 1500 }, output_tokens: 80, output_tokens_details: { reasoning_tokens: 30 }, total_tokens: 2080 } };
      const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
      ev('response.created', { response: { ...resp, status: 'in_progress', output: [] } });
      ev('response.output_text.delta', { item_id: 'm1', output_index: 0, content_index: 0, delta: 'Hello from mock codex' });
      ev('response.completed', { response: resp });
      res.end();
      return;
    }
    res.writeHead(404).end('{}');
  })
  .listen(port, '127.0.0.1', () => console.log('mock upstream on', port));
