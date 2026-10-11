// AI Pool static demo: an in-browser stand-in for the AI Pool server.
// It intercepts fetch() calls to /api/* and /v1/* and answers them from
// state kept in this browser's localStorage. Nothing leaves the browser.
import { DEFAULT_PRICES, DEFAULT_PLANS, PLATFORM, resolvePrice, costOf } from './pricing.mjs';

const KEY = 'aipool_demo_v1';
const DAY = 86400000;
const MONTH_DAYS = 30.4375;
const realFetch = window.fetch.bind(window);

// ---------- state ----------

function blank() {
  return { seq: 1, session: null, users: [], workspaces: [], memberships: [], invites: [], keys: [], accounts: [], requests: [], oauth: {} };
}
let st;
try {
  st = JSON.parse(localStorage.getItem(KEY)) || blank();
} catch {
  st = blank();
}
const save = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(st));
  } catch {}
};
const id = () => st.seq++;
const now = () => Date.now();
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const token = (n = 24) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 56]).join('');

export function resetDemo() {
  localStorage.removeItem(KEY);
  Object.keys(localStorage).filter((k) => k.startsWith('aipool_demo_oauth_')).forEach((k) => localStorage.removeItem(k));
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (m) => new HttpError(400, m);

// ---------- domain helpers ----------

function createWorkspace(name, userId, { trialDays = PLATFORM.trialDays } = {}) {
  const ws = { id: id(), name, prefix: 'ws' + token(6).toLowerCase(), created_by: userId, created_at: now(), trial_ends_at: now() + trialDays * DAY, billing_status: 'trialing', activated_at: null, seat_baseline_monthly: 120, plans: {}, price_overrides: {} };
  st.workspaces.push(ws);
  st.memberships.push({ ws: ws.id, user: userId, role: 'owner', created_at: now() });
  return ws;
}
const membership = (wsId, userId) => st.memberships.find((m) => m.ws === wsId && m.user === userId);
const user = (uid) => st.users.find((u) => u.id === uid);
const plansOf = (ws) => ({ ...DEFAULT_PLANS, ...(ws.plans || {}) });
const pricesOf = (ws) => ({ ...DEFAULT_PRICES, ...(ws.price_overrides || {}) });
function accountMonthly(a, plans) {
  if (a.role === 'overflow' || a.kind === 'apikey') return 0;
  if (a.monthly_cost != null) return a.monthly_cost;
  if (a.plan && plans[a.plan]) return plans[a.plan].monthly;
  return 0;
}
const tokTotal = (r) => r.uncached + r.cache_read + r.cache_write + r.output;
function guessPlan(provider, t) {
  t = String(t || '');
  if (provider === 'codex') return t.includes('pro') ? 'chatgpt-pro' : t.includes('business') ? 'chatgpt-business' : 'chatgpt-plus';
  return t.includes('20x') ? 'claude-max-20x' : t.includes('max') ? 'claude-max-5x' : 'claude-pro';
}

function addRequest(ws, { key, account, model, ts = now(), scale = 1, failed = false, ua = 'claude-cli/2.1' }) {
  const provider = model.startsWith('claude') ? 'claude' : 'codex';
  const r = {
    id: id(), ts, ws: ws.id, key_id: key?.id ?? null, user_id: key?.user_id ?? null, account_id: account?.id ?? null, provider, model,
    uncached: Math.round(rnd(2000, 20000) * scale), cache_read: Math.round(rnd(60000, 600000) * scale), cache_write: Math.round(rnd(0, 30000) * scale),
    output: Math.round(rnd(800, 16000) * scale), failed: failed ? 1 : 0, status_code: failed ? 429 : 200, latency_ms: Math.round(rnd(1500, 40000)), user_agent: ua,
  };
  const { price, key: pk } = resolvePrice(model, provider, pricesOf(ws));
  r.cost = failed ? 0 : costOf({ uncached: r.uncached, cacheRead: r.cache_read, cacheWrite: r.cache_write, output: r.output, unclassified: 0 }, price);
  r.price_key = pk;
  st.requests.push(r);
  if (key) key.last_used_at = Math.max(key.last_used_at || 0, ts);
  if (account && !failed) touchQuota(account);
  return r;
}

// Simulated rate-limit windows that move as the account is used.
function touchQuota(a) {
  a.quota = a.quota || { u5: rnd(0.05, 0.3), u7: rnd(0.05, 0.25), r5: now() + rnd(1, 4.5) * 3600000, r7: now() + rnd(1, 6) * DAY };
  a.quota.u5 = Math.min(0.97, a.quota.u5 + rnd(0.005, 0.02));
  a.quota.u7 = Math.min(0.95, a.quota.u7 + rnd(0.001, 0.004));
  a.quota_at = now();
}

const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001'];
const CODEX_MODELS = ['gpt-6-sol', 'gpt-6.1-sol', 'gpt-5.6-terra', 'gpt-5.5'];

// A populated sample workspace so dashboards have something to show.
function seedSample(ownerId) {
  const ws = createWorkspace('Acme Robotics (sample data)', ownerId, { trialDays: 4 });
  ws.created_at = now() - 34 * DAY;
  ws.billing_status = 'active';
  ws.activated_at = now() - 27 * DAY;
  const people = [['Priya Shah', 'priya'], ['Leo Martin', 'leo'], ['Sam Okafor', 'sam'], ['Dana Kim', 'dana'], ['Ravi Patel', 'ravi']].map(([name, e], i) => {
    const u = { id: id(), name, email: `${e}@acme-robotics.test`, pw: null, sample: true };
    st.users.push(u);
    st.memberships.push({ ws: ws.id, user: u.id, role: i === 0 ? 'admin' : 'member', created_at: now() - (30 - i) * DAY });
    return u;
  });
  const acct = (provider, email, plan, extra = {}) => {
    const a = { id: id(), ws: ws.id, kind: 'oauth', role: 'subscription', provider, email, label: null, account_type: plan, visibility: 'shared', owner_user_id: ownerId, plan, monthly_cost: null, disabled: false, status: 'active', created_at: now() - 33 * DAY, removed_at: null, ...extra };
    st.accounts.push(a);
    return a;
  };
  const shared = [acct('claude', 'eng-1@acme-robotics.test', 'claude-max-20x'), acct('claude', 'eng-2@acme-robotics.test', 'claude-max-20x'), acct('codex', 'eng-gpt@acme-robotics.test', 'chatgpt-pro')];
  const priyaOwn = acct('claude', 'priya@personal.test', 'claude-max-5x', { visibility: 'private', owner_user_id: people[0].id });
  const mkKey = (name, scope, uid, budget) => {
    const k = { id: id(), ws: ws.id, name, scope_type: scope, user_id: uid, created_by: ownerId, key: 'aip_' + token(40), budget_usd: budget ?? null, budget_tokens: null, created_at: now() - 30 * DAY, revoked_at: null, last_used_at: null };
    k.key_hint = k.key.slice(0, 8) + '…' + k.key.slice(-4);
    st.keys.push(k);
    return k;
  };
  const keys = [mkKey('Your laptop', 'person', ownerId), ...people.map((p) => mkKey(`${p.name.split(' ')[0]} laptop`, 'person', p.id)), mkKey('Client: Initech', 'client', null, 400), mkKey('CI review bot', 'project', null, 150)];
  const weight = [1.4, 1.8, 1.0, 0.7, 1.2, 0.5, 0.8, 0.6];
  for (let d = 30; d >= 0; d--) {
    const day = now() - d * DAY;
    const weekend = [0, 6].includes(new Date(day).getDay());
    const n = Math.round((weekend ? 40 : 150) * rnd(0.75, 1.25));
    for (let i = 0; i < n; i++) {
      const ki = Math.floor(Math.random() * keys.length);
      if (Math.random() > weight[ki] / 1.8) continue;
      const key = keys[ki];
      const codex = Math.random() < 0.3;
      const model = codex ? pick(CODEX_MODELS) : Math.random() < 0.55 ? 'claude-opus-5-5' : pick(CLAUDE_MODELS);
      const account = codex ? shared[2] : key.user_id === people[0].id && Math.random() < 0.7 ? priyaOwn : pick(shared.slice(0, 2));
      addRequest(ws, { key, account, model, ts: day - rnd(0, DAY * 0.9), scale: 2.2, failed: Math.random() < 0.015, ua: codex ? 'codex_cli_rs/0.50' : 'claude-cli/2.1' });
    }
  }
  st.invites.push({ id: id(), ws: ws.id, email: 'new.hire@acme-robotics.test', role: 'member', token: token(), created_by: ownerId, created_at: now() - DAY, expires_at: now() + 13 * DAY, accepted_by: null, accepted_at: null, revoked: 0 });
  return ws;
}

// ---------- reports (same math as the server) ----------

function inRange(r, ws, from, to, uid) {
  return r.ws === ws.id && r.ts >= from && r.ts < to && (uid == null || r.user_id === uid);
}
function agg(rows) {
  const o = { requests: rows.length, failed: 0, input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0, tokens: 0, api_cost: 0 };
  for (const r of rows) {
    o.failed += r.failed;
    o.input_tokens += r.uncached;
    o.cache_read_tokens += r.cache_read;
    o.cache_write_tokens += r.cache_write;
    o.output_tokens += r.output;
    o.tokens += tokTotal(r);
    o.api_cost += r.cost;
  }
  return o;
}
function groupBy(rows, fn) {
  const m = new Map();
  for (const r of rows) {
    const k = fn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}
const monthStart = () => new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();

function summary(ws, from, to, uid) {
  const days = Math.max((to - from) / DAY, 1 / 24);
  const rows = st.requests.filter((r) => inRange(r, ws, from, to, uid));
  const usage = agg(rows);
  const accById = new Map(st.accounts.map((a) => [a.id, a]));
  const overflow = rows.filter((r) => accById.get(r.account_id)?.kind === 'apikey').reduce((s, r) => s + r.cost, 0);
  const plans = plansOf(ws);
  const accounts = st.accounts.filter((a) => a.ws === ws.id && !a.removed_at);
  const monthly = accounts.reduce((s, a) => s + accountMonthly(a, plans), 0);
  const subCost = (monthly * days) / MONTH_DAYS;
  const active = new Set(st.requests.filter((r) => inRange(r, ws, from, to) && r.user_id != null).map((r) => r.user_id)).size;
  const seatCost = (ws.seat_baseline_monthly * active * days) / MONTH_DAYS;
  const subValue = usage.api_cost - overflow;
  return {
    days, usage, api_cost: usage.api_cost, overflow_cost: overflow, subscription_value: subValue, subscription_cost: subCost, monthly_subscriptions: monthly,
    accounts: accounts.length, unpriced_accounts: accounts.filter((a) => a.kind === 'oauth' && !a.plan && a.monthly_cost == null).length,
    savings_vs_api: subValue - subCost, value_multiple: subCost > 0 ? subValue / subCost : null,
    members: { active, total: st.memberships.filter((m) => m.ws === ws.id).length },
    seat_baseline_monthly: ws.seat_baseline_monthly, seat_cost: seatCost, savings_vs_seats: seatCost - subCost, run_rate: (usage.api_cost / days) * MONTH_DAYS,
  };
}
function timeseries(ws, from, to, tz, uid) {
  const bucket = to - from <= 2 * DAY ? 3600000 : DAY;
  const off = tz * 60000;
  const rows = st.requests.filter((r) => inRange(r, ws, from, to, uid));
  const m = new Map();
  for (const r of rows) {
    const b = Math.floor((r.ts - off) / bucket) * bucket + off;
    const k = b + '|' + r.provider;
    const o = m.get(k) || { bucket: b, provider: r.provider, requests: 0, tokens: 0, api_cost: 0 };
    o.requests++;
    o.tokens += tokTotal(r);
    o.api_cost += r.cost;
    m.set(k, o);
  }
  return { bucket_ms: bucket, rows: [...m.values()].sort((a, b) => a.bucket - b.bucket) };
}
function byKey(ws, from, to, uid) {
  const rows = st.requests.filter((r) => inRange(r, ws, from, to, uid));
  const usage = new Map([...groupBy(rows, (r) => r.key_id)].map(([k, v]) => [k, { ...agg(v), last_used: Math.max(...v.map((x) => x.ts)) }]));
  const month = new Map([...groupBy(st.requests.filter((r) => r.ws === ws.id && r.ts >= monthStart()), (r) => r.key_id)].map(([k, v]) => [k, { cost: v.reduce((s, r) => s + r.cost, 0), tokens: v.reduce((s, r) => s + tokTotal(r), 0) }]));
  return st.keys
    .filter((k) => k.ws === ws.id && (uid == null || k.user_id === uid || k.created_by === uid))
    .sort((a, b) => !!a.revoked_at - !!b.revoked_at || b.created_at - a.created_at)
    .map((k) => ({
      id: k.id, name: k.name, scope_type: k.scope_type, key_hint: k.key_hint, user_id: k.user_id, budget_usd: k.budget_usd, budget_tokens: k.budget_tokens,
      created_at: k.created_at, revoked_at: k.revoked_at, last_used_at: k.last_used_at, user_name: user(k.user_id)?.name || null, created_by_name: user(k.created_by)?.name || null,
      usage: usage.get(k.id) || { requests: 0, tokens: 0, api_cost: 0 }, month: month.get(k.id) || { cost: 0, tokens: 0 },
    }));
}
function byMember(ws, from, to) {
  const rows = st.requests.filter((r) => inRange(r, ws, from, to));
  const usage = new Map([...groupBy(rows, (r) => r.user_id)].map(([k, v]) => [k, agg(v)]));
  const members = st.memberships
    .filter((m) => m.ws === ws.id)
    .sort((a, b) => a.created_at - b.created_at)
    .map((m) => {
      const u = user(m.user);
      return {
        id: u.id, name: u.name, email: u.email, role: m.role, created_at: m.created_at,
        keys: st.keys.filter((k) => k.ws === ws.id && k.user_id === u.id && !k.revoked_at).length,
        plans: st.accounts.filter((a) => a.ws === ws.id && a.owner_user_id === u.id && !a.removed_at).length,
        usage: usage.get(u.id) || { requests: 0, tokens: 0, api_cost: 0 },
      };
    });
  return { members, unattributed: usage.get(null) || null };
}
function byModel(ws, from, to, uid) {
  const rows = st.requests.filter((r) => inRange(r, ws, from, to, uid));
  return [...groupBy(rows, (r) => r.model + '|' + r.provider)].map(([, v]) => ({ model: v[0].model, provider: v[0].provider, price_estimated: 0, ...agg(v) })).sort((a, b) => b.api_cost - a.api_cost);
}
function recent(ws, limit, uid) {
  return st.requests
    .filter((r) => r.ws === ws.id && (uid == null || r.user_id === uid))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit)
    .map((r) => {
      const a = st.accounts.find((x) => x.id === r.account_id);
      return { ts: r.ts, provider: r.provider, model: r.model, failed: r.failed, status_code: r.status_code, latency_ms: r.latency_ms, cost: r.cost, tokens: tokTotal(r), user_name: user(r.user_id)?.name || null, key_name: st.keys.find((k) => k.id === r.key_id)?.name || null, account: a ? a.email || a.label : null };
    });
}
function capacity(ws, viewer) {
  const t = now();
  const accounts = st.accounts.filter((a) => a.ws === ws.id && !a.removed_at);
  const rows = accounts.map((a) => {
    const q = a.quota;
    const windows = [];
    if (q && a.kind === 'oauth') {
      // Windows roll over when their reset time passes.
      while (q.r5 < t) (q.r5 += 5 * 3600000), (q.u5 = rnd(0, 0.1));
      while (q.r7 < t) (q.r7 += 7 * DAY), (q.u7 = rnd(0, 0.1));
      windows.push({ label: '5-hour', used: q.u5, resets_at: q.r5, window_s: 18000 }, { label: 'Weekly', used: q.u7, resets_at: q.r7, window_s: 604800 });
    }
    const last = st.requests.filter((r) => r.account_id === a.id && r.ts >= t - 5 * 3600000);
    return {
      id: a.id, provider: a.provider, kind: a.kind, role: a.role, email: a.email || a.label, plan: a.plan, visibility: a.visibility,
      owner_name: user(a.owner_user_id)?.name || null, owner_user_id: a.owner_user_id, state: a.disabled ? 'paused' : 'ready', status_message: null, next_retry_after: null,
      windows, observed_at: a.quota_at || null, last_5h: { requests: last.length, tokens: last.reduce((s, r) => s + tokTotal(r), 0) },
      weekly_unused: windows[1] ? { share: 1 - windows[1].used, resets_at: windows[1].resets_at } : null, mine: a.owner_user_id === viewer,
    };
  });
  const prov = {};
  for (const r of rows.filter((x) => x.role !== 'overflow')) {
    const p = (prov[r.provider] ||= { provider: r.provider, accounts: 0, ready: 0, _5: [], _w: [], next_reset: null });
    p.accounts++;
    if (r.state === 'ready') p.ready++;
    for (const w of r.windows) {
      (w.label === 'Weekly' ? p._w : p._5).push(w.used);
      if (!p.next_reset || w.resets_at < p.next_reset) p.next_reset = w.resets_at;
    }
  }
  const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
  return { accounts: rows, providers: Object.values(prov).map(({ _5, _w, ...p }) => ({ ...p, avg5h: avg(_5), avgWeekly: avg(_w) })) };
}
function billing(ws) {
  const plans = st.accounts.filter((a) => a.ws === ws.id && !a.removed_at && a.kind === 'oauth').length;
  return {
    status: ws.billing_status, trial_ends_at: ws.trial_ends_at, trial_days_left: Math.max(0, Math.ceil((ws.trial_ends_at - now()) / DAY)),
    trial_expired: ws.billing_status === 'trialing' && now() > ws.trial_ends_at, activated_at: ws.activated_at, connected_plans: plans,
    price_per_plan: PLATFORM.pricePerPlan, monthly_total: plans * PLATFORM.pricePerPlan,
  };
}
function onboarding(ws, uid, role) {
  const hasReq = (f) => st.requests.some((r) => r.ws === ws.id && !r.failed && f(r));
  if (role === 'member')
    return [
      { id: 'plan', label: 'Bring your own plan (optional)', done: st.accounts.some((a) => a.ws === ws.id && a.owner_user_id === uid && !a.removed_at), optional: true },
      { id: 'key', label: 'Create your key', done: st.keys.some((k) => k.ws === ws.id && k.user_id === uid && !k.revoked_at) },
      { id: 'setup', label: 'Run the setup script', done: hasReq((r) => r.user_id === uid) },
    ];
  return [
    { id: 'plan', label: 'Connect a Claude or ChatGPT plan', done: st.accounts.some((a) => a.ws === ws.id && !a.removed_at) },
    { id: 'key', label: 'Create and test a key', done: hasReq(() => true) },
    { id: 'invite', label: 'Invite your team', done: st.invites.some((i) => i.ws === ws.id) || st.memberships.filter((m) => m.ws === ws.id).length > 1 },
    { id: 'setup', label: 'Point your tools at AI Pool', done: hasReq((r) => /claude-cli|codex/.test(r.user_agent || '')) },
    { id: 'billing', label: 'Activate your plan', done: ws.billing_status === 'active' },
  ];
}

// ---------- API ----------

const publicUrl = 'https://ai.yourcompany.com';
const sanitize = (s, n = 120) => String(s ?? '').trim().slice(0, n);
const numOrNull = (v) => (v === '' || v == null ? null : Math.max(0, Number(v)) || 0);
const baseHref = () => new URL('./', location.href).href;

function handleApi(method, path, q, body) {
  const me = user(st.session);
  // ---- auth ----
  if (path === '/api/auth/signup' && method === 'POST') {
    const email = sanitize(body.email, 200).toLowerCase();
    if (!sanitize(body.name)) throw bad('Please enter your name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Please enter a valid email.');
    if (String(body.password || '').length < 8) throw bad('Password must be at least 8 characters.');
    if (st.users.some((u) => u.email === email)) throw bad('An account with this email already exists. Log in instead.');
    const u = { id: id(), name: sanitize(body.name), email, pw: String(body.password) };
    st.users.push(u);
    let wsId;
    if (body.invite_token) wsId = acceptInvite(body.invite_token, u);
    else {
      wsId = createWorkspace(sanitize(body.workspace_name) || `${u.name.split(' ')[0]}'s team`, u.id).id;
      seedSample(u.id);
    }
    st.session = u.id;
    return { ok: true, redirect: `app#/w/${wsId}/overview` };
  }
  if (path === '/api/auth/login' && method === 'POST') {
    const u = st.users.find((x) => x.email === sanitize(body.email, 200).toLowerCase());
    if (!u || u.pw == null || u.pw !== String(body.password || '')) throw new HttpError(401, 'Wrong email or password.');
    st.session = u.id;
    const wsId = body.invite_token ? acceptInvite(body.invite_token, u) : null;
    return { ok: true, redirect: wsId ? `app#/w/${wsId}/overview` : 'app' };
  }
  if (path === '/api/auth/logout' && method === 'POST') {
    st.session = null;
    return { ok: true };
  }
  let m = path.match(/^\/api\/invites\/([A-Za-z0-9-]+)$/);
  if (m && method === 'GET') {
    const i = st.invites.find((x) => x.token === m[1]);
    if (!i) throw new HttpError(404, 'Invite not found.');
    return { workspace: st.workspaces.find((w) => w.id === i.ws).name, inviter: user(i.created_by).name, email: i.email, role: i.role, valid: !i.revoked && !i.accepted_at && i.expires_at > now(), user: me ? { id: me.id, name: me.name, email: me.email } : null };
  }
  if (m && method === 'POST') {
    if (!me) throw new HttpError(401, 'Log in first.');
    return { ok: true, redirect: `app#/w/${acceptInvite(m[1], me)}/overview` };
  }
  if (!me) throw new HttpError(401, 'Not signed in.');

  if (path === '/api/me')
    return { user: { id: me.id, name: me.name, email: me.email }, workspaces: st.memberships.filter((x) => x.user === me.id).sort((a, b) => a.created_at - b.created_at).map((x) => ({ id: x.ws, name: st.workspaces.find((w) => w.id === x.ws).name, role: x.role })), public_url: publicUrl };
  if (path === '/api/workspaces' && method === 'POST') {
    if (!sanitize(body.name)) throw bad('Workspace name is required.');
    return { id: createWorkspace(sanitize(body.name), me.id).id };
  }

  // ---- workspace ----
  m = path.match(/^\/api\/w\/(\d+)(\/.*)?$/);
  if (!m) throw new HttpError(404, 'Not found.');
  const ws = st.workspaces.find((w) => w.id === Number(m[1]));
  const mem = ws && membership(ws.id, me.id);
  if (!mem) throw new HttpError(404, 'Workspace not found.');
  const sub = m[2] || '/';
  const role = mem.role;
  const isAdmin = role === 'owner' || role === 'admin';
  const needAdmin = () => {
    if (!isAdmin) throw new HttpError(403, 'Only workspace admins can do that.');
  };
  const scopeUid = isAdmin ? null : me.id;
  const to = Number(q.get('to')) || now();
  const from = Number(q.get('from')) || to - 30 * DAY;

  if (sub === '/overview') {
    const viewUid = q.get('view') === 'me' ? me.id : scopeUid;
    return {
      workspace: { id: ws.id, name: ws.name, seat_baseline_monthly: ws.seat_baseline_monthly }, role, user: { id: me.id, name: me.name, email: me.email },
      billing: billing(ws), onboarding: onboarding(ws, me.id, role), summary: summary(ws, from, to, viewUid), timeseries: timeseries(ws, from, to, Number(q.get('tz')) || 0, viewUid),
      models: byModel(ws, from, to, viewUid), keys: byKey(ws, from, to, viewUid).filter((k) => !k.revoked_at).slice(0, 8),
      members: isAdmin && viewUid == null ? byMember(ws, from, to).members : [], health: isAdmin ? { lastPollAt: now(), lastSyncAt: now() } : undefined,
    };
  }
  if (sub === '/capacity') return capacity(ws, me.id);
  if (sub === '/activity') return recent(ws, 200, scopeUid);

  // keys
  if (sub === '/keys' && method === 'GET') return { keys: byKey(ws, from, to, scopeUid), members: st.memberships.filter((x) => x.ws === ws.id).map((x) => ({ id: x.user, name: user(x.user).name })), can_manage: isAdmin };
  if (sub === '/keys' && method === 'POST') {
    let scope = ['person', 'team', 'project', 'client'].includes(body.scope_type) ? body.scope_type : 'person';
    let uid = scope === 'person' ? Number(body.user_id) || me.id : null;
    let bu = numOrNull(body.budget_usd);
    let bt = numOrNull(body.budget_tokens);
    if (!isAdmin) [scope, uid, bu, bt] = ['person', me.id, null, null];
    const k = { id: id(), ws: ws.id, name: sanitize(body.name, 80) || 'My key', scope_type: scope, user_id: uid, created_by: me.id, key: 'aip_' + token(40), budget_usd: bu, budget_tokens: bt, created_at: now(), revoked_at: null, last_used_at: null };
    k.key_hint = k.key.slice(0, 8) + '…' + k.key.slice(-4);
    st.keys.push(k);
    return { id: k.id, key: k.key };
  }
  m = sub.match(/^\/keys\/(\d+)(\/revoke)?$/);
  if (m) {
    const k = st.keys.find((x) => x.id === Number(m[1]) && x.ws === ws.id);
    if (!k) throw new HttpError(404, 'Key not found.');
    if (!isAdmin && k.user_id !== me.id && k.created_by !== me.id) throw new HttpError(403, 'You can only manage your own keys.');
    if (m[2]) k.revoked_at = now();
    else {
      if ('name' in body) k.name = sanitize(body.name, 80) || k.name;
      if ('budget_usd' in body || 'budget_tokens' in body) {
        needAdmin();
        if ('budget_usd' in body) k.budget_usd = numOrNull(body.budget_usd);
        if ('budget_tokens' in body) k.budget_tokens = numOrNull(body.budget_tokens);
      }
    }
    return { ok: true };
  }

  // accounts
  if (sub === '/accounts' && method === 'GET') {
    const plans = plansOf(ws);
    const days = Math.max((to - from) / DAY, 1 / 24);
    const rows = st.accounts
      .filter((a) => a.ws === ws.id && !a.removed_at && (isAdmin || a.visibility === 'shared' || a.owner_user_id === me.id))
      .map((a) => {
        const monthly = accountMonthly(a, plans);
        const used = st.requests.filter((r) => r.account_id === a.id && r.ts >= from && r.ts < to);
        const u = { requests: used.length, api_cost: used.reduce((s, r) => s + r.cost, 0) };
        const subCost = (monthly * days) / MONTH_DAYS;
        const visible = isAdmin || a.owner_user_id === me.id;
        return {
          ...a, email: visible ? a.email : a.email && a.email.replace(/^(.{2}).*@/, '$1…@'), owner_name: user(a.owner_user_id)?.name || null, effective_monthly: monthly,
          usage: u, subscription_cost: subCost, value_multiple: subCost > 0 ? u.api_cost / subCost : null, can_manage: isAdmin || a.owner_user_id === me.id, unavailable: false, next_retry_after: null,
        };
      });
    return { accounts: rows, plans, members: isAdmin ? st.memberships.filter((x) => x.ws === ws.id).map((x) => ({ id: x.user, name: user(x.user).name })) : [], unclaimed: [], can_manage: isAdmin };
  }
  if (sub === '/accounts/oauth/start') {
    const state = token(16);
    st.oauth[state] = { provider: body.provider, ws: ws.id, user: me.id, visibility: body.visibility === 'private' ? 'private' : 'shared', at: now() };
    return { url: `demo-signin.html?provider=${encodeURIComponent(body.provider)}&state=${state}`, state };
  }
  if (sub === '/accounts/oauth/callback') return { status: 'ok' };
  if (sub === '/accounts/oauth/status') {
    const state = q.get('state');
    const s = st.oauth[state];
    if (!s) throw new HttpError(404, 'unknown login session');
    let done;
    try {
      done = JSON.parse(localStorage.getItem('aipool_demo_oauth_' + state) || 'null');
    } catch {}
    if (!done) return { status: 'wait' };
    localStorage.removeItem('aipool_demo_oauth_' + state);
    delete st.oauth[state];
    const email = sanitize(done.email, 200) || `${s.provider}-account@example.test`;
    if (st.accounts.some((a) => a.email === email && !a.removed_at && a.ws !== s.ws)) return { status: 'ok', added: [], refreshed: [], conflicts: [{ email, provider: s.provider }] };
    if (st.accounts.some((a) => a.email === email && !a.removed_at && a.ws === s.ws)) return { status: 'ok', added: [], refreshed: [{ email, provider: s.provider }], conflicts: [] };
    st.accounts.push({ id: id(), ws: s.ws, kind: 'oauth', role: 'subscription', provider: s.provider, email, label: null, account_type: done.plan || null, visibility: s.visibility, owner_user_id: s.user, plan: done.plan || guessPlan(s.provider, ''), monthly_cost: null, disabled: false, status: 'active', created_at: now(), removed_at: null });
    return { status: 'ok', added: [{ email, provider: s.provider }], refreshed: [], conflicts: [] };
  }
  if (sub === '/accounts/apikey') {
    if (!isAdmin && body.visibility !== 'private') throw new HttpError(403, 'Members can only add private API keys.');
    if (!body.api_key || String(body.api_key).length < 10) throw bad('API key looks invalid');
    st.accounts.push({ id: id(), ws: ws.id, kind: 'apikey', role: isAdmin && body.role === 'overflow' ? 'overflow' : 'subscription', provider: body.provider, email: null, label: sanitize(body.label, 80) || `${body.provider} API key`, visibility: body.visibility === 'private' ? 'private' : 'shared', owner_user_id: me.id, plan: 'pay-as-you-go', monthly_cost: null, disabled: false, status: 'active', created_at: now(), removed_at: null });
    return { ok: true };
  }
  m = sub.match(/^\/accounts\/(\d+)(\/(pause|resume))?$/);
  if (m) {
    const a = st.accounts.find((x) => x.id === Number(m[1]) && x.ws === ws.id && !x.removed_at);
    if (!a) throw new HttpError(404, 'Account not found.');
    if (!isAdmin && a.owner_user_id !== me.id) throw new HttpError(403, 'You can only manage plans you connected.');
    if (m[3]) a.disabled = m[3] === 'pause';
    else if (method === 'DELETE') a.removed_at = now();
    else {
      if ('plan' in body) a.plan = body.plan || null;
      if ('monthly_cost' in body) a.monthly_cost = numOrNull(body.monthly_cost);
      if ('visibility' in body) a.visibility = body.visibility === 'private' ? 'private' : 'shared';
      if ('owner_user_id' in body) {
        needAdmin();
        a.owner_user_id = body.owner_user_id ? Number(body.owner_user_id) : null;
        if (!a.owner_user_id) a.visibility = 'shared';
      }
      if (a.visibility === 'private' && !a.owner_user_id) throw bad('A private plan needs an owner.');
    }
    return { ok: true };
  }

  // members & invites
  if (sub === '/members' && method === 'GET') {
    const d = byMember(ws, from, to);
    if (!isAdmin) d.members = d.members.map((x) => ({ id: x.id, name: x.name, role: x.role }));
    return { ...d, invites: isAdmin ? st.invites.filter((i) => i.ws === ws.id && !i.revoked && !i.accepted_at && i.expires_at > now()).map(({ token: _t, ...i }) => i) : [], can_manage: isAdmin, me: me.id };
  }
  if (sub === '/invites' && method === 'POST') {
    needAdmin();
    const t = token();
    st.invites.push({ id: id(), ws: ws.id, email: sanitize(body.email, 200).toLowerCase() || null, role: body.role === 'admin' ? 'admin' : 'member', token: t, created_by: me.id, created_at: now(), expires_at: now() + 14 * DAY, accepted_by: null, accepted_at: null, revoked: 0 });
    return { url: `${baseHref()}signup?invite=${t}` };
  }
  m = sub.match(/^\/invites\/(\d+)$/);
  if (m) {
    needAdmin();
    const i = st.invites.find((x) => x.id === Number(m[1]) && x.ws === ws.id);
    if (i) i.revoked = 1;
    return { ok: true };
  }
  m = sub.match(/^\/members\/(\d+)$/);
  if (m) {
    needAdmin();
    const uid = Number(m[1]);
    const target = membership(ws.id, uid);
    if (!target) throw new HttpError(404, 'Member not found.');
    if (target.role === 'owner') throw bad('The workspace owner cannot be changed here.');
    if (method === 'PATCH') target.role = body.role === 'admin' ? 'admin' : 'member';
    else {
      st.keys.filter((k) => k.ws === ws.id && k.user_id === uid && !k.revoked_at).forEach((k) => (k.revoked_at = now()));
      const owned = st.accounts.filter((a) => a.ws === ws.id && a.owner_user_id === uid && !a.removed_at);
      owned.forEach((a) => (a.removed_at = now()));
      st.memberships = st.memberships.filter((x) => !(x.ws === ws.id && x.user === uid));
      return { ok: true, removed_plans: owned.length };
    }
    return { ok: true };
  }

  // billing
  if (sub === '/billing' && method === 'GET') return { ...billing(ws), role };
  if (sub === '/billing/activate' || sub === '/billing/cancel') {
    if (role !== 'owner') throw new HttpError(403, 'Only the workspace owner can change billing.');
    if (sub.endsWith('activate')) Object.assign(ws, { billing_status: 'active', activated_at: now() });
    else ws.billing_status = 'canceled';
    return { ok: true };
  }

  // settings
  if (sub === '/settings' && method === 'GET') {
    needAdmin();
    return { name: ws.name, seat_baseline_monthly: ws.seat_baseline_monthly, plans: plansOf(ws), prices: pricesOf(ws), default_prices: DEFAULT_PRICES, health: { lastPollAt: now(), lastSyncAt: now() } };
  }
  if (sub === '/settings' && method === 'PUT') {
    needAdmin();
    if (body.name) ws.name = sanitize(body.name);
    if (body.seat_baseline_monthly != null) ws.seat_baseline_monthly = Math.max(0, Number(body.seat_baseline_monthly) || 0);
    if (body.plans) ws.plans = body.plans;
    if (body.prices) {
      ws.price_overrides = body.prices;
      for (const r of st.requests.filter((x) => x.ws === ws.id)) {
        const { price } = resolvePrice(r.model, r.provider, pricesOf(ws));
        r.cost = r.failed ? 0 : costOf({ uncached: r.uncached, cacheRead: r.cache_read, cacheWrite: r.cache_write, output: r.output, unclassified: 0 }, price);
      }
    }
    return { ok: true };
  }
  throw new HttpError(404, 'Not found.');
}

function acceptInvite(t, u) {
  const i = st.invites.find((x) => x.token === t);
  if (!i || i.revoked || i.accepted_at || i.expires_at < now()) throw bad('This invite link is invalid, used, or expired. Ask your admin for a new one.');
  if (!membership(i.ws, u.id)) st.memberships.push({ ws: i.ws, user: u.id, role: i.role, created_at: now() });
  i.accepted_by = u.id;
  i.accepted_at = now();
  return i.ws;
}

// ---------- simulated gateway (/v1) ----------

function handleGateway(method, path, headers, body) {
  const raw = headers['x-api-key'] || String(headers.authorization || '').replace(/^Bearer\s+/i, '');
  const k = st.keys.find((x) => x.key === raw && !x.revoked_at);
  const anth = path.startsWith('/v1/messages');
  const err = (status, type, message) => ({ status, body: anth ? { type: 'error', error: { type, message } } : { error: { type, message } } });
  if (!k) return err(401, 'authentication_error', 'Invalid or revoked AI Pool key.');
  const ws = st.workspaces.find((w) => w.id === k.ws);
  if (ws.billing_status === 'canceled' || (ws.billing_status === 'trialing' && now() > ws.trial_ends_at)) return err(402, 'billing_error', `The free trial for workspace "${ws.name}" has ended.`);
  if (k.budget_usd != null) {
    const spent = st.requests.filter((r) => r.key_id === k.id && r.ts >= monthStart()).reduce((s, r) => s + r.cost, 0);
    if (spent >= k.budget_usd) return err(429, 'budget_exceeded', `Monthly budget of $${k.budget_usd} for key "${k.name}" is used up.`);
  }
  const usable = (prov) => st.accounts.filter((a) => a.ws === ws.id && !a.removed_at && !a.disabled && a.provider === prov && (a.visibility === 'shared' || a.owner_user_id === k.user_id));
  if (path === '/v1/models') {
    const ids = [...(usable('claude').length ? CLAUDE_MODELS : []), ...(usable('codex').length ? CODEX_MODELS : [])];
    return { status: 200, body: { object: 'list', data: ids.map((i) => ({ id: i, object: 'model' })) } };
  }
  const model = body?.model || '';
  const prov = model.startsWith('claude') ? 'claude' : 'codex';
  const accs = usable(prov).sort((a, b) => (b.owner_user_id === k.user_id && b.visibility === 'private') - (a.owner_user_id === k.user_id && a.visibility === 'private'));
  if (!accs.length) return err(400, 'invalid_request_error', `unknown provider for model ${model}`);
  addRequest(ws, { key: k, account: accs[0], model, scale: 0.02, ua: 'aipool-test' });
  if (anth) return { status: 200, body: { id: 'msg_demo', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'pong' }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 2 } } };
  return { status: 200, body: { id: 'resp_demo', object: 'response', model, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'pong' }] }] } };
}

// ---------- fetch shim ----------

function json(status, body, delay = 120) {
  return new Promise((r) => setTimeout(() => r(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })), delay));
}

window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  const p = url.pathname;
  const apiAt = p.indexOf('/api/');
  const v1At = p.indexOf('/v1/');
  if (apiAt === -1 && v1At === -1) return realFetch(input, init);
  const method = (init.method || 'GET').toUpperCase();
  let body = {};
  try {
    body = init.body ? JSON.parse(init.body) : {};
  } catch {}
  const headers = {};
  for (const [k, v] of Object.entries(init.headers || {})) headers[k.toLowerCase()] = v;
  if (v1At !== -1 && (apiAt === -1 || v1At < apiAt)) {
    const r = handleGateway(method, p.slice(v1At), headers, body);
    save();
    return json(r.status, r.body, 700);
  }
  try {
    const out = handleApi(method, p.slice(apiAt), url.searchParams, body);
    save();
    return json(200, out);
  } catch (err) {
    save();
    return json(err.status || 500, { error: err.message });
  }
};

// ---------- demo chrome: banner + persona switcher ----------

function banner() {
  if (document.getElementById('demo-bar')) return;
  const bar = document.createElement('div');
  bar.id = 'demo-bar';
  bar.style.cssText = 'position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:60;display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:center;max-width:calc(100vw - 24px);padding:8px 12px;border-radius:12px;background:#111110;color:#f0efec;font:13px/1.4 system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.25)';
  const me = user(st.session);
  const others = st.users.filter((u) => u.pw != null && u.id !== st.session);
  bar.innerHTML = `<span><b>Concept demo</b>. Simulated data, stored only in this browser.</span>
    ${me ? `<span style="opacity:.75">Signed in as ${me.name.replace(/[<>&]/g, '')}</span>` : ''}
    ${others.length ? `<select id="demo-switch" style="background:#222;color:#fff;border:1px solid #444;border-radius:6px;padding:2px 6px"><option value="">Switch user…</option>${others.map((u) => `<option value="${u.id}">${u.name.replace(/[<>&]/g, '')}</option>`).join('')}</select>` : ''}
    <a href="https://github.com/Mayank57/ai-pool/issues/new?title=Feedback%20on%20AI%20Pool&labels=feedback" target="_blank" rel="noopener" style="color:#7eb2f5">Share feedback</a>
    <button id="demo-reset" style="background:none;border:1px solid #555;color:#ddd;border-radius:6px;padding:2px 8px;cursor:pointer">Reset demo</button>`;
  document.body.appendChild(bar);
  bar.querySelector('#demo-reset').onclick = () => {
    if (!confirm('Delete all demo data in this browser and start over?')) return;
    resetDemo();
    location.href = './';
  };
  const sw = bar.querySelector('#demo-switch');
  if (sw)
    sw.onchange = () => {
      st.session = Number(sw.value);
      save();
      location.href = 'app';
    };
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', banner);
else banner();
