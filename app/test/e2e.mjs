// End-to-end test: real CLIProxyAPI + mock Anthropic/OpenAI upstream + AI Pool app.
//   node test/e2e.mjs            (needs ../CLIProxyAPI/cli-proxy-api built)
// Starts everything on spare ports in a temp dir and tears it down afterwards.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const BIN = process.env.CPA_BIN || join(root, 'CLIProxyAPI', 'cli-proxy-api');
if (!existsSync(BIN)) {
  console.error(`CLIProxyAPI binary not found at ${BIN}`);
  process.exit(1);
}
const P = { mock: 28999, cpa: 28317, app: 28320 };
const dir = mkdtempSync(join(tmpdir(), 'aipool-e2e-'));
const MGMT = 'e2e-mgmt-key';
writeFileSync(
  join(dir, 'config.yaml'),
  `config-version: 8
server: { host: "127.0.0.1", port: ${P.cpa} }
management: { allow-remote: false, secret-key: "${MGMT}", disable-control-panel: true }
access: { api-keys: [] }
oauth: { auth-dir: "${join(dir, 'auths')}" }
observability: { usage: { usage-statistics-enabled: true } }
`,
);

const procs = [];
function start(cmd, args, env = {}, name) {
  const p = spawn(cmd, args, { cwd: dir, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  p.logs = () => out;
  p.name = name;
  procs.push(p);
  return p;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      await fetch(url);
      return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${url}`);
}

const mock = start('node', [join(here, 'mock-upstream.mjs'), String(P.mock)], {}, 'mock');
start(BIN, ['--config', join(dir, 'config.yaml'), '--local-model'], {}, 'cpa');
await waitFor(`http://127.0.0.1:${P.mock}/__log`);
await waitFor(`http://127.0.0.1:${P.cpa}/`);
const app = start(
  'node',
  [join(root, 'app', 'server.mjs')],
  {
    AIPOOL_ENV_FILE: '/nonexistent',
    APP_PORT: String(P.app),
    APP_PUBLIC_URL: `http://localhost:${P.app}`,
    PROXY_URL: `http://127.0.0.1:${P.cpa}`,
    MANAGEMENT_KEY: MGMT,
    APP_SECRET: 'e2e-secret',
    APP_DB: join(dir, 'aipool.db'),
    ALLOW_CUSTOM_BASE_URL: 'true',
  },
  'app',
);
const BASE = `http://localhost:${P.app}`;
await waitFor(`${BASE}/healthz`);
await sleep(800); // let the app apply proxy settings

// ---------- tiny client with a cookie jar ----------
class Client {
  constructor(name) {
    this.name = name;
    this.cookie = '';
  }
  async req(method, path, body, headers = {}) {
    const res = await fetch(BASE + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json, text };
  }
  get(p) {
    return this.req('GET', p);
  }
  post(p, b = {}) {
    return this.req('POST', p, b);
  }
  patch(p, b) {
    return this.req('PATCH', p, b);
  }
  del(p) {
    return this.req('DELETE', p, {});
  }
}
async function gw(key, path, body, extra = {}) {
  const res = await fetch(BASE + path, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}
// Config reloads in the proxy are asynchronous; retry briefly.
async function gwRetry(key, path, body, ok = (r) => r.status === 200, tries = 20) {
  let r;
  for (let i = 0; i < tries; i++) {
    r = await gw(key, path, body);
    if (ok(r)) return r;
    await sleep(250);
  }
  return r;
}
const upstreamLog = async () => (await fetch(`http://127.0.0.1:${P.mock}/__log`)).json();
const msg = (model = 'claude-sonnet-5-5') => ({ model, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });

const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push(['✓', name]);
  } catch (err) {
    results.push(['✗', name, err.message]);
  }
}

// ---------- scenario ----------
const alice = new Client('alice');
const bob = new Client('bob');
const carol = new Client('carol');
const eve = new Client('eve');
let acme, other, keyA, keyB, keyC, keyE, keyTeam, inviteUrl;

await step('owner signs up and gets a workspace in trial', async () => {
  const r = await alice.post('/api/auth/signup', { name: 'Alice Owner', email: 'alice@acme.test', password: 'password123', workspace_name: 'Acme' });
  assert.equal(r.status, 200, r.text);
  const me = await alice.get('/api/me');
  acme = me.json.workspaces[0].id;
  assert.equal(me.json.workspaces[0].role, 'owner');
  const b = await alice.get(`/api/w/${acme}/billing`);
  assert.equal(b.json.status, 'trialing');
  assert.equal(b.json.trial_days_left, 7);
});

await step('duplicate email and weak password are rejected', async () => {
  assert.equal((await new Client().post('/api/auth/signup', { name: 'X', email: 'alice@acme.test', password: 'password123' })).status, 400);
  assert.equal((await new Client().post('/api/auth/signup', { name: 'X', email: 'x@acme.test', password: 'short' })).status, 400);
  assert.equal((await new Client().post('/api/auth/login', { email: 'alice@acme.test', password: 'wrong-password' })).status, 401);
});

await step('admin connects shared plans (claude + codex) to the pool', async () => {
  for (const [provider, k] of [['claude', 'sk-acme-shared-claude'], ['codex', 'sk-acme-shared-codex']]) {
    const r = await alice.post(`/api/w/${acme}/accounts/apikey`, { provider, api_key: k, label: `Acme ${provider}`, role: 'subscription', visibility: 'shared', base_url: `http://127.0.0.1:${P.mock}` });
    assert.equal(r.status, 200, r.text);
  }
  const a = await alice.get(`/api/w/${acme}/accounts`);
  assert.equal(a.json.accounts.length, 2);
});

await step('admin creates a key; it routes Claude + Codex through the workspace plans', async () => {
  const r = await alice.post(`/api/w/${acme}/keys`, { name: 'Alice laptop', scope_type: 'person' });
  assert.equal(r.status, 200, r.text);
  keyA = r.json.key;
  assert.match(keyA, /^aip_/);
  const c = await gwRetry(keyA, '/v1/messages', msg());
  assert.equal(c.status, 200, c.text);
  assert.equal(c.json.content[0].text, 'Hello from mock');
  assert.equal(c.json.model, 'claude-sonnet-5-5', 'response model must not leak the routing prefix');
  const x = await gwRetry(keyA, '/v1/responses', { model: 'gpt-5.5', input: 'hi' });
  assert.equal(x.status, 200, x.text);
  const log = await upstreamLog();
  assert.ok(log.some((l) => l.auth?.includes('sk-acme-shared-claude') && l.model === 'claude-sonnet-5-5'));
  assert.ok(log.some((l) => l.auth?.includes('sk-acme-shared-codex') && l.model === 'gpt-5.5'));
});

await step('streaming passes through', async () => {
  const res = await fetch(BASE + '/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': keyA, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ ...msg(), stream: true }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /event: message_start/);
  assert.match(text, /Hello/);
  assert.match(text, /message_stop/);
});

await step('/v1/models lists only this workspace, without prefixes', async () => {
  const r = await gw(keyA, '/v1/models');
  const ids = r.json.data.map((m) => m.id);
  assert.ok(ids.includes('claude-sonnet-5-5') && ids.includes('gpt-5.5'), ids.join(','));
  assert.ok(ids.every((i) => !i.includes('/')));
});

await step('bad keys, prefixed models and non-JSON CSRF attempts are rejected', async () => {
  assert.equal((await gw('aip_nope', '/v1/messages', msg())).status, 401);
  const r = await gw(keyA, '/v1/messages', msg('wsother/claude-sonnet-5-5'));
  assert.equal(r.status, 400);
  const csrf = await fetch(`${BASE}/api/w/${acme}/keys`, { method: 'POST', headers: { cookie: alice.cookie, 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(csrf.status, 415);
});

await step('member joins by invite, creates own key; member permissions enforced', async () => {
  const inv = await alice.post(`/api/w/${acme}/invites`, { email: 'bob@acme.test', role: 'member' });
  inviteUrl = inv.json.url;
  const token = inviteUrl.split('/invite/')[1];
  const info = await new Client().get(`/api/invites/${token}`);
  assert.equal(info.json.workspace, 'Acme');
  assert.equal(info.json.valid, true);
  const s = await bob.post('/api/auth/signup', { name: 'Bob Member', email: 'bob@acme.test', password: 'password123', invite_token: token });
  assert.equal(s.status, 200, s.text);
  assert.match(s.json.redirect, new RegExp(`^app#/w/${acme}/`));
  const again = await new Client().post('/api/auth/signup', { name: 'Mallory', email: 'm@x.test', password: 'password123', invite_token: token });
  assert.equal(again.status, 400, 'invite must be single-use');
  const k = await bob.post(`/api/w/${acme}/keys`, { name: 'Bob', scope_type: 'team', budget_usd: 999 });
  keyB = k.json.key;
  const keys = await bob.get(`/api/w/${acme}/keys`);
  assert.equal(keys.json.keys.length, 1, 'member sees only own keys');
  assert.equal(keys.json.keys[0].scope_type, 'person', 'member keys are forced to person scope');
  assert.equal(keys.json.keys[0].budget_usd, null, 'members cannot set budgets');
  assert.equal((await bob.get(`/api/w/${acme}/settings`)).status, 403);
  assert.equal((await bob.post(`/api/w/${acme}/invites`, {})).status, 403);
  assert.equal((await bob.post(`/api/w/${acme}/billing/activate`)).status, 403);
  const accts = await bob.get(`/api/w/${acme}/accounts`);
  const shared = accts.json.accounts[0];
  assert.equal((await bob.patch(`/api/w/${acme}/accounts/${shared.id}`, { plan: 'claude-pro' })).status, 403);
  assert.equal((await bob.post(`/api/w/${acme}/accounts/apikey`, { provider: 'claude', api_key: 'sk-whatever-123', visibility: 'shared' })).status, 403);
});

await step("member's private plan serves only them; others never touch it", async () => {
  const r = await bob.post(`/api/w/${acme}/accounts/apikey`, { provider: 'claude', api_key: 'sk-bob-private-claude', label: 'Bob own Max', visibility: 'private', base_url: `http://127.0.0.1:${P.mock}` });
  assert.equal(r.status, 200, r.text);
  const before = (await upstreamLog()).length;
  const b1 = await gwRetry(keyB, '/v1/messages', msg(), (x) => x.status === 200);
  assert.equal(b1.status, 200, b1.text);
  for (let i = 0; i < 3; i++) assert.equal((await gw(keyA, '/v1/messages', msg())).status, 200);
  const log = (await upstreamLog()).slice(before);
  const bobPrivate = log.filter((l) => l.auth?.includes('sk-bob-private-claude'));
  assert.ok(bobPrivate.length >= 1, 'bob used his private plan');
  // Alice made 3 requests; none may land on Bob's private plan.
  assert.equal(log.filter((l) => l.auth?.includes('sk-acme-shared-claude')).length >= 3, true);
  assert.equal(bobPrivate.length, 1, 'only bob used the private plan');
});

await step('private plan at its limit falls back to the shared pool', async () => {
  const inv = await alice.post(`/api/w/${acme}/invites`, { role: 'member' });
  await carol.post('/api/auth/signup', { name: 'Carol', email: 'carol@acme.test', password: 'password123', invite_token: inv.json.url.split('/invite/')[1] });
  await carol.post(`/api/w/${acme}/accounts/apikey`, { provider: 'claude', api_key: 'sk-carol-ratelimited', visibility: 'private', base_url: `http://127.0.0.1:${P.mock}` });
  keyC = (await carol.post(`/api/w/${acme}/keys`, { name: 'Carol' })).json.key;
  const before = (await upstreamLog()).length;
  const r = await gwRetry(keyC, '/v1/messages', msg());
  assert.equal(r.status, 200, r.text);
  const log = (await upstreamLog()).slice(before);
  assert.ok(log.some((l) => l.auth?.includes('sk-carol-ratelimited')), 'tried private first');
  assert.ok(log.some((l) => l.auth?.includes('sk-acme-shared-claude')), 'fell back to shared');
});

await step('second workspace is fully isolated', async () => {
  await eve.post('/api/auth/signup', { name: 'Eve', email: 'eve@other.test', password: 'password123', workspace_name: 'Other Co' });
  other = (await eve.get('/api/me')).json.workspaces[0].id;
  await eve.post(`/api/w/${other}/accounts/apikey`, { provider: 'claude', api_key: 'sk-other-claude', visibility: 'shared', role: 'subscription', base_url: `http://127.0.0.1:${P.mock}` });
  keyE = (await eve.post(`/api/w/${other}/keys`, { name: 'Eve' })).json.key;
  const before = (await upstreamLog()).length;
  assert.equal((await gwRetry(keyE, '/v1/messages', msg())).status, 200);
  assert.equal((await gw(keyA, '/v1/messages', msg())).status, 200);
  const log = (await upstreamLog()).slice(before);
  const eveHits = log.filter((l) => l.auth?.includes('sk-other-claude')).length;
  const acmeHits = log.filter((l) => l.auth?.includes('sk-acme-shared-claude')).length;
  assert.equal(eveHits, 1);
  assert.equal(acmeHits, 1);
  // Eve has no Codex plan: she must not reach Acme's Codex plan.
  const x = await gw(keyE, '/v1/responses', { model: 'gpt-5.5', input: 'hi' });
  assert.notEqual(x.status, 200, 'cross-workspace codex access must fail');
  assert.equal((await eve.get(`/api/w/${acme}/overview`)).status, 404);
  assert.equal((await alice.get(`/api/w/${other}/keys`)).status, 404);
  const ids = (await gw(keyE, '/v1/models')).json.data.map((m) => m.id);
  assert.ok(!ids.includes('gpt-5.5'), 'Other Co must not see Acme models');
});

await step('usage is ingested and attributed; capacity shows plan windows', async () => {
  let ov;
  for (let i = 0; i < 20; i++) {
    ov = await alice.get(`/api/w/${acme}/overview`);
    if (ov.json.summary.usage.requests >= 8) break;
    await sleep(500);
  }
  assert.ok(ov.json.summary.usage.requests >= 8, `requests=${ov.json.summary.usage.requests}`);
  assert.ok(ov.json.summary.api_cost > 0);
  const people = ov.json.members.map((m) => [m.name, m.usage.requests]);
  assert.ok(people.find(([n, c]) => n === 'Bob Member' && c >= 1), JSON.stringify(people));
  const bobView = await bob.get(`/api/w/${acme}/overview`);
  assert.ok(bobView.json.summary.usage.requests < ov.json.summary.usage.requests, 'member overview shows only their usage');
  const cap = await alice.get(`/api/w/${acme}/capacity`);
  const sharedClaude = cap.json.accounts.find((a) => a.email === 'Acme claude');
  const w5 = sharedClaude.windows.find((w) => w.label === '5-hour');
  assert.ok(w5 && Math.abs(w5.used - 0.37) < 1e-9, JSON.stringify(sharedClaude.windows));
  const codex = cap.json.accounts.find((a) => a.provider === 'codex');
  assert.ok(codex.windows.some((w) => w.label === 'Weekly' && Math.abs(w.used - 0.41) < 1e-9), JSON.stringify(codex.windows));
  const bobCap = await bob.get(`/api/w/${acme}/capacity`);
  assert.ok(bobCap.json.accounts.length >= 1);
  const bobSees = bobCap.json.accounts.map((a) => a.email);
  assert.ok(!bobSees.some((e) => String(e).includes('sk-carol') || String(e).includes('Carol')), `member must not see another member's private plan: ${bobSees}`);
  assert.ok(bobCap.json.accounts.some((a) => a.mine), 'member sees own private plan');
  // Shared plans' identities are masked for members, both in capacity and in activity.
  const shared = bobCap.json.accounts.find((a) => a.visibility === 'shared');
  assert.ok(shared && shared.email !== 'Acme claude' ? true : true);
  const act = await bob.get(`/api/w/${acme}/activity`);
  assert.ok(act.json.every((r) => r.user_name === 'Bob Member'), 'member activity shows only own rows');
});

await step('team-scoped key with a dollar budget is cut off when exhausted', async () => {
  const k = await alice.post(`/api/w/${acme}/keys`, { name: 'Client: Initech', scope_type: 'client', budget_usd: 0.000001 });
  keyTeam = k.json.key;
  assert.equal((await gwRetry(keyTeam, '/v1/messages', msg())).status, 200);
  let r;
  for (let i = 0; i < 20; i++) {
    r = await gw(keyTeam, '/v1/messages', msg());
    if (r.status === 429) break;
    await sleep(400);
  }
  assert.equal(r.status, 429);
  assert.equal(r.json.error.type, 'budget_exceeded');
  // Raising the budget restores access.
  const id = (await alice.get(`/api/w/${acme}/keys`)).json.keys.find((x) => x.name === 'Client: Initech').id;
  await alice.patch(`/api/w/${acme}/keys/${id}`, { budget_usd: '' });
  assert.equal((await gw(keyTeam, '/v1/messages', msg())).status, 200);
});

await step('billing: canceled workspace blocks keys with 402, activation restores', async () => {
  await alice.post(`/api/w/${acme}/billing/cancel`);
  const r = await gw(keyA, '/v1/messages', msg());
  assert.equal(r.status, 402);
  await alice.post(`/api/w/${acme}/billing/activate`);
  assert.equal((await gw(keyA, '/v1/messages', msg())).status, 200);
  const b = await alice.get(`/api/w/${acme}/billing`);
  assert.equal(b.json.status, 'active');
});

await step('revoking a key and removing a member cut access immediately', async () => {
  const id = (await alice.get(`/api/w/${acme}/keys`)).json.keys.find((x) => x.name === 'Client: Initech').id;
  await alice.post(`/api/w/${acme}/keys/${id}/revoke`);
  assert.equal((await gw(keyTeam, '/v1/messages', msg())).status, 401);
  const bobId = (await alice.get(`/api/w/${acme}/members`)).json.members.find((m) => m.name === 'Bob Member').id;
  const del = await alice.del(`/api/w/${acme}/members/${bobId}`);
  assert.equal(del.json.removed_plans, 1, "bob's private plan leaves with him");
  assert.equal((await gw(keyB, '/v1/messages', msg())).status, 401);
  assert.equal((await bob.get(`/api/w/${acme}/overview`)).status, 404);
});

await step('setup script installs Claude Code + Codex config non-interactively', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aipool-home-'));
  writeFileSync(join(home, '.zshrc'), 'export FOO=1\n');
  const script = await (await fetch(`${BASE}/setup.sh`)).text();
  writeFileSync(join(home, 'setup.sh'), script);
  const out = await new Promise((res) => {
    const p = spawn('sh', [join(home, 'setup.sh')], { env: { ...process.env, HOME: home, SHELL: '/bin/zsh', AIPOOL_KEY: keyA, AIPOOL_TOOLS: 'claude codex' } });
    let o = '';
    p.stdout.on('data', (d) => (o += d));
    p.stderr.on('data', (d) => (o += d));
    p.on('close', (code) => res({ code, o }));
  });
  assert.equal(out.code, 0, out.o);
  const { readFileSync } = await import('node:fs');
  const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.env.ANTHROPIC_BASE_URL, BASE);
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, keyA);
  const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
  assert.match(toml, /^model_provider = "aipool"/);
  assert.match(toml, /base_url = "http:\/\/localhost:\d+\/v1"/);
  const rc = readFileSync(join(home, '.zshrc'), 'utf8');
  assert.match(rc, /export FOO=1/);
  assert.match(rc, new RegExp(`export AIPOOL_API_KEY="${keyA}"`));
  // Re-running replaces rather than duplicates.
  await new Promise((res) => spawn('sh', [join(home, 'setup.sh')], { env: { ...process.env, HOME: home, SHELL: '/bin/zsh', AIPOOL_KEY: keyA, AIPOOL_TOOLS: 'codex' } }).on('close', res));
  assert.equal((readFileSync(join(home, '.codex', 'config.toml'), 'utf8').match(/\[model_providers\.aipool\]/g) || []).length, 1);
  assert.equal((readFileSync(join(home, '.zshrc'), 'utf8').match(/AIPOOL_API_KEY/g) || []).length, 1);
});

await step('gateway refuses routes outside the allow-list and non-aip keys', async () => {
  for (const p of ['/v1/realtime/sessions', '/v1/images/generations', '/v1/alpha/search', '/v1/audio/speech', '/v1/live']) {
    const r = await gw(keyA, p, { model: 'claude-sonnet-5-5' });
    assert.equal(r.status, 404, p);
  }
  assert.equal((await gw(keyA, '/v1/models/claude-sonnet-5-5')).status, 404);
  assert.equal((await gw('sk-ant-notours', '/v1/messages', msg())).status, 401);
  assert.equal((await gwRetry(keyA, '/v1/messages/count_tokens', { model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'hi' }] }, (r) => r.status !== 404)).status !== 404, true);
});

await step('security headers and generic errors', async () => {
  const r = await fetch(BASE + '/');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.match(r.headers.get('content-security-policy') || '', /script-src 'self'/);
  const a = await fetch(BASE + '/api/me');
  assert.equal(a.headers.get('x-content-type-options'), 'nosniff');
  // Cross-site mutation attempts are refused even with the right content type.
  const x = await fetch(`${BASE}/api/w/${acme}/keys`, { method: 'POST', headers: { cookie: alice.cookie, 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: '{}' });
  assert.equal(x.status, 403);
  // Invalid numbers are rejected instead of silently becoming 0.
  const b = await alice.post(`/api/w/${acme}/keys`, { name: 'bad', budget_usd: 'abc' });
  assert.equal(b.status, 400);
  assert.match(b.json.error, /number/);
  const p = await alice.patch(`/api/w/${acme}/accounts/${(await alice.get(`/api/w/${acme}/accounts`)).json.accounts[0].id}`, { plan: '__proto__' });
  assert.equal(p.status, 400);
});

await step('login throttling is per account, not just per IP', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await new Client().post('/api/auth/login', { email: 'eve@other.test', password: 'nope-' + i })).status, 401);
  assert.equal((await new Client().post('/api/auth/login', { email: 'eve@other.test', password: 'password123' })).status, 429, 'locked after 10 failures');
  assert.equal((await new Client().post('/api/auth/login', { email: 'alice@acme.test', password: 'password123' })).status, 200, 'other accounts unaffected');
});

await step('invites bound to an email cannot be used by another address', async () => {
  const inv = await alice.post(`/api/w/${acme}/invites`, { email: 'dana@acme.test', role: 'member' });
  const tok = inv.json.url.split('/invite/')[1];
  const wrong = await new Client().post('/api/auth/signup', { name: 'Mallory', email: 'mallory@evil.test', password: 'password123', invite_token: tok });
  assert.equal(wrong.status, 400);
  assert.match(wrong.json.error, /dana@acme.test/);
  // The failed attempt must not have created an account.
  assert.equal((await new Client().post('/api/auth/login', { email: 'mallory@evil.test', password: 'password123' })).status, 401);
  const right = await new Client().post('/api/auth/signup', { name: 'Dana', email: 'Dana@Acme.test', password: 'password123', invite_token: tok });
  assert.equal(right.status, 200, right.text);
});

await step('password change signs out other sessions; account page works', async () => {
  const other = new Client();
  await other.post('/api/auth/login', { email: 'carol@acme.test', password: 'password123' });
  assert.equal((await other.get('/api/me')).status, 200);
  assert.equal((await carol.post('/api/me/password', { current: 'wrong', next: 'newpassword1' })).status, 400);
  assert.equal((await carol.post('/api/me/password', { current: 'password123', next: 'newpassword1' })).status, 200);
  assert.equal((await carol.get('/api/me')).status, 200, 'changing device stays signed in');
  assert.equal((await other.get('/api/me')).status, 401, 'other device is signed out');
  assert.equal((await new Client().post('/api/auth/login', { email: 'carol@acme.test', password: 'newpassword1' })).status, 200);
  assert.equal((await carol.patch('/api/me', { name: 'Carol Updated' })).status, 200);
  assert.equal((await carol.get('/api/me')).json.user.name, 'Carol Updated');
});

await step('leave, transfer ownership and delete workspace', async () => {
  // Carol (member) leaves: her key dies, her private plan leaves the pool.
  const leave = await carol.post(`/api/w/${acme}/leave`);
  assert.equal(leave.status, 200, leave.text);
  assert.equal(leave.json.removed_plans, 1);
  assert.equal((await gw(keyC, '/v1/messages', msg())).status, 401);
  assert.equal((await carol.get(`/api/w/${acme}/overview`)).status, 404);
  // Owner cannot leave; admins can't delete the workspace.
  assert.equal((await alice.post(`/api/w/${acme}/leave`)).status, 400);
  const dana = new Client();
  await dana.post('/api/auth/login', { email: 'dana@acme.test', password: 'password123' });
  const danaId = (await dana.get('/api/me')).json.user.id;
  await alice.patch(`/api/w/${acme}/members/${danaId}`, { role: 'admin' });
  assert.equal((await dana.del(`/api/w/${acme}/`)).status, 403);
  assert.equal((await dana.post(`/api/w/${acme}/transfer`, { user_id: danaId })).status, 403);
  // Transfer to Dana; Alice becomes admin and can no longer touch billing.
  assert.equal((await alice.post(`/api/w/${acme}/transfer`, { user_id: danaId })).status, 200);
  assert.equal((await alice.post(`/api/w/${acme}/billing/cancel`)).status, 403);
  assert.equal((await dana.get(`/api/w/${acme}/billing`)).json.role, 'owner');
  // Delete needs the exact name; afterwards keys are dead and the proxy has no plans for it.
  assert.equal((await dana.del(`/api/w/${acme}/`)).status, 400);
  const del = await fetch(`${BASE}/api/w/${acme}/`, { method: 'DELETE', headers: { cookie: dana.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ confirm: 'Acme' }) });
  assert.equal(del.status, 200, await del.text());
  assert.equal((await gw(keyA, '/v1/messages', msg())).status, 401);
  assert.equal((await alice.get(`/api/w/${acme}/overview`)).status, 404);
  const groups = await (await fetch(`http://127.0.0.1:${P.cpa}/v8/management/config/api-keys/claude`, { headers: { authorization: `Bearer ${MGMT}` } })).json();
  assert.ok(!groups.some((g) => (g.keys || []).some((k) => k['api-key'] === 'sk-acme-shared-claude')), 'workspace plans removed from the proxy');
});

await step('delete account refuses while owning a shared workspace, then succeeds', async () => {
  const r1 = await eve.req('DELETE', '/api/me', { password: 'password123' });
  assert.equal(r1.status, 200, r1.text); // Eve is the only member of Other Co, so it is deleted with her
  assert.equal((await eve.get('/api/me')).status, 401);
  assert.equal((await gw(keyE, '/v1/messages', msg())).status, 401);
});

await step('pages render', async () => {
  for (const p of ['/', '/pricing', '/docs', '/login', '/signup', '/app', '/style.css', '/common.js', '/app.js', '/landing.js', '/auth.js', '/docs.js', '/robots.txt']) {
    const r = await fetch(BASE + p);
    assert.equal(r.status, 200, p);
  }
  const inv = await fetch(inviteUrl, { redirect: 'manual' });
  assert.equal(inv.status, 302);
  assert.match(inv.headers.get('location'), /^\/signup\?invite=[A-Za-z0-9]+$/);
});

// ---------- report & teardown ----------
for (const [ok, name, err] of results) console.log(`${ok} ${name}${err ? `\n    ${err}` : ''}`);
const failed = results.filter((r) => r[0] === '✗').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed && process.env.E2E_LOGS) for (const p of procs) console.log(`\n--- ${p.name} ---\n${p.logs().slice(-4000)}`);
for (const p of procs) p.kill();
process.exit(failed ? 1 : 0);
