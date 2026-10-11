// Keeps CLIProxyAPI in sync with the app's workspaces and ingests usage.
//
// Isolation model: every credential in the proxy carries a routing prefix.
//   shared account  -> "<workspace prefix>"          (whole workspace)
//   private account -> "<workspace prefix>-u<user>"  (only its owner)
// With routing.force-model-prefix = true, a request for "ws1/claude-opus-5-5"
// can only be served by credentials whose prefix is "ws1". The gateway adds
// the prefix, so clients never see or choose it.
import { tx, getSetting } from './db.mjs';
import { DEFAULT_PRICES, costOf, resolvePrice } from './pricing.mjs';
import { sha256 } from './security.mjs';

const SUB_PRIORITY = 10;
const OVERFLOW_PRIORITY = 0;
const MANAGED = 'aipool-';

export function accountPrefix(ws, account) {
  return account.visibility === 'private' && account.owner_user_id ? `${ws.prefix}-u${account.owner_user_id}` : ws.prefix;
}

export function pricesFor(db, workspaceId) {
  return { ...DEFAULT_PRICES, ...getSetting(db, `ws:${workspaceId}`, 'price_overrides', {}) };
}

// Canonical non-overlapping token counts from a usage event.
export function tokensOf(ev) {
  const b = ev.token_breakdown;
  if (b && b.input && b.output) {
    return {
      uncached: b.input.uncached_tokens || 0,
      cacheRead: b.input.cache_read_tokens || 0,
      cacheWrite: b.input.cache_write_tokens || 0,
      output: b.output.total_tokens || 0,
      reasoning: b.output.reasoning_tokens || 0,
      unclassified: b.unclassified_tokens || 0,
    };
  }
  const t = ev.tokens || {};
  const cacheRead = t.cache_read_tokens || t.cached_tokens || 0;
  return {
    uncached: Math.max(0, (t.input_tokens || 0) - cacheRead),
    cacheRead,
    cacheWrite: t.cache_creation_tokens || 0,
    output: (t.output_tokens || 0) + (t.reasoning_tokens || 0),
    reasoning: t.reasoning_tokens || 0,
    unclassified: 0,
  };
}

// Extracts subscription quota signals (rate-limit windows) from response headers.
export function quotaFromHeaders(headers) {
  if (!headers || typeof headers !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const name = k.toLowerCase();
    if (name.startsWith('anthropic-ratelimit-unified-') || name.startsWith('x-codex-primary-') || name.startsWith('x-codex-secondary-') || name === 'x-codex-plan-type') {
      out[name] = Array.isArray(v) ? v[v.length - 1] : String(v);
    }
  }
  return Object.keys(out).length ? out : null;
}

function lowerKeys(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) out[k.toLowerCase()] = v;
  return out;
}

export class Pool {
  constructor({ db, cpa, crypto, log = console }) {
    this.db = db;
    this.cpa = cpa;
    this.crypto = crypto;
    this.log = log;
    this.state = { lastPollAt: null, lastPollError: null, lastSyncAt: null, lastSyncError: null, ingested: 0 };
    this.oauthSessions = new Map();
    this.unclaimed = [];
  }

  ws(id) {
    return this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
  }

  // ---------- proxy-wide settings ----------

  async ensureProxySettings() {
    await this.cpa.patchConfig({
      routing: { 'force-model-prefix': true, 'session-affinity': true },
      observability: { usage: { 'usage-statistics-enabled': true, 'redis-usage-queue-retention-seconds': 3600 } },
    });
  }

  // ---------- client keys ----------

  // Proxy access keys = internal keys of all live gateway keys. Revoked keys
  // are removed; keys not created by the app are left alone.
  async syncClientKeys() {
    const rows = this.db.prepare('SELECT cpa_key, revoked_at FROM api_keys').all();
    const live = rows.filter((r) => !r.revoked_at).map((r) => r.cpa_key);
    const dead = new Set(rows.filter((r) => r.revoked_at).map((r) => r.cpa_key));
    const current = await this.cpa.getClientKeys();
    const next = [...new Set([...current.filter((k) => !dead.has(k)), ...live])];
    if (next.length !== current.length || next.some((k) => !current.includes(k))) await this.cpa.setClientKeys(next);
  }

  // ---------- API-key accounts (overflow / BYO API keys) ----------

  async syncApiKeyAccounts() {
    const rows = this.db
      .prepare(`SELECT a.*, w.prefix AS ws_prefix FROM accounts a JOIN workspaces w ON w.id = a.workspace_id WHERE a.kind = 'apikey' AND a.removed_at IS NULL`)
      .all();
    for (const provider of ['claude', 'codex']) {
      const current = await this.cpa.getProviderKeys(provider);
      const foreign = current.filter((g) => !String(g.name || '').startsWith(MANAGED));
      const ours = rows
        .filter((a) => a.provider === provider && !a.disabled)
        .map((a) => {
          const g = {
            name: `${MANAGED}${a.id}`,
            prefix: accountPrefix({ prefix: a.ws_prefix }, a),
            priority: a.role === 'overflow' ? OVERFLOW_PRIORITY : SUB_PRIORITY,
            keys: [{ 'api-key': this.crypto.decrypt(a.api_key_enc) }],
          };
          if (a.base_url) g['base-url'] = a.base_url;
          return g;
        });
      const strip = (g) => ({ ...g, keys: (g.keys || []).map(({ auth_index, ...k }) => k) });
      const next = [...foreign.map(strip), ...ours];
      const same = JSON.stringify(current.filter((g) => String(g.name || '').startsWith(MANAGED)).map(strip)) === JSON.stringify(ours);
      if (!same) await this.cpa.setProviderKeys(provider, next);
      // Learn each entry's auth_index so usage can be attributed.
      const after = same ? current : await this.cpa.getProviderKeys(provider);
      const setIdx = this.db.prepare('UPDATE accounts SET auth_index = ?, status = ? WHERE id = ?');
      for (const g of after) {
        const m = String(g.name || '').match(/^aipool-(\d+)$/);
        const idx = g.keys?.[0]?.auth_index;
        if (m && idx) setIdx.run(idx, 'active', Number(m[1]));
      }
    }
  }

  // ---------- OAuth subscription accounts ----------

  async syncOAuthAccounts() {
    const files = await this.cpa.listCredentials();
    const byIdx = new Map(
      this.db
        .prepare(`SELECT a.*, w.prefix AS ws_prefix FROM accounts a JOIN workspaces w ON w.id = a.workspace_id WHERE a.kind = 'oauth'`)
        .all()
        .map((a) => [a.auth_index, a]),
    );
    const update = this.db.prepare(`UPDATE accounts SET email = COALESCE(?, email), account_type = ?, status = ?, status_message = ?,
      disabled = ?, unavailable = ?, next_retry_after = ?, cpa_name = ?, quota_json = COALESCE(?, quota_json), quota_at = COALESCE(?, quota_at) WHERE id = ?`);
    const unclaimed = [];
    for (const f of files) {
      const idx = f.auth_index;
      if (!idx) continue;
      const a = byIdx.get(idx);
      if (!a || a.removed_at) {
        if (!a) unclaimed.push({ auth_index: idx, provider: f.provider || f.type, email: f.email || f.account || f.name, name: f.name });
        continue;
      }
      const signals = f.quota && f.quota.signals ? lowerKeys(f.quota.signals) : null;
      update.run(
        f.email || null,
        f.account_type || null,
        f.status || null,
        f.status_message || null,
        f.disabled ? 1 : 0,
        f.unavailable ? 1 : 0,
        f.next_retry_after ? String(f.next_retry_after) : null,
        f.name || null,
        signals ? JSON.stringify(signals) : null,
        signals ? Date.parse(f.quota.observed_at) || Date.now() : null,
        a.id,
      );
      await this.applyRouting(a, f);
    }
    this.unclaimed = unclaimed;
    return files;
  }

  // Writes prefix + priority into the credential file when they're missing or
  // the file was rewritten (e.g. re-login), which drops custom fields.
  async applyRouting(a, file) {
    const want = accountPrefix({ prefix: a.ws_prefix }, a);
    const modtime = String(file.modtime || file.updated_at || '');
    if (a.applied_prefix === want && a.applied_modtime === 'pending') {
      this.db.prepare('UPDATE accounts SET applied_modtime = ? WHERE id = ?').run(modtime, a.id);
      return;
    }
    if (a.applied_prefix === want && a.applied_modtime === modtime) return;
    await this.cpa.patchCredential(file.name, { prefix: want, priority: SUB_PRIORITY });
    this.db.prepare("UPDATE accounts SET applied_prefix = ?, applied_modtime = 'pending' WHERE id = ?").run(want, a.id);
  }

  async syncAll() {
    try {
      await this.syncOAuthAccounts();
      await this.syncApiKeyAccounts();
      await this.syncClientKeys();
      this.state.lastSyncAt = Date.now();
      this.state.lastSyncError = null;
    } catch (err) {
      this.state.lastSyncError = err.message;
    }
  }

  // ---------- connect flow ----------

  async oauthStart({ provider, workspaceId, userId, visibility }) {
    if (!['claude', 'codex'].includes(provider)) throw Object.assign(new Error('provider must be claude or codex'), { status: 400 });
    const files = await this.cpa.listCredentials();
    const before = new Map(files.map((f) => [f.auth_index, String(f.modtime || f.updated_at || '')]));
    const r = await this.cpa.startOAuth(provider);
    this.oauthSessions.set(r.state, { provider, workspaceId, userId, visibility: visibility === 'private' ? 'private' : 'shared', before, startedAt: Date.now() });
    return { url: r.url, state: r.state };
  }

  session(state, workspaceId, userId) {
    const s = this.oauthSessions.get(state);
    if (!s || s.workspaceId !== workspaceId || s.userId !== userId) throw Object.assign(new Error('unknown login session'), { status: 404 });
    return s;
  }

  async oauthCallback(state, workspaceId, userId, redirectUrl) {
    this.session(state, workspaceId, userId);
    return this.cpa.submitOAuthRedirect(redirectUrl);
  }

  async oauthStatus(state, workspaceId, userId) {
    const s = this.session(state, workspaceId, userId);
    const st = await this.cpa.oauthStatus(state);
    if (st.status !== 'ok') return st;
    this.oauthSessions.delete(state);
    const files = await this.cpa.listCredentials();
    const touched = files.filter((f) => f.auth_index && (!s.before.has(f.auth_index) || s.before.get(f.auth_index) !== String(f.modtime || f.updated_at || '')));
    const result = { status: 'ok', added: [], refreshed: [], conflicts: [] };
    for (const f of touched) {
      const existing = this.db.prepare('SELECT * FROM accounts WHERE auth_index = ?').get(f.auth_index);
      const info = { email: f.email || f.account || f.name, provider: f.provider || f.type };
      if (existing && !existing.removed_at && existing.workspace_id !== s.workspaceId) {
        result.conflicts.push(info);
        continue;
      }
      if (existing && !existing.removed_at) {
        result.refreshed.push(info);
        continue;
      }
      if (existing) {
        this.db
          .prepare(`UPDATE accounts SET workspace_id = ?, removed_at = NULL, visibility = ?, owner_user_id = ?, applied_prefix = NULL, applied_modtime = NULL, disabled = 0 WHERE id = ?`)
          .run(s.workspaceId, s.visibility, s.userId, existing.id);
      } else {
        this.db
          .prepare(`INSERT INTO accounts (workspace_id, kind, role, provider, email, account_type, auth_index, cpa_name, visibility, owner_user_id, plan, created_at)
                    VALUES (?, 'oauth', 'subscription', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(s.workspaceId, s.provider, info.email, f.account_type || null, f.auth_index, f.name, s.visibility, s.userId, guessPlan(s.provider, f.account_type), Date.now());
      }
      result.added.push(info);
    }
    await this.syncOAuthAccounts();
    return result;
  }

  // Assigns a credential that exists in the proxy but belongs to no workspace
  // (e.g. logged in from the CLI). Only offered on single-operator installs.
  async claim(authIndex, workspaceId, userId) {
    const f = (await this.cpa.listCredentials()).find((x) => x.auth_index === authIndex);
    if (!f) throw Object.assign(new Error('credential not found'), { status: 404 });
    const existing = this.db.prepare('SELECT * FROM accounts WHERE auth_index = ?').get(authIndex);
    if (existing && !existing.removed_at) throw Object.assign(new Error('already assigned'), { status: 409 });
    const provider = f.provider || f.type;
    if (existing) {
      this.db.prepare('UPDATE accounts SET workspace_id = ?, removed_at = NULL, owner_user_id = ?, visibility = ?, applied_prefix = NULL, applied_modtime = NULL WHERE id = ?').run(workspaceId, userId, 'shared', existing.id);
    } else {
      this.db
        .prepare(`INSERT INTO accounts (workspace_id, kind, role, provider, email, account_type, auth_index, cpa_name, visibility, owner_user_id, plan, created_at)
                  VALUES (?, 'oauth', 'subscription', ?, ?, ?, ?, ?, 'shared', ?, ?, ?)`)
        .run(workspaceId, provider, f.email || f.name, f.account_type || null, authIndex, f.name, userId, guessPlan(provider, f.account_type), Date.now());
    }
    await this.syncOAuthAccounts();
  }

  async addApiKeyAccount({ workspaceId, userId, provider, apiKey, label, role, visibility, baseUrl }) {
    if (!['claude', 'codex'].includes(provider)) throw Object.assign(new Error('provider must be claude or codex'), { status: 400 });
    if (!apiKey || apiKey.length < 10) throw Object.assign(new Error('API key looks invalid'), { status: 400 });
    const info = this.db
      .prepare(`INSERT INTO accounts (workspace_id, kind, role, provider, label, api_key_enc, api_key_hash, base_url, visibility, owner_user_id, plan, status, created_at)
                VALUES (?, 'apikey', ?, ?, ?, ?, ?, ?, ?, ?, 'pay-as-you-go', 'pending', ?)`)
      .run(workspaceId, role === 'subscription' ? 'subscription' : 'overflow', provider, label || `${provider} API key`, this.crypto.encrypt(apiKey), sha256(apiKey), baseUrl || null, visibility === 'private' ? 'private' : 'shared', userId, Date.now());
    await this.syncApiKeyAccounts();
    return Number(info.lastInsertRowid);
  }

  async removeAccount(account) {
    this.db.prepare('UPDATE accounts SET removed_at = ? WHERE id = ?').run(Date.now(), account.id);
    if (account.kind === 'apikey') await this.syncApiKeyAccounts();
    else if (account.cpa_name) await this.cpa.deleteCredential(account.cpa_name).catch(() => {});
  }

  async setAccountDisabled(account, disabled) {
    this.db.prepare('UPDATE accounts SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, account.id);
    if (account.kind === 'apikey') await this.syncApiKeyAccounts();
    else if (account.cpa_name) await this.cpa.setCredentialDisabled(account.cpa_name, disabled);
  }

  async updateAccountRouting(account) {
    this.db.prepare('UPDATE accounts SET applied_prefix = NULL WHERE id = ?').run(account.id);
    if (account.kind === 'apikey') await this.syncApiKeyAccounts();
    else await this.syncOAuthAccounts();
  }

  // ---------- usage ingestion ----------

  ingest(events) {
    const keys = new Map(this.db.prepare('SELECT id, workspace_id, user_id, cpa_key FROM api_keys').all().map((k) => [k.cpa_key, k]));
    const accounts = new Map(this.db.prepare('SELECT id, auth_index FROM accounts WHERE auth_index IS NOT NULL').all().map((a) => [a.auth_index, a.id]));
    const priceCache = new Map();
    const insert = this.db.prepare(`INSERT OR IGNORE INTO requests (execution_id, ts, workspace_id, key_id, user_id, account_id, provider, model, endpoint,
      uncached, cache_read, cache_write, output, reasoning, unclassified, latency_ms, failed, status_code, user_agent, cost, price_key, price_estimated)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const touchKey = this.db.prepare('UPDATE api_keys SET last_used_at = MAX(COALESCE(last_used_at, 0), ?) WHERE id = ?');
    const setQuota = this.db.prepare('UPDATE accounts SET quota_json = ?, quota_at = ? WHERE id = ? AND (quota_at IS NULL OR quota_at <= ?)');
    let n = 0;
    tx(this.db, () => {
      for (const ev of events) {
        if (!ev || typeof ev !== 'object' || !ev.timestamp) continue;
        const key = keys.get(ev.api_key);
        const ts = Date.parse(ev.timestamp) || Date.now();
        const wsId = key?.workspace_id ?? null;
        if (wsId != null && !priceCache.has(wsId)) priceCache.set(wsId, pricesFor(this.db, wsId));
        const prices = wsId != null ? priceCache.get(wsId) : DEFAULT_PRICES;
        const tok = tokensOf(ev);
        const { key: priceKey, price, estimated } = resolvePrice(ev.model, ev.provider, prices);
        const accountId = accounts.get(ev.auth_index) ?? null;
        const res = insert.run(
          ev.execution_id || ev.request_id || `${ts}-${Math.random()}`,
          ts,
          wsId,
          key?.id ?? null,
          key?.user_id ?? null,
          accountId,
          ev.provider || null,
          ev.model || null,
          ev.endpoint || null,
          tok.uncached,
          tok.cacheRead,
          tok.cacheWrite,
          tok.output,
          tok.reasoning,
          tok.unclassified,
          ev.latency_ms ?? null,
          ev.failed ? 1 : 0,
          ev.fail?.status_code ?? null,
          ev.user_agent || null,
          ev.failed ? 0 : costOf(tok, price),
          priceKey,
          estimated ? 1 : 0,
        );
        n += Number(res.changes);
        if (key) touchKey.run(ts, key.id);
        const q = accountId != null ? quotaFromHeaders(ev.response_headers) : null;
        if (q) setQuota.run(JSON.stringify(q), ts, accountId, ts);
      }
    });
    this.state.ingested += n;
    return n;
  }

  async poll() {
    try {
      for (let i = 0; i < 20; i++) {
        const batch = await this.cpa.popUsage(1000);
        if (!Array.isArray(batch) || batch.length === 0) break;
        this.ingest(batch);
        if (batch.length < 1000) break;
      }
      this.state.lastPollAt = Date.now();
      this.state.lastPollError = null;
    } catch (err) {
      this.state.lastPollError = err.message;
    }
  }

  recomputeCosts(workspaceId) {
    const prices = pricesFor(this.db, workspaceId);
    const rows = this.db.prepare('SELECT id, provider, model, uncached, cache_read, cache_write, output, unclassified, failed FROM requests WHERE workspace_id = ?').all(workspaceId);
    const upd = this.db.prepare('UPDATE requests SET cost = ?, price_key = ?, price_estimated = ? WHERE id = ?');
    tx(this.db, () => {
      for (const r of rows) {
        const { key, price, estimated } = resolvePrice(r.model, r.provider, prices);
        const tok = { uncached: r.uncached, cacheRead: r.cache_read, cacheWrite: r.cache_write, output: r.output, unclassified: r.unclassified };
        upd.run(r.failed ? 0 : costOf(tok, price), key, estimated ? 1 : 0, r.id);
      }
    });
  }

  start({ pollMs = 3000, syncMs = 30000 } = {}) {
    const loop = async (fn, ms) => {
      await fn();
      setTimeout(() => loop(fn, ms), ms).unref?.();
    };
    loop(() => this.poll(), pollMs);
    loop(() => this.syncAll(), syncMs);
    setInterval(() => {
      for (const [k, s] of this.oauthSessions) if (Date.now() - s.startedAt > 15 * 60000) this.oauthSessions.delete(k);
    }, 60000).unref();
  }
}

export function guessPlan(provider, accountType) {
  const p = String(provider || '').toLowerCase();
  const t = String(accountType || '').toLowerCase();
  if (p === 'codex') {
    if (t.includes('pro')) return 'chatgpt-pro';
    if (t.includes('plus')) return 'chatgpt-plus';
    if (t.includes('team') || t.includes('business') || t.includes('enterprise')) return 'chatgpt-business';
  }
  if (p === 'claude') {
    if (t.includes('max')) return 'claude-max-5x';
    if (t.includes('pro')) return 'claude-pro';
  }
  return null;
}
