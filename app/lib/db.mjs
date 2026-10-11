import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY,
  email      TEXT UNIQUE NOT NULL COLLATE NOCASE,
  name       TEXT NOT NULL,
  pw_hash    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id                    INTEGER PRIMARY KEY,
  name                  TEXT NOT NULL,
  prefix                TEXT UNIQUE NOT NULL,      -- routing prefix inside CLIProxyAPI
  created_by            INTEGER NOT NULL,
  created_at            INTEGER NOT NULL,
  trial_ends_at         INTEGER NOT NULL,
  billing_status        TEXT NOT NULL DEFAULT 'trialing', -- trialing | active | canceled
  activated_at          INTEGER,
  seat_baseline_monthly REAL NOT NULL DEFAULT 120
);

CREATE TABLE IF NOT EXISTS memberships (
  workspace_id INTEGER NOT NULL,
  user_id      INTEGER NOT NULL,
  role         TEXT NOT NULL,                      -- owner | admin | member
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS invites (
  id           INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL,
  email        TEXT,
  role         TEXT NOT NULL DEFAULT 'member',
  token_hash   TEXT UNIQUE NOT NULL,
  created_by   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  accepted_by  INTEGER,
  accepted_at  INTEGER,
  revoked      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS api_keys (
  id           INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL,
  name         TEXT NOT NULL,
  scope_type   TEXT NOT NULL DEFAULT 'person',     -- person | team | project | client
  user_id      INTEGER,                            -- the person this key belongs to (person scope)
  created_by   INTEGER NOT NULL,
  key_hash     TEXT UNIQUE NOT NULL,
  key_hint     TEXT NOT NULL,
  cpa_key      TEXT UNIQUE NOT NULL,               -- internal key used towards CLIProxyAPI
  budget_usd   REAL,                               -- monthly API-equivalent budget
  budget_tokens INTEGER,                           -- monthly token budget
  created_at   INTEGER NOT NULL,
  revoked_at   INTEGER,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_keys_ws ON api_keys(workspace_id);

CREATE TABLE IF NOT EXISTS accounts (
  id               INTEGER PRIMARY KEY,
  workspace_id     INTEGER NOT NULL,
  kind             TEXT NOT NULL,                  -- oauth | apikey
  role             TEXT NOT NULL DEFAULT 'subscription', -- subscription | overflow
  provider         TEXT NOT NULL,                  -- claude | codex
  email            TEXT,
  label            TEXT,
  account_type     TEXT,
  auth_index       TEXT UNIQUE,
  cpa_name         TEXT,                           -- credential file name (oauth) or config entry name (apikey)
  api_key_enc      TEXT,                           -- encrypted upstream API key (apikey kind)
  api_key_hash     TEXT,
  base_url         TEXT,
  visibility       TEXT NOT NULL DEFAULT 'shared', -- shared | private
  owner_user_id    INTEGER,
  plan             TEXT,
  monthly_cost     REAL,
  applied_prefix   TEXT,
  applied_modtime  TEXT,
  status           TEXT,
  status_message   TEXT,
  disabled         INTEGER NOT NULL DEFAULT 0,
  unavailable      INTEGER NOT NULL DEFAULT 0,
  next_retry_after TEXT,
  quota_json       TEXT,
  quota_at         INTEGER,
  created_at       INTEGER NOT NULL,
  removed_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_accounts_ws ON accounts(workspace_id);

CREATE TABLE IF NOT EXISTS requests (
  id              INTEGER PRIMARY KEY,
  execution_id    TEXT UNIQUE,
  ts              INTEGER NOT NULL,
  workspace_id    INTEGER,
  key_id          INTEGER,
  user_id         INTEGER,
  account_id      INTEGER,
  provider        TEXT,
  model           TEXT,
  endpoint        TEXT,
  uncached        INTEGER DEFAULT 0,
  cache_read      INTEGER DEFAULT 0,
  cache_write     INTEGER DEFAULT 0,
  output          INTEGER DEFAULT 0,
  reasoning       INTEGER DEFAULT 0,
  unclassified    INTEGER DEFAULT 0,
  latency_ms      INTEGER,
  failed          INTEGER DEFAULT 0,
  status_code     INTEGER,
  user_agent      TEXT,
  cost            REAL DEFAULT 0,
  price_key       TEXT,
  price_estimated INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_req_ws_ts ON requests(workspace_id, ts);
CREATE INDEX IF NOT EXISTS idx_req_key_ts ON requests(key_id, ts);
CREATE INDEX IF NOT EXISTS idx_req_user_ts ON requests(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_req_acc_ts ON requests(account_id, ts);

CREATE TABLE IF NOT EXISTS settings (
  scope TEXT NOT NULL,                             -- 'global' or 'ws:<id>'
  key   TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (scope, key)
);
`;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Additive schema changes for databases created by earlier versions.
function migrate(db) {
  const cols = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  if (!cols('users').has('pw_version')) db.exec('ALTER TABLE users ADD COLUMN pw_version INTEGER NOT NULL DEFAULT 0');
}

export function getSetting(db, scope, key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE scope = ? AND key = ?').get(scope, key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

export function setSetting(db, scope, key, value) {
  db.prepare(
    'INSERT INTO settings (scope, key, value) VALUES (?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value',
  ).run(scope, key, JSON.stringify(value));
}

// Runs fn inside a transaction. Nested calls join the outer transaction via savepoints.
const depth = new WeakMap();
export function tx(db, fn) {
  const d = depth.get(db) || 0;
  depth.set(db, d + 1);
  const name = `sp${d}`;
  db.exec(d === 0 ? 'BEGIN' : `SAVEPOINT ${name}`);
  try {
    const out = fn();
    db.exec(d === 0 ? 'COMMIT' : `RELEASE ${name}`);
    return out;
  } catch (err) {
    db.exec(d === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`);
    throw err;
  } finally {
    depth.set(db, d);
  }
}
