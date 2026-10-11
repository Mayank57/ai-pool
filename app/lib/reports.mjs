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
  if (a.plan && Object.hasOwn(plans, a.plan)) return plans[a.plan].monthly;
  return 0;
}

// Days an account was connected inside [from, to].
export function overlapDays(a, from, to) {
  const start = Math.max(from, a.created_at || from);
  const end = Math.min(to, a.removed_at || to);
  return Math.max(0, (end - start) / DAY);
}

// Prorated subscription cost of one account for the period.
export function accountCost(a, plans, from, to) {
  return (accountMonthly(a, plans) * overlapDays(a, from, to)) / MONTH_DAYS;
}

export function maskEmail(e) {
  if (!e || !e.includes('@')) return e;
  const [u, d] = e.split('@');
  return `${u.slice(0, 2)}…@${d}`;
}

// Optional filter: { userId } restricts to one person's traffic.
function scope(f = {}) {
  return f.userId != null ? { sql: ' AND user_id = ?', args: [f.userId] } : { sql: '', args: [] };
}

// Accounts that were connected at any point during the period.
function periodAccounts(db, ws, from, to) {
  return db
    .prepare(`SELECT * FROM accounts WHERE workspace_id = ? AND created_at < ? AND (removed_at IS NULL OR removed_at > ?)`)
    .all(ws.id, to, from);
}

export function summary(db, ws, from, to, f = {}) {
  const sc = scope(f);
  const days = Math.max((to - from) / DAY, 1 / 24);
  const usage = db.prepare(`SELECT ${AGG} FROM requests WHERE workspace_id = ? AND ts >= ? AND ts < ?${sc.sql}`).get(ws.id, from, to, ...sc.args);
  const overflowCost = db
    .prepare(`SELECT COALESCE(SUM(r.cost),0) AS c FROM requests r JOIN accounts a ON a.id = r.account_id WHERE r.workspace_id = ? AND r.ts >= ? AND r.ts < ? AND a.kind = 'apikey'${sc.sql.replace('user_id', 'r.user_id')}`)
    .get(ws.id, from, to, ...sc.args).c;
  const plans = plansOf(db, ws.id);
  const accounts = periodAccounts(db, ws, from, to);
  const live = accounts.filter((a) => !a.removed_at);
  const monthlySubs = live.reduce((s, a) => s + accountMonthly(a, plans), 0);
  const subCost = accounts.reduce((s, a) => s + accountCost(a, plans, from, to), 0);
  const unpriced = live.filter((a) => a.kind === 'oauth' && !a.plan && a.monthly_cost == null).length;
  const active = db.prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM requests WHERE workspace_id = ? AND ts >= ? AND ts < ? AND user_id IS NOT NULL`).get(ws.id, from, to).n;
  const members = db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = ?').get(ws.id).n;
  const seatCost = (ws.seat_baseline_monthly * active * days) / MONTH_DAYS;
  const first = db.prepare('SELECT MIN(ts) AS t FROM requests WHERE workspace_id = ?').get(ws.id).t;
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
    accounts: live.length,
    unpriced_accounts: unpriced,
    savings_vs_api: subValue - subCost,
    value_multiple: subCost > 0 ? subValue / subCost : null,
    members: { active, total: members },
    seat_baseline_monthly: ws.seat_baseline_monthly,
    seat_cost: seatCost,
    savings_vs_seats: seatCost - subCost,
    run_rate: (usage.api_cost / days) * MONTH_DAYS,
    first_request_at: first,
    // Too little history for the savings figures to mean anything yet.
    collecting: !first || Date.now() - first < DAY || usage.requests < 20,
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

// viewer: { id, isAdmin }. Members see their own traffic; shared plans' emails are masked for them.
export function recent(db, ws, limit, viewer) {
  const sc = viewer.isAdmin ? scope() : scope({ userId: viewer.id });
  return db
    .prepare(
      `SELECT r.ts, r.provider, r.model, r.failed, r.status_code, r.latency_ms, r.cost, ${TOK.split(' + ').map((c) => 'r.' + c).join(' + ')} AS tokens,
              u.name AS user_name, k.name AS key_name, COALESCE(a.email, a.label) AS account, a.owner_user_id AS account_owner
         FROM requests r LEFT JOIN users u ON u.id = r.user_id LEFT JOIN api_keys k ON k.id = r.key_id LEFT JOIN accounts a ON a.id = r.account_id
        WHERE r.workspace_id = ?${sc.sql.replace('user_id', 'r.user_id')} ORDER BY r.ts DESC LIMIT ?`,
    )
    .all(ws.id, ...sc.args, limit)
    .map(({ account_owner, ...r }) => ({ ...r, account: viewer.isAdmin || account_owner === viewer.id ? r.account : maskEmail(r.account) }));
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

function accountWindows(a, now) {
  let quota = null;
  try {
    quota = a.quota_json ? JSON.parse(a.quota_json) : null;
  } catch {}
  return windowsFromQuota(a.provider, quota, a.quota_at).map((w) => ({
    ...w,
    // Past reset times mean the window has rolled over since we last looked.
    used: w.resets_at && w.resets_at < now ? 0 : w.used,
    stale: !!(w.resets_at && w.resets_at < now),
  }));
}

function accountState(a, now) {
  if (a.disabled) return 'paused';
  if (a.unavailable || (a.next_retry_after && Date.parse(a.next_retry_after) > now)) return 'cooling';
  if (a.status && !['active', 'pending'].includes(a.status)) return 'error';
  return 'ready';
}

// viewer: { id, isAdmin }. Members only see shared plans and their own, with other plans' emails masked.
export function capacity(db, ws, viewer) {
  const now = Date.now();
  const accounts = db
    .prepare(
      `SELECT a.*, u.name AS owner_name FROM accounts a LEFT JOIN users u ON u.id = a.owner_user_id
        WHERE a.workspace_id = ? AND a.removed_at IS NULL ORDER BY a.provider, a.created_at`,
    )
    .all(ws.id)
    .filter((a) => viewer.isAdmin || a.visibility === 'shared' || a.owner_user_id === viewer.id);
  const last5h = new Map(db.prepare(`SELECT account_id, COUNT(*) AS requests, SUM(${TOK}) AS tokens FROM requests WHERE workspace_id = ? AND ts >= ? GROUP BY account_id`).all(ws.id, now - 5 * 3600000).map((r) => [r.account_id, r]));
  const rows = accounts.map((a) => {
    const windows = accountWindows(a, now);
    const weekly = windows.find((w) => w.label === 'Weekly');
    const mine = a.owner_user_id === viewer.id;
    return {
      id: a.id,
      provider: a.provider,
      kind: a.kind,
      role: a.role,
      email: viewer.isAdmin || mine ? a.email || a.label : maskEmail(a.email) || a.label,
      plan: a.plan,
      visibility: a.visibility,
      owner_name: a.owner_name,
      owner_user_id: a.owner_user_id,
      state: accountState(a, now),
      status_message: a.status_message,
      next_retry_after: a.next_retry_after,
      windows,
      observed_at: a.quota_at,
      last_5h: last5h.get(a.id) || { requests: 0, tokens: 0 },
      // Share of this week's allowance that will reset unused if usage stays flat.
      weekly_unused: weekly && weekly.used != null && weekly.resets_at ? { share: Math.max(0, 1 - weekly.used), resets_at: weekly.resets_at } : null,
      mine,
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

// ---------- insights ----------

// Plan tiers per provider, cheapest first, used to suggest up/downgrades.
const LADDER = { claude: ['claude-pro', 'claude-max-5x', 'claude-max-20x'], codex: ['chatgpt-plus', 'chatgpt-pro'] };

function neighbourPlan(plan, provider, plans, dir) {
  const ladder = LADDER[provider] || [];
  const i = ladder.indexOf(plan);
  if (i < 0) return null;
  const next = ladder[i + dir];
  return next && Object.hasOwn(plans, next) ? { key: next, ...plans[next] } : null;
}

// Rule-based recommendations for the workspace over [from, to]. Each item:
// { kind: 'save' | 'capacity' | 'hygiene' | 'good', title, detail, page, impact_monthly }
export function insights(db, ws, from, to) {
  const now = Date.now();
  const plans = plansOf(db, ws.id);
  const out = [];
  const days = Math.max((to - from) / DAY, 1 / 24);
  const accounts = periodAccounts(db, ws, from, to).filter((a) => !a.removed_at);
  const usage = new Map(
    db
      .prepare(`SELECT account_id, COUNT(*) AS requests, SUM(CASE WHEN failed = 1 AND status_code = 429 THEN 1 ELSE 0 END) AS limited, ROUND(SUM(cost),4) AS api_cost FROM requests WHERE workspace_id = ? AND ts >= ? AND ts < ? GROUP BY account_id`)
      .all(ws.id, from, to)
      .map((r) => [r.account_id, r]),
  );
  const label = (a) => a.email || a.label || `${a.provider} plan`;

  for (const a of accounts) {
    if (a.kind !== 'oauth') continue;
    const monthly = accountMonthly(a, plans);
    const u = usage.get(a.id) || { requests: 0, limited: 0, api_cost: 0 };
    const connectedDays = overlapDays(a, from, to);
    const cost = accountCost(a, plans, from, to);
    const windows = accountWindows(a, now);
    const weekly = windows.find((w) => w.label === 'Weekly');
    const short = windows.find((w) => w.label !== 'Weekly');

    // Underused: a week or more of history and the plan returns less than half its price.
    if (monthly > 0 && connectedDays >= 7 && u.api_cost < cost * 0.5) {
      const lower = neighbourPlan(a.plan, a.provider, plans, -1);
      const monthlyValue = (u.api_cost / connectedDays) * MONTH_DAYS;
      if (lower) {
        out.push({
          kind: 'save',
          title: `${label(a)} is underused`,
          detail: `It delivered ${fmt(monthlyValue)}/mo of API-priced usage against a ${fmt(monthly)}/mo plan. ${lower.label} (${fmt(lower.monthly)}/mo) would likely cover it.`,
          page: 'plans',
          impact_monthly: monthly - lower.monthly,
        });
      } else {
        out.push({
          kind: 'save',
          title: `${label(a)} is barely used`,
          detail: `${fmt(monthlyValue)}/mo of usage on a ${fmt(monthly)}/mo plan. If the team can live without it, removing it saves the full amount.`,
          page: 'plans',
          impact_monthly: monthly,
        });
      }
    }

    // Saturated: live windows near the ceiling or repeated provider rate limits.
    const hot = (weekly && weekly.used != null && weekly.used >= 0.85) || (short && short.used != null && short.used >= 0.9) || u.limited >= 3;
    if (hot) {
      const higher = neighbourPlan(a.plan, a.provider, plans, 1);
      const why = u.limited >= 3 ? `${u.limited} requests hit its rate limit this period` : weekly && weekly.used >= 0.85 ? `${Math.round(weekly.used * 100)}% of its weekly allowance is used` : `${Math.round(short.used * 100)}% of its 5-hour allowance is used`;
      out.push({
        kind: 'capacity',
        title: `${label(a)} is near its limit`,
        detail: `${why}. ${higher ? `Upgrading to ${higher.label} (+${fmt(higher.monthly - monthly)}/mo) or adding another plan` : 'Adding another plan or an overflow API key'} avoids stalls.`,
        page: 'capacity',
        impact_monthly: 0,
      });
    }
  }

  // Overflow spend that a subscription would cover.
  const overflow = db
    .prepare(`SELECT COALESCE(SUM(r.cost),0) AS c, COUNT(*) AS n FROM requests r JOIN accounts a ON a.id = r.account_id WHERE r.workspace_id = ? AND r.ts >= ? AND r.ts < ? AND a.kind = 'apikey'`)
    .get(ws.id, from, to);
  if (overflow.c > 0) {
    const monthlyOverflow = (overflow.c / days) * MONTH_DAYS;
    const cheapest = Object.values(plans).filter((p) => p.monthly > 0).sort((x, y) => x.monthly - y.monthly)[0];
    if (cheapest && monthlyOverflow >= cheapest.monthly * 0.6) {
      out.push({
        kind: 'save',
        title: 'Pay-per-token spend could be a subscription',
        detail: `Overflow API keys are running at ${fmt(monthlyOverflow)}/mo. Another plan (from ${fmt(cheapest.monthly)}/mo) would absorb that at a flat price.`,
        page: 'plans',
        impact_monthly: Math.max(0, monthlyOverflow - cheapest.monthly),
      });
    }
  }

  // Idle members and never-used keys: wasted seats and needless exposure.
  const idle = db
    .prepare(
      `SELECT COUNT(*) AS n FROM memberships m WHERE m.workspace_id = ? AND m.created_at < ?
          AND NOT EXISTS (SELECT 1 FROM requests r WHERE r.workspace_id = m.workspace_id AND r.user_id = m.user_id AND r.ts >= ? AND r.ts < ?)`,
    )
    .get(ws.id, to - 7 * DAY, from, to).n;
  if (idle > 0 && days >= 7) {
    out.push({
      kind: 'hygiene',
      title: `${idle} member${idle === 1 ? ' has' : 's have'} not used the pool`,
      detail: `They joined over a week ago but made no requests in this period. Check they ran the setup script, or remove seats you don't need.`,
      page: 'members',
      impact_monthly: 0,
    });
  }
  const unusedKeys = db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE workspace_id = ? AND revoked_at IS NULL AND last_used_at IS NULL AND created_at < ?').get(ws.id, now - 7 * DAY).n;
  if (unusedKeys > 0) {
    out.push({
      kind: 'hygiene',
      title: `${unusedKeys} key${unusedKeys === 1 ? ' has' : 's have'} never been used`,
      detail: 'Keys older than a week with no traffic are probably forgotten. Revoking them removes a way in.',
      page: 'keys',
      impact_monthly: 0,
    });
  }

  // Good news is worth stating too.
  const s = summary(db, ws, from, to);
  if (!s.collecting && s.value_multiple != null && s.value_multiple >= 1.5) {
    out.push({
      kind: 'good',
      title: `Your plans return ${s.value_multiple.toFixed(1)}× their cost`,
      detail: `${fmt(s.subscription_value)} of API-priced usage for ${fmt(s.subscription_cost)} in subscriptions this period. Pooling is paying off.`,
      page: null,
      impact_monthly: 0,
    });
  }

  const order = { save: 0, capacity: 1, hygiene: 2, good: 3 };
  return out.sort((x, y) => order[x.kind] - order[y.kind] || y.impact_monthly - x.impact_monthly);
}

function fmt(n) {
  const v = Number(n) || 0;
  return '$' + (Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : v.toFixed(2).replace(/\.00$/, ''));
}
