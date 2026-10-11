import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PRICES, resolvePrice, costOf } from '../lib/pricing.mjs';
import { tokensOf, quotaFromHeaders, accountPrefix, guessPlan } from '../lib/pool.mjs';
import { windowsFromQuota, accountMonthly } from '../lib/reports.mjs';
import { providerForModel } from '../lib/gateway.mjs';
import { hashPassword, verifyPassword, hashPasswordSync, makeSigner, makeCrypto, randomToken } from '../lib/security.mjs';
import { openDb, tx } from '../lib/db.mjs';
import { Limiter } from '../lib/limits.mjs';

test('price resolution: longest prefix, suffixes, provider fallback', () => {
  assert.equal(resolvePrice('claude-opus-5-5', 'claude', DEFAULT_PRICES).key, 'claude-opus-5-5');
  assert.equal(resolvePrice('claude-opus-5', 'claude', DEFAULT_PRICES).key, 'claude-opus-5');
  assert.equal(resolvePrice('claude-opus-4-5-20251101', 'claude', DEFAULT_PRICES).key, 'claude-opus-4-5');
  assert.equal(resolvePrice('claude-opus-5-5(high)', 'claude', DEFAULT_PRICES).key, 'claude-opus-5-5');
  assert.equal(resolvePrice('gpt-5.6-terra', 'codex', DEFAULT_PRICES).key, 'gpt-5.6-terra');
  const fb = resolvePrice('gpt-9', 'codex', DEFAULT_PRICES);
  assert.equal(fb.key, 'gpt-5.5');
  assert.equal(fb.estimated, true);
});

test('token breakdown and cost', () => {
  const ev = { token_breakdown: { input: { uncached_tokens: 1000, cache_read_tokens: 4000, cache_write_tokens: 2000 }, output: { total_tokens: 500 }, unclassified_tokens: 0 } };
  const t = tokensOf(ev);
  const want = (1000 * 4 + 4000 * 0.2 + 2000 * 5 + 500 * 20) / 1e6;
  assert.ok(Math.abs(costOf(t, DEFAULT_PRICES['claude-opus-5-5']) - want) < 1e-12);
  // Legacy shape: cached tokens are a subset of input and must not be double counted.
  const legacy = tokensOf({ tokens: { input_tokens: 1000, cached_tokens: 800, output_tokens: 10 } });
  assert.equal(legacy.uncached, 200);
  assert.equal(legacy.cacheRead, 800);
});

test('quota headers -> capacity windows (Claude and Codex)', () => {
  const now = Date.now();
  const q = quotaFromHeaders({
    'Anthropic-Ratelimit-Unified-5h-Utilization': ['0.42'],
    'Anthropic-Ratelimit-Unified-5h-Reset': [String(Math.floor(now / 1000) + 3600)],
    'Anthropic-Ratelimit-Unified-7d-Utilization': ['0.1'],
    'Content-Type': ['application/json'],
  });
  assert.deepEqual(Object.keys(q).sort(), ['anthropic-ratelimit-unified-5h-reset', 'anthropic-ratelimit-unified-5h-utilization', 'anthropic-ratelimit-unified-7d-utilization']);
  const w = windowsFromQuota('claude', q, now);
  assert.equal(w[0].label, '5-hour');
  assert.equal(w[0].used, 0.42);
  assert.ok(w[0].resets_at > now);
  const cw = windowsFromQuota('codex', { 'x-codex-primary-used-percent': '23', 'x-codex-primary-window-minutes': '300', 'x-codex-primary-reset-after-seconds': '60', 'x-codex-secondary-used-percent': '41', 'x-codex-secondary-window-minutes': '10080' }, now);
  assert.equal(cw[0].label, '5-hour');
  assert.equal(cw[0].used, 0.23);
  assert.equal(cw[0].resets_at, now + 60000);
  assert.equal(cw[1].label, 'Weekly');
  assert.equal(quotaFromHeaders({ 'Content-Type': 'x' }), null);
});

test('routing prefixes and helpers', () => {
  assert.equal(accountPrefix({ prefix: 'wsabc' }, { visibility: 'shared', owner_user_id: 3 }), 'wsabc');
  assert.equal(accountPrefix({ prefix: 'wsabc' }, { visibility: 'private', owner_user_id: 3 }), 'wsabc-u3');
  assert.equal(providerForModel('claude-sonnet-5-5'), 'claude');
  assert.equal(providerForModel('gpt-6-sol'), 'codex');
  assert.equal(providerForModel('o3-mini'), 'codex');
  assert.equal(providerForModel('gemini-3'), null);
  assert.equal(guessPlan('codex', 'chatgpt-pro'), 'chatgpt-pro');
  assert.equal(guessPlan('claude', 'claude_max'), 'claude-max-5x');
  const plans = { 'claude-max-20x': { monthly: 200 } };
  assert.equal(accountMonthly({ kind: 'oauth', role: 'subscription', plan: 'claude-max-20x' }, plans), 200);
  assert.equal(accountMonthly({ kind: 'oauth', role: 'subscription', plan: 'claude-max-20x', monthly_cost: 150 }, plans), 150);
  assert.equal(accountMonthly({ kind: 'apikey', role: 'overflow' }, plans), 0);
});

test('passwords, signed sessions and encryption', async () => {
  const h = await hashPassword('correct horse');
  assert.ok(await verifyPassword('correct horse', h));
  assert.ok(!(await verifyPassword('wrong', h)));
  assert.ok(await verifyPassword('sync', hashPasswordSync('sync')));
  assert.equal(await verifyPassword('x', 'garbage'), false);
  const s = makeSigner('secret');
  const tok = s.sign({ uid: 7, exp: Date.now() + 1000 });
  assert.equal(s.verify(tok).uid, 7);
  assert.equal(s.verify(tok.slice(0, -2) + 'xx'), null);
  assert.equal(s.verify(s.sign({ uid: 7, exp: Date.now() - 1 })), null);
  assert.equal(makeSigner('other').verify(tok), null);
  const c = makeCrypto('k');
  const blob = c.encrypt('sk-ant-123');
  assert.notEqual(blob, 'sk-ant-123');
  assert.equal(c.decrypt(blob), 'sk-ant-123');
  assert.throws(() => makeCrypto('other').decrypt(blob));
  assert.match(randomToken(40), /^[A-Za-z0-9]{40}$/);
});

test('nested transactions roll back as a unit', () => {
  const db = openDb(':memory:');
  db.exec('CREATE TABLE t (v INTEGER)');
  assert.throws(() =>
    tx(db, () => {
      db.prepare('INSERT INTO t VALUES (1)').run();
      tx(db, () => db.prepare('INSERT INTO t VALUES (2)').run());
      throw new Error('boom');
    }),
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM t').get().n, 0);
  tx(db, () => {
    db.prepare('INSERT INTO t VALUES (1)').run();
    assert.throws(() => tx(db, () => { db.prepare('INSERT INTO t VALUES (2)').run(); throw new Error('inner'); }));
  });
  assert.deepEqual(db.prepare('SELECT v FROM t').all().map((r) => r.v), [1]);
});

test('limiter counts attempts per window and prunes', () => {
  const l = new Limiter();
  for (let i = 0; i < 3; i++) assert.equal(l.hit('k', 3, 1000), true);
  assert.equal(l.hit('k', 3, 1000), false);
  assert.equal(l.allowed('k', 3, 1000), false);
  l.reset('k');
  assert.equal(l.allowed('k', 3, 1000), true);
  l.buckets.set('old', { since: Date.now() - 5000, count: 9, windowMs: 1000 });
  l.prune();
  assert.equal(l.buckets.has('old'), false);
  clearInterval(l.timer);
});

// Two sign-ins for the same provider finishing together must never claim each other's file.
import { Pool } from '../lib/pool.mjs';

function poolHarness() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO users (id, email, name, pw_hash, created_at) VALUES (1,'a@x','A','h',0),(2,'b@x','B','h',0)").run();
  db.prepare("INSERT INTO workspaces (id, name, prefix, created_by, created_at, trial_ends_at) VALUES (1,'W1','wsaaa',1,0,9e15),(2,'W2','wsbbb',2,0,9e15)").run();
  let files = [];
  let n = 0;
  const cpa = {
    listCredentials: async () => files.map((f) => ({ ...f })),
    startOAuth: async () => ({ url: 'https://example.test/login', state: 'st' + ++n }),
    oauthStatus: async () => ({ status: 'ok' }),
    patchCredential: async () => ({}),
    deleteCredential: async () => ({}),
  };
  const pool = new Pool({ db, cpa, crypto: { encrypt: (x) => x, decrypt: (x) => x } });
  const file = (idx, email, modtime) => ({ auth_index: idx, name: `claude-${email}.json`, provider: 'claude', email, modtime });
  const owner = (idx) => db.prepare('SELECT workspace_id FROM accounts WHERE auth_index = ? AND removed_at IS NULL').get(idx)?.workspace_id ?? null;
  return { db, pool, setFiles: (f) => (files = f), file, owner };
}

test('colliding OAuth completions refuse both sides, then each reconnect claims only its own file', async () => {
  const { pool, setFiles, file, owner } = poolHarness();
  const a = await pool.oauthStart({ provider: 'claude', workspaceId: 1, userId: 1, visibility: 'shared' });
  const b = await pool.oauthStart({ provider: 'claude', workspaceId: 2, userId: 2, visibility: 'shared' });
  setFiles([file('X', 'alice@x', '2026-10-11T10:00:00Z'), file('Y', 'bob@x', '2026-10-11T10:00:01Z')]);
  const ra = await pool.oauthStatus(a.state, 1, 1);
  assert.equal(ra.ambiguous, true);
  const rb = await pool.oauthStatus(b.state, 2, 2);
  assert.equal(rb.ambiguous, true, 'second completer must not win both files');
  assert.equal(owner('X'), null);
  assert.equal(owner('Y'), null);
  // Reconnects: each login rewrites only its own file.
  await new Promise((r) => setTimeout(r, 5));
  const a2 = await pool.oauthStart({ provider: 'claude', workspaceId: 1, userId: 1, visibility: 'shared' });
  setFiles([file('X', 'alice@x', '2026-10-11T10:05:00Z'), file('Y', 'bob@x', '2026-10-11T10:00:01Z')]);
  const ra2 = await pool.oauthStatus(a2.state, 1, 1);
  assert.deepEqual(ra2.added.map((x) => x.email), ['alice@x']);
  const b2 = await pool.oauthStart({ provider: 'claude', workspaceId: 2, userId: 2, visibility: 'shared' });
  setFiles([file('X', 'alice@x', '2026-10-11T10:05:00Z'), file('Y', 'bob@x', '2026-10-11T10:06:00Z')]);
  const rb2 = await pool.oauthStatus(b2.state, 2, 2);
  assert.deepEqual(rb2.added.map((x) => x.email), ['bob@x']);
  assert.equal(owner('X'), 1);
  assert.equal(owner('Y'), 2);
});

test('a lone completion claims its file; re-login to a plan owned elsewhere is a conflict, not a move', async () => {
  const { pool, setFiles, file, owner } = poolHarness();
  const a = await pool.oauthStart({ provider: 'claude', workspaceId: 1, userId: 1, visibility: 'private' });
  setFiles([file('X', 'alice@x', '2026-10-11T10:00:00Z')]);
  const ra = await pool.oauthStatus(a.state, 1, 1);
  assert.deepEqual(ra.added.map((x) => x.email), ['alice@x']);
  assert.equal(owner('X'), 1);
  const b = await pool.oauthStart({ provider: 'claude', workspaceId: 2, userId: 2, visibility: 'shared' });
  setFiles([file('X', 'alice@x', '2026-10-11T10:09:00Z')]);
  const rb = await pool.oauthStatus(b.state, 2, 2);
  assert.deepEqual(rb.conflicts.map((x) => x.email), ['alice@x']);
  assert.equal(rb.added.length, 0);
  assert.equal(owner('X'), 1, 'plan stays with its workspace');
  // A stale session or a session from another user is rejected outright.
  await assert.rejects(() => pool.oauthStatus(b.state, 1, 1), /unknown login session/);
});
