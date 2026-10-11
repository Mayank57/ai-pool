// Public inference endpoint (/v1/*). Authenticates AI Pool keys, enforces
// billing state and budgets, adds the workspace routing prefix to the model,
// and streams the request through CLIProxyAPI.
import http from 'node:http';
import https from 'node:https';
import { sha256 } from './security.mjs';
import { accountPrefix } from './pool.mjs';

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);
const MAX_BODY = 64 * 1024 * 1024;

export function providerForModel(model) {
  const m = String(model || '').toLowerCase();
  if (m.startsWith('claude')) return 'claude';
  if (m.startsWith('gpt') || m.startsWith('codex') || /^o\d/.test(m)) return 'codex';
  return null;
}

export function monthStart(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

function extractKey(req) {
  const x = req.headers['x-api-key'];
  if (x) return String(x).trim();
  const auth = String(req.headers.authorization || '');
  return auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
}

function sendError(res, path, status, type, message) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { 'Content-Type': 'application/json' });
  if (path.startsWith('/v1/messages')) res.end(JSON.stringify({ type: 'error', error: { type, message } }));
  else res.end(JSON.stringify({ error: { message, type, code: type } }));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error('request body too large'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export function createGateway({ db, cpaUrl }) {
  const target = new URL(cpaUrl);
  const agent = target.protocol === 'https:' ? https : http;

  function lookupKey(raw) {
    if (!raw) return null;
    return db
      .prepare(
        `SELECT k.*, w.prefix AS ws_prefix, w.billing_status, w.trial_ends_at, w.name AS ws_name
           FROM api_keys k JOIN workspaces w ON w.id = k.workspace_id
          WHERE k.key_hash = ? AND k.revoked_at IS NULL`,
      )
      .get(sha256(raw));
  }

  function budgetError(key) {
    if (key.budget_usd == null && key.budget_tokens == null) return null;
    const s = db
      .prepare(
        `SELECT COALESCE(SUM(cost),0) AS cost, COALESCE(SUM(uncached+unclassified+cache_read+cache_write+output),0) AS tokens
           FROM requests WHERE key_id = ? AND ts >= ?`,
      )
      .get(key.id, monthStart());
    if (key.budget_usd != null && s.cost >= key.budget_usd)
      return `Monthly budget of $${key.budget_usd} for key "${key.name}" is used up ($${s.cost.toFixed(2)}). Ask your workspace admin to raise it.`;
    if (key.budget_tokens != null && s.tokens >= key.budget_tokens)
      return `Monthly token budget of ${key.budget_tokens.toLocaleString()} for key "${key.name}" is used up. Ask your workspace admin to raise it.`;
    return null;
  }

  // Prefixes this key may route through, most specific first.
  function prefixesFor(key, provider) {
    const out = [];
    if (key.user_id && provider) {
      const hasPrivate = db
        .prepare(
          `SELECT 1 FROM accounts WHERE workspace_id = ? AND owner_user_id = ? AND visibility = 'private'
             AND provider = ? AND removed_at IS NULL AND disabled = 0 LIMIT 1`,
        )
        .get(key.workspace_id, key.user_id, provider);
      if (hasPrivate) out.push(accountPrefix({ prefix: key.ws_prefix }, { visibility: 'private', owner_user_id: key.user_id }));
    }
    out.push(key.ws_prefix);
    return out;
  }

  // No timeouts after the upstream connection is established (long streams are normal).
  function forward(req, res, path, search, headers, body) {
    return new Promise((resolve, reject) => {
      const up = agent.request(
        { protocol: target.protocol, hostname: target.hostname, port: target.port, method: req.method, path: path + search, headers },
        resolve,
      );
      up.on('error', reject);
      // Client went away: stop the upstream request too.
      res.once('close', () => up.destroy());
      if (body && body.length) up.end(body);
      else up.end();
    });
  }

  async function bufferBody(stream) {
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
  }

  function shouldFallBack(status, text) {
    if (status === 429 || status === 503 || status === 502) return true;
    return status >= 400 && status < 500 && /unknown provider|no available|model_not_found|auth_unavailable|cooling/i.test(text);
  }

  // The proxy's Anthropic-format model list doesn't handle routing prefixes,
  // so always fetch the OpenAI-format list and convert when needed.
  async function handleModels(req, res, key, search) {
    const headers = {};
    for (const [k, v] of Object.entries(pickHeaders(req.headers))) if (!k.startsWith('anthropic-')) headers[k] = v;
    headers.authorization = `Bearer ${key.cpa_key}`;
    const upstream = await forward(req, res, '/v1/models', '', headers, null);
    const raw = await bufferBody(upstream);
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      res.writeHead(upstream.statusCode, { 'Content-Type': 'application/json' });
      return res.end(raw);
    }
    const prefixes = [...new Set([...prefixesFor(key, 'claude'), ...prefixesFor(key, 'codex')])].map((p) => p + '/');
    const seen = new Set();
    const models = (Array.isArray(data.data) ? data.data : [])
      .filter((m) => prefixes.some((p) => String(m.id).startsWith(p)))
      .map((m) => ({ ...m, id: String(m.id).slice(String(m.id).indexOf('/') + 1) }))
      .filter((m) => (seen.has(m.id) ? false : seen.add(m.id)));
    let out;
    if (req.headers['anthropic-version']) {
      const list = models.map((m) => ({ type: 'model', id: m.id, display_name: m.id, created_at: new Date((m.created || 0) * 1000).toISOString() }));
      out = { data: list, has_more: false, first_id: list[0]?.id ?? null, last_id: list[list.length - 1]?.id ?? null };
    } else {
      out = { object: 'list', data: models };
    }
    res.writeHead(upstream.statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  }

  function pickHeaders(h) {
    const out = {};
    for (const [k, v] of Object.entries(h)) {
      const lk = k.toLowerCase();
      if (HOP.has(lk) || lk === 'authorization' || lk === 'x-api-key' || lk === 'cookie') continue;
      out[lk] = v;
    }
    return out;
  }

  return async function handle(req, res, url) {
    const path = url.pathname;
    const raw = extractKey(req);
    const key = lookupKey(raw);
    if (!key) return sendError(res, path, 401, 'authentication_error', 'Invalid or revoked AI Pool key.');
    if (key.billing_status === 'canceled' || (key.billing_status === 'trialing' && Date.now() > key.trial_ends_at))
      return sendError(res, path, 402, 'billing_error', `The free trial for workspace "${key.ws_name}" has ended. A workspace owner can activate billing in AI Pool → Billing.`);
    const over = budgetError(key);
    if (over) return sendError(res, path, 429, 'budget_exceeded', over);

    try {
      if (req.method === 'GET' && path === '/v1/models') return await handleModels(req, res, key, url.search);

      let body = await readBody(req);
      let json = null;
      if (body.length && String(req.headers['content-type'] || '').includes('json')) {
        try {
          json = JSON.parse(body.toString());
        } catch {
          return sendError(res, path, 400, 'invalid_request_error', 'Request body is not valid JSON.');
        }
      }
      const model = json && typeof json.model === 'string' ? json.model.trim() : null;
      if (model && model.includes('/')) return sendError(res, path, 400, 'invalid_request_error', 'Model names must not contain "/". Use the plain model id, e.g. claude-sonnet-5-5.');
      const prefixes = model ? prefixesFor(key, providerForModel(model)) : [key.ws_prefix];

      for (let i = 0; i < prefixes.length; i++) {
        let payload = body;
        if (model) payload = Buffer.from(JSON.stringify({ ...json, model: `${prefixes[i]}/${model}` }));
        const headers = { ...pickHeaders(req.headers), authorization: `Bearer ${key.cpa_key}`, 'content-length': String(payload.length) };
        const upstream = await forward(req, res, path, url.search, headers, payload);
        const last = i === prefixes.length - 1;
        if (!last && upstream.statusCode >= 400) {
          const text = (await bufferBody(upstream)).toString();
          if (shouldFallBack(upstream.statusCode, text)) continue; // private plan exhausted -> shared pool
          res.writeHead(upstream.statusCode, filterResponseHeaders(upstream.headers));
          return res.end(text);
        }
        res.writeHead(upstream.statusCode, filterResponseHeaders(upstream.headers));
        upstream.pipe(res);
        return;
      }
    } catch (err) {
      return sendError(res, path, err.status || 502, 'api_error', err.status ? err.message : `Upstream error: ${err.message}`);
    }
  };
}

function filterResponseHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h)) if (!HOP.has(k.toLowerCase())) out[k] = v;
  return out;
}
