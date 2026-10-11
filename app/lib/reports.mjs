import { getSetting } from './db.mjs';
import { DEFAULT_PLANS } from './pricing.mjs';
import { monthStart } from './gateway.mjs';

const DAY = 86400000;
const MONTH_DAYS = 30.4375;

const TOK = 'uncached + unclassified + cache_read + cache_write + output';
const AGG = `COUNT(*) AS requests, COALESCE(SUM(failed),0) AS failed,
  COALESCE(SUM(uncached + unclassified),0) AS input_tokens, COALESCE(SUM(cache_read),0) AS cache_read_tokens,
  COALESCE(SUM(cache_write),0) AS cache_write_tokens, COALESCE(SUM(output),0) AS output_tokens,
  COALESCE(SUM(${TOK}),0) AS tokens, ROUND(COALESCE(SUM(cost),0), 6) AS api_cost`;

export function plansOf(db, wsId) {
  return { ...DEFAULT_PLANS, ...getSetting(db, `ws:${wsId}`, 'plans', {}) };
}

export function accountMonthly(a, plans) {
  if (a.role === 'overflow' || a.kind === 'apikey') return 0; // billed per token by the provider
  if (a.monthly_cost != null) return a.monthly_cost;
  if (a.plan && plans[a.plan]) return plans[a.plan].monthly;
  return 0;
}

// Optional filter: { userId } restricts to one person's traffic.
function scope(f = {}) {
  return f.userId != null ? { sql: ' AND user_id = ?', args: [f.userId] } : { sql: '', args: [] };
}

export function summary(db, ws, from, to, f = {}) {
  const sc = scope(f);
  const days = Math.max((to - from) / DAY, 1 / 24);
  const usage = db.prepare(`SELECT ${AGG} FROM requests WHERE workspace_id = ? AND ts >= ? AND ts < ?${sc.sql}`).get(ws.id, from, to, ...sc.args);
  const overflowCost = db
    .prepare(`SELECT COALESCE(SUM(r.cost),0) AS c FROM requests r JOIN accounts a ON a.id = r.account_id WHERE r.workspace_id = ? AND r.ts >= ? AND r.ts < ? AND a.kind = 'apikey'${sc.sql.replace('user_id', 'r.user_id')}`)
    .get(ws.id, from, to, ...sc.args).c;
  const plans = plansOf(db, ws.id);
  const accounts = db
    .prepare(
      `SELECT * FROM accounts WHERE workspace_id = ? AND (removed_at IS NULL OR removed_at >= ?) AND created_at < ?`,
    )
    .all(ws.id, from, to);
  const monthlySubs = accounts.filter((a) => !a.removed_at).reduce((s, a) => s + accountMonthly(a, plans), 0);
  const subCost = (monthlySubs * days) / MONTH_DAYS;
  const unpriced = accounts.filter((a) => !a.removed_at && a.kind === 'oauth' && !a.plan && a.monthly_cost == null).length;
  const active = db.prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM requests WHERE workspace_id = ? AND ts >= ? AND ts < ? AND user_id IS NOT NULL`).get(ws.id, from, to).n;
  const members = db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = ?').get(ws.id).n;
  const seatCost = (ws.seat_baseline_monthly * active * days) / MONTH_DAYS;
  // Value delivered by subscriptions = everything except pay-per-token overflow.
  const subValue = usage.api_cost - overflowCost;
  return {
    days,
    usage,
    api_cost: usage.api_cost,
    overflow_cost: overflowCost,
    subscription_value: subValue,
    subscription_cost: subCost,
    monthly_subscriptions: monthlySubs,
    accounts: accounts.filter((a) => !a.removed_at).length,
    unpriced_accounts: unpriced,
    savings_vs_api: subValue - subCost,
    value_multiple: subCost > 0 ? subValue / subCost : null,
    members: { active, total: members },
    seat_baseline_monthly: ws.seat_baseline_monthly,
    seat_cost: seatCost,
    savings_vs_seats: seatCost - subCost,
    run_rate: (usage.api_cost / days) * MONTH_DAYS,
  };
}

export function timeseries(db, ws, from, to, tzOffsetMin = 0, f = {}) {
  const sc = scope(f);
  const bucketMs = to - from <= 2 * DAY ? 3600000 : DAY;
  const off = tzOffsetMin * 60000;
  const rows = db
    .prepare(
      `SELECT CAST((ts - ?) / ? AS INTEGER) * ? + ? AS bucket, COALESCE(provider,'other') AS provider,
              COUNT(*) AS requests, SUM(${TOK}) AS tokens, ROUND(SUM(cost), 6) AS api_cost
         FROM requests WHERE workspace_id = ? AND ts >= ? AND ts < ?${sc.sql}
        GROUP BY bucket, provider ORDER BY bucket`,
    )
    .all(off, bucketMs, bucketMs, off, ws.id, from, to, ...sc.args);
  return { bucket_ms: bucketMs, rows };
}

export function byKey(db, ws, from, to, f = {}) {
  const sc = scope(f);
  const usage = new Map(
    db
      .prepare(`SELECT key_id, ${AGG}, MAX(ts) AS last_used FROM requests WHERE workspace_id = ? AND ts >= ? AND ts < ?${sc.sql} GROUP BY key_id`)
      .all(ws.id, from, to, ...sc.args)
      .map((r) => [r.key_id, r]),
  );
  const month = new Map(
    db
      .prepare(`SELECT key_id, ROUND(SUM(cost),4) AS cost, SUM(${TOK}) AS tokens FROM requests WHERE workspace_id = ? AND ts >= ? GROUP BY key_id`)
      .all(ws.id, monthStart())
      .map((r) => [r.key_id, r]),
  );
  const where = f.userId != null ? ' AND (k.user_id = ? OR k.created_by = ?)' : '';
  const args = f.userId != null ? [f.userId, f.userId] : [];
  return db
    .prepare(
      `SELECT k.id, k.name, k.scope_type, k.key_hint, k.user_id, k.budget_usd, k.budget_tokens, k.created_at, k.revoked_at, k.last_used_at,
              u.name AS user_name, c.name AS created_by_name
         FROM api_keys k LEFT JOIN users u ON u.id = k.user_id LEFT JOIN users c ON c.id = k.created_by
        WHERE k.workspace_id = ?${where} ORDER BY k.revoked_at IS NOT NULL, k.created_at DESC`,
    )
    .all(ws.id, ...args)
    .map((k) => ({ ...k, usage: usage.get(k.id) || { requests: 0, tokens: 0, api_cost: 0 }, month: month.get(k.id) || { cost: 0, tokens: 0 } }));
}

export function byMember(db, ws, from, to) {
  const usage = new Map(
    db
      .prepare(`SELECT user_id, ${AGG}, MAX(ts) AS last_used FROM requests WHERE workspace_id = ? AND ts >= ? AND ts < ? GROUP BY user_id`)
      .all(ws.id, from, to)
      .map((r) => [r.user_id, r]),
  );
  const members = db
    .prepare(
      `SELECT u.id, u.name, u.email, m.role, m.created_at,
              (SELECT COUNT(*) FROM api_keys k WHERE k.workspace_id = m.workspace_id AND k.user_id = u.id AND k.revoked_at IS NULL) AS keys,
              (SELECT COUNT(*) FROM accounts a WHERE a.workspace_id = m.workspace_id AND a.owner_user_id = u.id AND a.removed_at IS NULL) AS plans
         FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.created_at`,
    )
    .all(ws.id)
    .map((m) => ({ ...m, usage: usage.get(m.id) || { requests: 0, tokens: 0, api_cost: 0 } }));
  const shared = usage.get(null);
  return { members, unattributed: shared || null };
}

export function byModel(db, ws, from, to, f = {}) {
  const sc = scope(f);
  return db
    .prepare(`SELECT model, provider, MAX(price_estimated) AS price_estimated, ${AGG} FROM requests WHERE workspace_id = ? AND ts >= ? AND ts < ?${sc.sql} GROUP BY model, provider ORDER BY api_cost DESC`)
    .all(ws.id, from, to, ...sc.args);
}

export function recent(db, ws, limit, f = {}) {
  const sc = scope(f);
  return db
    .prepare(
      `SELECT r.ts, r.provider, r.model, r.failed, r.status_code, r.latency_ms, r.cost, ${TOK.split(' + ').map((c) => 'r.' + c).join(' + ')} AS tokens,
              u.name AS user_name, k.name AS key_name, COALESCE(a.email, a.label) AS account
         FROM requests r LEFT JOIN users u ON u.id = r.user_id LEFT JOIN api_keys k ON k.id = r.key_id LEFT JOIN accounts a ON a.id = r.account_id
        WHERE r.workspace_id = ?${sc.sql.replace('user_id', 'r.user_id')} ORDER BY r.ts DESC LIMIT ?`,
    )
    .all(ws.id, ...sc.args, limit);
}

// ---------- capacity ----------

const num = (v) => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));

// Normalizes provider quota signals into rate-limit windows.
export function windowsFromQuota(provider, q, observedAt) {
  if (!q) return [];
  const out = [];
  if (provider === 'claude') {
    for (const [w, label, len] of [['5h', '5-hour', 5 * 3600], ['7d', 'Weekly', 7 * 86400]]) {
      let util = num(q[`anthropic-ratelimit-unified-${w}-utilization`]);
      const reset = num(q[`anthropic-ratelimit-unified-${w}-reset`]);
      if (util == null && reset == null) continue;
      if (util != null && util > 1) util = util / 100;
      out.push({ label, used: util, resets_at: reset ? reset * 1000 : null, window_s: len, status: q[`anthropic-ratelimit-unified-${w}-status`] || null });
    }
  } else if (provider === 'codex') {
    for (const [w, fallback] of [['primary', '5-hour'], ['secondary', 'Weekly']]) {
      const used = num(q[`x-codex-${w}-used-percent`]);
      const mins = num(q[`x-codex-${w}-window-minutes`]);
      const after = num(q[`x-codex-${w}-reset-after-seconds`]);
      const at = num(q[`x-codex-${w}-reset-at`]);
      if (used == null && at == null && after == null) continue;
      const label = mins ? (mins >= 7 * 1440 ? 'Weekly' : mins >= 1440 ? `${Math.round(mins / 1440)}-day` : `${Math.round(mins / 60)}-hour`) : fallback;
      out.push({ label, used: used != null ? used / 100 : null, resets_at: at ? at * 1000 : after != null ? (observedAt || Date.now()) + after * 1000 : null, window_s: mins ? mins * 60 : null });
    }
  }
  return out;
}

export function capacity(db, ws, viewerId = null) {
  const now = Date.now();
  const accounts = db
    .prepare(
      `SELECT a.*, u.name AS owner_name FROM accounts a LEFT JOIN users u ON u.id = a.owner_user_id
        WHERE a.workspace_id = ? AND a.removed_at IS NULL ORDER BY a.provider, a.created_at`,
    )
    .all(ws.id);
  const last5h = new Map(db.prepare(`SELECT account_id, COUNT(*) AS requests, SUM(${TOK}) AS tokens FROM requests WHERE workspace_id = ? AND ts >= ? GROUP BY account_id`).all(ws.id, now - 5 * 3600000).map((r) => [r.account_id, r]));
  const rows = accounts.map((a) => {
    let quota = null;
    try {
      quota = a.quota_json ? JSON.parse(a.quota_json) : null;
    } catch {}
    const windows = windowsFromQuota(a.provider, quota, a.quota_at).map((w) => ({
      ...w,
      // Past reset times mean the window has rolled over since we last looked.
      used: w.resets_at && w.resets_at < now ? 0 : w.used,
      stale: !!(w.resets_at && w.resets_at < now),
    }));
    const weekly = windows.find((w) => w.label === 'Weekly');
    const state = a.disabled ? 'paused' : a.unavailable || (a.next_retry_after && Date.parse(a.next_retry_after) > now) ? 'cooling' : a.status && !['active', 'pending'].includes(a.status) ? 'error' : 'ready';
    return {
      id: a.id,
      provider: a.provider,
      kind: a.kind,
      role: a.role,
      email: a.email || a.label,
      plan: a.plan,
      visibility: a.visibility,
      owner_name: a.owner_name,
      owner_user_id: a.owner_user_id,
      state,
      status_message: a.status_message,
      next_retry_after: a.next_retry_after,
      windows,
      observed_at: a.quota_at,
      last_5h: last5h.get(a.id) || { requests: 0, tokens: 0 },
      // Share of this week's allowance that will reset unused if usage stays flat.
      weekly_unused: weekly && weekly.used != null && weekly.resets_at ? { share: Math.max(0, 1 - weekly.used), resets_at: weekly.resets_at } : null,
      mine: viewerId != null && a.owner_user_id === viewerId,
    };
  });
  const byProvider = {};
  for (const r of rows.filter((x) => x.role !== 'overflow')) {
    const p = (byProvider[r.provider] ||= { provider: r.provider, accounts: 0, ready: 0, avg5h: null, avgWeekly: null, next_reset: null, _5: [], _w: [] });
    p.accounts++;
    if (r.state === 'ready') p.ready++;
    for (const w of r.windows) {
      if (w.used != null) (w.label === 'Weekly' ? p._w : p._5).push(w.used);
      if (w.resets_at && w.resets_at > now && (!p.next_reset || w.resets_at < p.next_reset)) p.next_reset = w.resets_at;
    }
  }
  for (const p of Object.values(byProvider)) {
    p.avg5h = p._5.length ? p._5.reduce((s, v) => s + v, 0) / p._5.length : null;
    p.avgWeekly = p._w.length ? p._w.reduce((s, v) => s + v, 0) / p._w.length : null;
    delete p._5;
    delete p._w;
  }
  return { accounts: rows, providers: Object.values(byProvider) };
}
