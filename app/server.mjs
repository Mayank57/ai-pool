// AI Pool: multi-workspace subscription pooling on top of CLIProxyAPI.
//   /            marketing site (landing, pricing, docs)
//   /app         workspace app for admins and members
//   /v1/*        inference gateway (AI Pool keys)
//   /api/*       JSON API used by the app
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, getSetting, setSetting, tx } from './lib/db.mjs';
import { CPA } from './lib/cpa.mjs';
import { Pool } from './lib/pool.mjs';
import { createGateway } from './lib/gateway.mjs';
import * as R from './lib/reports.mjs';
import { DEFAULT_PRICES, PLATFORM } from './lib/pricing.mjs';
import { setupScript } from './lib/setup-script.mjs';
import { sha256, randomToken, hashPassword, verifyPassword, makeSigner, makeCrypto } from './lib/security.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const envFile = process.env.AIPOOL_ENV_FILE || resolve(here, '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const cfg = {
  host: process.env.APP_HOST || '127.0.0.1',
  port: Number(process.env.APP_PORT || 8320),
  publicUrl: (process.env.APP_PUBLIC_URL || `http://localhost:${process.env.APP_PORT || 8320}`).replace(/\/+$/, ''),
  cpaUrl: process.env.PROXY_URL || 'http://127.0.0.1:8317',
  managementKey: process.env.MANAGEMENT_KEY || '',
  secret: process.env.APP_SECRET || '',
  dbPath: process.env.APP_DB || resolve(here, '..', 'data', 'aipool.db'),
  allowClaim: (process.env.ALLOW_CLAIM_UNASSIGNED || 'true') === 'true',
};
if (!cfg.managementKey || !cfg.secret) {
  console.error('MANAGEMENT_KEY and APP_SECRET must be set (run scripts/setup.sh).');
  process.exit(1);
}

const db = openDb(cfg.dbPath);
const signer = makeSigner(cfg.secret);
const crypto = makeCrypto(cfg.secret);
const cpa = new CPA({ baseUrl: cfg.cpaUrl, managementKey: cfg.managementKey });
const pool = new Pool({ db, cpa, crypto });
const gateway = createGateway({ db, cpaUrl: cfg.cpaUrl });

// ---------- http helpers ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (m) => new HttpError(400, m);

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1e6) throw new HttpError(413, 'body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw bad('invalid JSON');
  }
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSession(res, userId) {
  const secure = cfg.publicUrl.startsWith('https://') ? '; Secure' : '';
  const v = userId ? signer.sign({ uid: userId, exp: Date.now() + 30 * 86400000 }) : '';
  res.setHeader('Set-Cookie', `aip_session=${encodeURIComponent(v)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${userId ? 30 * 86400 : 0}${secure}`);
}

function currentUser(req) {
  const s = signer.verify(cookies(req).aip_session);
  return s ? db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(s.uid) : null;
}

const failures = new Map();
function throttle(ip) {
  const f = failures.get(ip);
  if (f && f.count >= 10 && Date.now() - f.since < 15 * 60000) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
}
function recordFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.since > 15 * 60000) failures.set(ip, { count: 1, since: Date.now() });
  else f.count++;
}

function range(url) {
  const to = Number(url.searchParams.get('to')) || Date.now();
  const from = Number(url.searchParams.get('from')) || to - 30 * 86400000;
  return [from, to];
}

const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || ''));
const clean = (s, max = 120) => String(s ?? '').trim().slice(0, max);

// ---------- domain helpers ----------

function createWorkspace(name, userId) {
  const now = Date.now();
  let prefix;
  do prefix = 'ws' + randomToken(8).toLowerCase();
  while (db.prepare('SELECT 1 FROM workspaces WHERE prefix = ?').get(prefix));
  const id = tx(db, () => {
    const info = db
      .prepare('INSERT INTO workspaces (name, prefix, created_by, created_at, trial_ends_at) VALUES (?,?,?,?,?)')
      .run(name, prefix, userId, now, now + PLATFORM.trialDays * 86400000);
    db.prepare("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(info.lastInsertRowid, userId, now);
    return Number(info.lastInsertRowid);
  });
  return id;
}

function acceptInvite(token, user) {
  const inv = db.prepare('SELECT * FROM invites WHERE token_hash = ?').get(sha256(token));
  if (!inv || inv.revoked || inv.accepted_at || inv.expires_at < Date.now()) throw bad('This invite link is invalid, used, or expired. Ask your admin for a new one.');
  const exists = db.prepare('SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ?').get(inv.workspace_id, user.id);
  tx(db, () => {
    if (!exists) db.prepare('INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)').run(inv.workspace_id, user.id, inv.role, Date.now());
    db.prepare('UPDATE invites SET accepted_by = ?, accepted_at = ? WHERE id = ?').run(user.id, Date.now(), inv.id);
  });
  return inv.workspace_id;
}

function newApiKey({ wsId, name, scopeType, userId, createdBy, budgetUsd, budgetTokens }) {
  const raw = 'aip_' + randomToken(40);
  const info = db
    .prepare(
      `INSERT INTO api_keys (workspace_id, name, scope_type, user_id, created_by, key_hash, key_hint, cpa_key, budget_usd, budget_tokens, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(wsId, name, scopeType, userId, createdBy, sha256(raw), raw.slice(0, 8) + '…' + raw.slice(-4), 'cpa_' + randomToken(40), budgetUsd, budgetTokens, Date.now());
  return { id: Number(info.lastInsertRowid), key: raw };
}

const numOrNull = (v) => (v === '' || v == null ? null : Math.max(0, Number(v)) || 0);

function billing(ws) {
  const plans = db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE workspace_id = ? AND removed_at IS NULL AND kind = 'oauth'").get(ws.id).n;
  const now = Date.now();
  return {
    status: ws.billing_status,
    trial_ends_at: ws.trial_ends_at,
    trial_days_left: Math.max(0, Math.ceil((ws.trial_ends_at - now) / 86400000)),
    trial_expired: ws.billing_status === 'trialing' && now > ws.trial_ends_at,
    activated_at: ws.activated_at,
    connected_plans: plans,
    price_per_plan: PLATFORM.pricePerPlan,
    monthly_total: plans * PLATFORM.pricePerPlan,
  };
}

function onboarding(ws, user, role) {
  const q = (sql, ...a) => db.prepare(sql).get(...a);
  if (role === 'member') {
    return [
      { id: 'plan', label: 'Bring your own plan (optional)', done: !!q('SELECT 1 FROM accounts WHERE workspace_id = ? AND owner_user_id = ? AND removed_at IS NULL', ws.id, user.id), optional: true },
      { id: 'key', label: 'Create your key', done: !!q('SELECT 1 FROM api_keys WHERE workspace_id = ? AND user_id = ? AND revoked_at IS NULL', ws.id, user.id) },
      { id: 'setup', label: 'Run the setup script', done: !!q('SELECT 1 FROM requests WHERE workspace_id = ? AND user_id = ? AND failed = 0', ws.id, user.id) },
    ];
  }
  return [
    { id: 'plan', label: 'Connect a Claude or ChatGPT plan', done: !!q('SELECT 1 FROM accounts WHERE workspace_id = ? AND removed_at IS NULL', ws.id) },
    { id: 'key', label: 'Create and test a key', done: !!q('SELECT 1 FROM requests WHERE workspace_id = ? AND failed = 0', ws.id) },
    { id: 'invite', label: 'Invite your team', done: !!q('SELECT 1 FROM invites WHERE workspace_id = ?', ws.id) || q('SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = ?', ws.id).n > 1 },
    { id: 'setup', label: 'Point your tools at AI Pool', done: !!q("SELECT 1 FROM requests WHERE workspace_id = ? AND failed = 0 AND (user_agent LIKE '%claude-cli%' OR user_agent LIKE '%codex%' OR user_agent LIKE '%opencode%')", ws.id) },
    { id: 'billing', label: 'Activate your plan', done: ws.billing_status === 'active' },
  ];
}

// ---------- API: auth ----------

async function authApi(req, res, url, path, ip) {
  const m = req.method;
  if (path === '/api/auth/signup' && m === 'POST') {
    throttle(ip);
    const b = await body(req);
    const name = clean(b.name);
    const email = clean(b.email, 200).toLowerCase();
    if (!name) throw bad('Please enter your name.');
    if (!emailOk(email)) throw bad('Please enter a valid email.');
    if (String(b.password || '').length < 8) throw bad('Password must be at least 8 characters.');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw bad('An account with this email already exists. Log in instead.');
    const uid = Number(db.prepare('INSERT INTO users (email, name, pw_hash, created_at) VALUES (?,?,?,?)').run(email, name, hashPassword(b.password), Date.now()).lastInsertRowid);
    const user = { id: uid, name, email };
    let wsId;
    if (b.invite_token) wsId = acceptInvite(b.invite_token, user);
    else wsId = createWorkspace(clean(b.workspace_name) || `${name.split(' ')[0]}'s team`, uid);
    setSession(res, uid);
    return send(res, 200, { ok: true, redirect: `app#/w/${wsId}/overview` });
  }
  if (path === '/api/auth/login' && m === 'POST') {
    throttle(ip);
    const b = await body(req);
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(clean(b.email, 200).toLowerCase());
    if (!u || !verifyPassword(b.password || '', u.pw_hash)) {
      recordFailure(ip);
      throw new HttpError(401, 'Wrong email or password.');
    }
    let wsId = null;
    if (b.invite_token) wsId = acceptInvite(b.invite_token, u);
    setSession(res, u.id);
    return send(res, 200, { ok: true, redirect: wsId ? `app#/w/${wsId}/overview` : 'app' });
  }
  if (path === '/api/auth/logout' && m === 'POST') {
    setSession(res, null);
    return send(res, 200, { ok: true });
  }
  const inv = path.match(/^\/api\/invites\/([A-Za-z0-9]+)$/);
  if (inv && m === 'GET') {
    const i = db
      .prepare('SELECT i.*, w.name AS ws_name, u.name AS inviter FROM invites i JOIN workspaces w ON w.id = i.workspace_id JOIN users u ON u.id = i.created_by WHERE token_hash = ?')
      .get(sha256(inv[1]));
    if (!i) return send(res, 404, { error: 'Invite not found.' });
    const valid = !i.revoked && !i.accepted_at && i.expires_at > Date.now();
    return send(res, 200, { workspace: i.ws_name, inviter: i.inviter, email: i.email, role: i.role, valid, user: currentUser(req) });
  }
  if (inv && m === 'POST') {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'Log in first.');
    const wsId = acceptInvite(inv[1], user);
    return send(res, 200, { ok: true, redirect: `app#/w/${wsId}/overview` });
  }
  return null;
}

// ---------- API: user-level ----------

async function userApi(req, res, url, path, user) {
  const m = req.method;
  if (path === '/api/me' && m === 'GET') {
    const workspaces = db
      .prepare('SELECT w.id, w.name, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? ORDER BY m.created_at')
      .all(user.id);
    return send(res, 200, { user, workspaces, public_url: cfg.publicUrl });
  }
  if (path === '/api/workspaces' && m === 'POST') {
    const b = await body(req);
    const name = clean(b.name);
    if (!name) throw bad('Workspace name is required.');
    return send(res, 200, { id: createWorkspace(name, user.id) });
  }
  return null;
}

// ---------- API: workspace ----------

async function wsApi(req, res, url, path, user) {
  const mm = path.match(/^\/api\/w\/(\d+)(\/.*)?$/);
  if (!mm) return null;
  const wsId = Number(mm[1]);
  const sub = mm[2] || '/';
  const m = req.method;
  const membership = db.prepare('SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?').get(wsId, user.id);
  if (!membership) throw new HttpError(404, 'Workspace not found.');
  const role = membership.role;
  const isAdmin = role === 'owner' || role === 'admin';
  const needAdmin = () => {
    if (!isAdmin) throw new HttpError(403, 'Only workspace admins can do that.');
  };
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(wsId);
  const mine = isAdmin ? {} : { userId: user.id };

  // ---- overview ----
  if (sub === '/overview' && m === 'GET') {
    const [from, to] = range(url);
    const tz = Number(url.searchParams.get('tz')) || 0;
    const view = url.searchParams.get('view') === 'me' ? { userId: user.id } : mine;
    return send(res, 200, {
      workspace: { id: ws.id, name: ws.name, seat_baseline_monthly: ws.seat_baseline_monthly },
      role,
      user,
      billing: billing(ws),
      onboarding: onboarding(ws, user, role),
      summary: R.summary(db, ws, from, to, view),
      timeseries: R.timeseries(db, ws, from, to, tz, view),
      models: R.byModel(db, ws, from, to, view),
      keys: R.byKey(db, ws, from, to, view).filter((k) => !k.revoked_at).slice(0, 8),
      members: isAdmin && !view.userId ? R.byMember(db, ws, from, to).members : [],
      health: isAdmin ? pool.state : undefined,
    });
  }

  if (sub === '/capacity' && m === 'GET') return send(res, 200, R.capacity(db, ws, user.id));

  if (sub === '/activity' && m === 'GET') return send(res, 200, R.recent(db, ws, 200, mine));

  // ---- keys ----
  if (sub === '/keys' && m === 'GET') {
    const [from, to] = range(url);
    const members = db.prepare('SELECT u.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY u.name').all(ws.id);
    return send(res, 200, { keys: R.byKey(db, ws, from, to, mine), members, can_manage: isAdmin });
  }
  if (sub === '/keys' && m === 'POST') {
    const b = await body(req);
    const name = clean(b.name, 80) || 'My key';
    let scopeType = ['person', 'team', 'project', 'client'].includes(b.scope_type) ? b.scope_type : 'person';
    let userId = scopeType === 'person' ? Number(b.user_id) || user.id : null;
    let budgetUsd = numOrNull(b.budget_usd);
    let budgetTokens = numOrNull(b.budget_tokens);
    if (!isAdmin) {
      scopeType = 'person';
      userId = user.id;
      budgetUsd = null; // budgets are set by admins
      budgetTokens = null;
    }
    if (userId && !db.prepare('SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ?').get(ws.id, userId)) throw bad('That person is not in this workspace.');
    const k = newApiKey({ wsId: ws.id, name, scopeType, userId, createdBy: user.id, budgetUsd, budgetTokens });
    await pool.syncClientKeys().catch((err) => (pool.state.lastSyncError = err.message));
    return send(res, 200, k);
  }
  let km = sub.match(/^\/keys\/(\d+)(\/revoke)?$/);
  if (km) {
    const k = db.prepare('SELECT * FROM api_keys WHERE id = ? AND workspace_id = ?').get(Number(km[1]), ws.id);
    if (!k) throw new HttpError(404, 'Key not found.');
    const own = k.user_id === user.id || k.created_by === user.id;
    if (!isAdmin && !own) throw new HttpError(403, 'You can only manage your own keys.');
    if (km[2] && m === 'POST') {
      db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(Date.now(), k.id);
      await pool.syncClientKeys().catch((err) => (pool.state.lastSyncError = err.message));
      return send(res, 200, { ok: true });
    }
    if (!km[2] && m === 'PATCH') {
      const b = await body(req);
      if ('name' in b) db.prepare('UPDATE api_keys SET name = ? WHERE id = ?').run(clean(b.name, 80) || k.name, k.id);
      if ('budget_usd' in b || 'budget_tokens' in b) {
        needAdmin();
        db.prepare('UPDATE api_keys SET budget_usd = ?, budget_tokens = ? WHERE id = ?').run(
          'budget_usd' in b ? numOrNull(b.budget_usd) : k.budget_usd,
          'budget_tokens' in b ? numOrNull(b.budget_tokens) : k.budget_tokens,
          k.id,
        );
      }
      return send(res, 200, { ok: true });
    }
  }

  // ---- accounts (plans) ----
  if (sub === '/accounts' && m === 'GET') {
    const [from, to] = range(url);
    const plans = R.plansOf(db, ws.id);
    const days = Math.max((to - from) / 86400000, 1 / 24);
    const usage = new Map(
      db.prepare('SELECT account_id, COUNT(*) AS requests, ROUND(SUM(cost),4) AS api_cost FROM requests WHERE workspace_id = ? AND ts >= ? AND ts < ? GROUP BY account_id').all(ws.id, from, to).map((r) => [r.account_id, r]),
    );
    const rows = db
      .prepare('SELECT a.*, u.name AS owner_name FROM accounts a LEFT JOIN users u ON u.id = a.owner_user_id WHERE a.workspace_id = ? AND a.removed_at IS NULL ORDER BY a.created_at')
      .all(ws.id)
      .map((a) => {
        const monthly = R.accountMonthly(a, plans);
        const u = usage.get(a.id) || { requests: 0, api_cost: 0 };
        const subCost = (monthly * days) / 30.4375;
        const visible = isAdmin || a.owner_user_id === user.id;
        return {
          id: a.id, kind: a.kind, role: a.role, provider: a.provider, email: visible ? a.email : maskEmail(a.email), label: a.label,
          account_type: a.account_type, visibility: a.visibility, owner_user_id: a.owner_user_id, owner_name: a.owner_name,
          plan: a.plan, monthly_cost: a.monthly_cost, effective_monthly: monthly, status: a.status, status_message: a.status_message,
          disabled: !!a.disabled, unavailable: !!a.unavailable, next_retry_after: a.next_retry_after, created_at: a.created_at,
          usage: u, subscription_cost: subCost, value_multiple: subCost > 0 ? (u.api_cost || 0) / subCost : null,
          can_manage: isAdmin || a.owner_user_id === user.id,
        };
      })
      .filter((a) => isAdmin || a.visibility === 'shared' || a.owner_user_id === user.id);
    const members = isAdmin ? db.prepare('SELECT u.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY u.name').all(ws.id) : [];
    return send(res, 200, { accounts: rows, plans, members, unclaimed: isAdmin && cfg.allowClaim ? pool.unclaimed : [], can_manage: isAdmin });
  }
  if (sub === '/accounts/oauth/start' && m === 'POST') {
    const b = await body(req);
    return send(res, 200, await pool.oauthStart({ provider: b.provider, workspaceId: ws.id, userId: user.id, visibility: b.visibility }));
  }
  if (sub === '/accounts/oauth/status' && m === 'GET') return send(res, 200, await pool.oauthStatus(url.searchParams.get('state'), ws.id, user.id));
  if (sub === '/accounts/oauth/callback' && m === 'POST') {
    const b = await body(req);
    return send(res, 200, await pool.oauthCallback(b.state, ws.id, user.id, b.redirect_url));
  }
  if (sub === '/accounts/apikey' && m === 'POST') {
    const b = await body(req);
    if (!isAdmin && b.visibility !== 'private') throw new HttpError(403, 'Members can only add private API keys.');
    const id = await pool.addApiKeyAccount({
      workspaceId: ws.id,
      userId: user.id,
      provider: b.provider,
      apiKey: String(b.api_key || '').trim(),
      label: clean(b.label, 80),
      role: isAdmin ? b.role : 'subscription',
      visibility: b.visibility,
      baseUrl: process.env.ALLOW_CUSTOM_BASE_URL === 'true' ? clean(b.base_url, 300) || null : null,
    });
    return send(res, 200, { id });
  }
  if (sub === '/accounts/claim' && m === 'POST') {
    needAdmin();
    if (!cfg.allowClaim) throw new HttpError(403, 'Claiming is disabled on this server.');
    const b = await body(req);
    await pool.claim(String(b.auth_index || ''), ws.id, user.id);
    return send(res, 200, { ok: true });
  }
  const am = sub.match(/^\/accounts\/(\d+)(\/(pause|resume))?$/);
  if (am) {
    const a = db.prepare('SELECT * FROM accounts WHERE id = ? AND workspace_id = ? AND removed_at IS NULL').get(Number(am[1]), ws.id);
    if (!a) throw new HttpError(404, 'Account not found.');
    if (!isAdmin && a.owner_user_id !== user.id) throw new HttpError(403, 'You can only manage plans you connected.');
    if (am[3] && m === 'POST') {
      await pool.setAccountDisabled(a, am[3] === 'pause');
      return send(res, 200, { ok: true });
    }
    if (!am[2] && m === 'DELETE') {
      await pool.removeAccount(a);
      return send(res, 200, { ok: true });
    }
    if (!am[2] && m === 'PATCH') {
      const b = await body(req);
      const plan = 'plan' in b ? b.plan || null : a.plan;
      const monthly = 'monthly_cost' in b ? numOrNull(b.monthly_cost) : a.monthly_cost;
      let visibility = 'visibility' in b ? (b.visibility === 'private' ? 'private' : 'shared') : a.visibility;
      let owner = a.owner_user_id;
      if ('owner_user_id' in b) {
        needAdmin();
        owner = b.owner_user_id ? Number(b.owner_user_id) : null;
        if (!owner) visibility = 'shared';
      }
      if (visibility === 'private' && !owner) throw bad('A private plan needs an owner.');
      db.prepare('UPDATE accounts SET plan = ?, monthly_cost = ?, visibility = ?, owner_user_id = ?, label = COALESCE(?, label) WHERE id = ?').run(plan, monthly, visibility, owner, b.label ? clean(b.label, 80) : null, a.id);
      if (visibility !== a.visibility || owner !== a.owner_user_id) await pool.updateAccountRouting(a);
      return send(res, 200, { ok: true });
    }
  }

  // ---- members & invites ----
  if (sub === '/members' && m === 'GET') {
    const [from, to] = range(url);
    const data = R.byMember(db, ws, from, to);
    const invites = isAdmin
      ? db.prepare('SELECT id, email, role, created_at, expires_at, accepted_at FROM invites WHERE workspace_id = ? AND revoked = 0 AND accepted_at IS NULL AND expires_at > ? ORDER BY created_at DESC').all(ws.id, Date.now())
      : [];
    if (!isAdmin) data.members = data.members.map((x) => ({ id: x.id, name: x.name, role: x.role }));
    return send(res, 200, { ...data, invites, can_manage: isAdmin, me: user.id });
  }
  if (sub === '/invites' && m === 'POST') {
    needAdmin();
    const b = await body(req);
    const email = clean(b.email, 200).toLowerCase() || null;
    if (email && !emailOk(email)) throw bad('That email looks invalid.');
    const r = ['admin', 'member'].includes(b.role) ? b.role : 'member';
    const token = randomToken(32);
    db.prepare('INSERT INTO invites (workspace_id, email, role, token_hash, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?)').run(ws.id, email, r, sha256(token), user.id, Date.now(), Date.now() + 14 * 86400000);
    return send(res, 200, { url: `${cfg.publicUrl}/invite/${token}` });
  }
  const im = sub.match(/^\/invites\/(\d+)$/);
  if (im && m === 'DELETE') {
    needAdmin();
    db.prepare('UPDATE invites SET revoked = 1 WHERE id = ? AND workspace_id = ?').run(Number(im[1]), ws.id);
    return send(res, 200, { ok: true });
  }
  const mem = sub.match(/^\/members\/(\d+)$/);
  if (mem) {
    needAdmin();
    const uid = Number(mem[1]);
    const target = db.prepare('SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?').get(ws.id, uid);
    if (!target) throw new HttpError(404, 'Member not found.');
    if (target.role === 'owner') throw bad('The workspace owner cannot be changed here.');
    if (m === 'PATCH') {
      const b = await body(req);
      if (!['admin', 'member'].includes(b.role)) throw bad('Role must be admin or member.');
      db.prepare('UPDATE memberships SET role = ? WHERE workspace_id = ? AND user_id = ?').run(b.role, ws.id, uid);
      return send(res, 200, { ok: true });
    }
    if (m === 'DELETE') {
      // Offboarding: revoke keys, and take their own plans out of the pool.
      const owned = db.prepare('SELECT * FROM accounts WHERE workspace_id = ? AND owner_user_id = ? AND removed_at IS NULL').all(ws.id, uid);
      db.prepare('UPDATE api_keys SET revoked_at = ? WHERE workspace_id = ? AND user_id = ? AND revoked_at IS NULL').run(Date.now(), ws.id, uid);
      db.prepare('DELETE FROM memberships WHERE workspace_id = ? AND user_id = ?').run(ws.id, uid);
      for (const a of owned) await pool.removeAccount(a);
      await pool.syncClientKeys().catch((err) => (pool.state.lastSyncError = err.message));
      return send(res, 200, { ok: true, removed_plans: owned.length });
    }
  }

  // ---- billing (simulated) ----
  if (sub === '/billing' && m === 'GET') return send(res, 200, { ...billing(ws), role });
  if (sub === '/billing/activate' && m === 'POST') {
    if (role !== 'owner') throw new HttpError(403, 'Only the workspace owner can change billing.');
    db.prepare("UPDATE workspaces SET billing_status = 'active', activated_at = ? WHERE id = ?").run(Date.now(), ws.id);
    return send(res, 200, { ok: true });
  }
  if (sub === '/billing/cancel' && m === 'POST') {
    if (role !== 'owner') throw new HttpError(403, 'Only the workspace owner can change billing.');
    db.prepare("UPDATE workspaces SET billing_status = 'canceled' WHERE id = ?").run(ws.id);
    return send(res, 200, { ok: true });
  }

  // ---- settings ----
  if (sub === '/settings' && m === 'GET') {
    needAdmin();
    return send(res, 200, {
      name: ws.name,
      seat_baseline_monthly: ws.seat_baseline_monthly,
      plans: R.plansOf(db, ws.id),
      prices: { ...DEFAULT_PRICES, ...getSetting(db, `ws:${ws.id}`, 'price_overrides', {}) },
      default_prices: DEFAULT_PRICES,
      health: pool.state,
    });
  }
  if (sub === '/settings' && m === 'PUT') {
    needAdmin();
    const b = await body(req);
    if (b.name) db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(clean(b.name), ws.id);
    if (b.seat_baseline_monthly != null) db.prepare('UPDATE workspaces SET seat_baseline_monthly = ? WHERE id = ?').run(Math.max(0, Number(b.seat_baseline_monthly) || 0), ws.id);
    if (b.plans && typeof b.plans === 'object') {
      const plans = {};
      for (const [k, p] of Object.entries(b.plans)) plans[k] = { label: clean(p.label, 60), monthly: Math.max(0, Number(p.monthly) || 0) };
      setSetting(db, `ws:${ws.id}`, 'plans', plans);
    }
    if (b.prices && typeof b.prices === 'object') {
      const overrides = {};
      for (const [k, v] of Object.entries(b.prices)) {
        const d = DEFAULT_PRICES[k];
        const p = { in: +v.in || 0, out: +v.out || 0, cr: +v.cr || 0, cw: +v.cw || 0 };
        if (!d || d.in !== p.in || d.out !== p.out || d.cr !== p.cr || d.cw !== p.cw) overrides[k] = p;
      }
      setSetting(db, `ws:${ws.id}`, 'price_overrides', overrides);
      pool.recomputeCosts(ws.id);
    }
    return send(res, 200, { ok: true });
  }

  throw new HttpError(404, 'Not found.');
}

function maskEmail(e) {
  if (!e || !e.includes('@')) return e;
  const [u, d] = e.split('@');
  return `${u.slice(0, 2)}…@${d}`;
}

// ---------- static ----------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const PAGES = { '/': 'landing.html', '/pricing': 'pricing.html', '/docs': 'docs.html', '/login': 'auth.html', '/signup': 'auth.html', '/app': 'app.html' };

async function serveFile(res, file) {
  try {
    const data = await readFile(join(here, 'public', file));
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  const ip = req.socket.remoteAddress || '';
  try {
    if (path.startsWith('/v1/')) return await gateway(req, res, url);
    if (path === '/healthz') return send(res, 200, { ok: true });
    if (path === '/setup.sh') {
      res.writeHead(200, { 'Content-Type': 'text/x-shellscript; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(setupScript(cfg.publicUrl));
    }
    if (path.startsWith('/api/')) {
      // CSRF guard: state-changing calls must be JSON (cross-site forms can't send it without CORS).
      if (req.method !== 'GET' && !String(req.headers['content-type'] || '').includes('application/json')) throw new HttpError(415, 'Use application/json.');
      const pub = await authApi(req, res, url, path, ip);
      if (pub !== null && pub !== undefined) return;
      if (res.writableEnded) return;
      const user = currentUser(req);
      if (!user) throw new HttpError(401, 'Not signed in.');
      if ((await userApi(req, res, url, path, user)) !== null || res.writableEnded) return;
      if ((await wsApi(req, res, url, path, user)) !== null || res.writableEnded) return;
      throw new HttpError(404, 'Not found.');
    }
    if (PAGES[path]) return serveFile(res, PAGES[path]);
    const invitePath = path.match(/^\/invite\/([A-Za-z0-9]+)$/);
    if (invitePath) {
      res.writeHead(302, { Location: `/signup?invite=${invitePath[1]}` });
      return res.end();
    }
    if (/^\/[a-z0-9_-]+\.(js|css|svg)$/.test(path)) return serveFile(res, path.slice(1));
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  } catch (err) {
    const status = err instanceof HttpError ? err.status : err.status && err.status < 600 ? (err.status >= 500 ? 502 : err.status) : 500;
    if (status >= 500) console.error(`[${req.method} ${path}]`, err);
    if (!res.headersSent) send(res, status, { error: err.message });
    else res.end();
  }
});

server.listen(cfg.port, cfg.host, async () => {
  console.log(`AI Pool on ${cfg.publicUrl}  (listening ${cfg.host}:${cfg.port}, proxy ${cfg.cpaUrl})`);
  try {
    await pool.ensureProxySettings();
  } catch (err) {
    console.error('could not configure proxy yet:', err.message);
  }
  pool.start();
});
