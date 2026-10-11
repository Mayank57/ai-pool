# How it works

## Provider terms

AI Pool makes sharing subscriptions technically easy. Whether you may do it is a separate question:

- **Claude Pro/Max** and **ChatGPT Plus/Pro** are individual plans. Consumer terms generally prohibit letting other people use your account. Pooling one person's plan for a team risks rate-limit enforcement or suspension.
- Providers have also restricted using subscription sign-ins from third-party tools. Check current Anthropic and OpenAI terms before relying on it.
- **Business plans** and **API keys** are the sanctioned routes for company-wide access.

AI Pool is built so the safe pattern is the easy one. **Private** plans serve only their owner, with keys, budgets and reporting on top. **Overflow API keys** add sanctioned pay-per-token capacity. You're responsible for how you use it. This isn't legal advice.

## Components

| | |
|---|---|
| **AI Pool app** (`app/`, port 8320) | Website, sign-up, workspace app, the `/v1` gateway, `/setup.sh`. SQLite database. |
| **Routing engine** (CLIProxyAPI, port 8317, localhost only) | Holds plan sign-ins, translates and forwards requests to Anthropic/OpenAI, load-balances, cools down rate-limited plans, emits a usage event per request. Unmodified upstream project. |

The app manages the engine only through its v8 management API:

| App action | Engine API |
|---|---|
| Startup | `PATCH /config`: `force-model-prefix: true`, usage events on, 1h retention |
| Key created/revoked | `PUT /config/access/api-keys`: one hidden internal key per AI Pool key |
| Plan connected | `GET /oauth/auth-url`, `/oauth/status`, `POST /oauth/callback`, then `PATCH /credentials/fields` sets `prefix` + `priority` |
| Overflow / private API key | `PUT /config/api-keys/{claude,codex}` (entries named `aipool-<id>`) |
| Pause / remove plan | `PATCH /credentials/status`, `DELETE /credentials` |
| Usage (every 3s) | `GET /observability/usage/queue` (events are popped; AI Pool must be the only consumer) |
| Plan status + quota (every 30s) | `GET /credentials` |

## Workspace isolation

Every plan in the engine carries a **routing prefix**:

| Plan | Prefix | Who can reach it |
|---|---|---|
| Shared plan in workspace W | `ws<random>` | anyone with a key in W |
| Private plan of user U in W | `ws<random>-u<U>` | only U's keys in W |

With `routing.force-model-prefix: true`, a request for `wsabc/claude-sonnet-5-5` can only be served by plans whose prefix is `wsabc`, and unprefixed requests reach nothing. Clients never choose the prefix:

1. The gateway authenticates the `aip_…` key (stored as a SHA-256 hash).
2. It checks the workspace's billing state and the key's monthly budget.
3. It rejects model names containing `/`, then rewrites `model` to `<prefix>/<model>`. If the key's owner has a private plan for that provider, it tries the private prefix first and falls back to the shared prefix on 429/503 or "no plan for this model".
4. It forwards to the engine with the key's internal engine key and streams the response back. There are no timeouts after connection.
5. `/v1/models` is filtered to the workspace's prefixes and returned without them, in OpenAI or Anthropic format.

The e2e suite checks that requests from one workspace never reach another workspace's plans, and that private plans serve only their owner.

## Usage, savings and capacity

Each usage event carries the internal engine key (which identifies the AI Pool key, its workspace and person), the plan's `auth_index`, the model, a canonical token breakdown, latency and status. The app stores one row per request:

```
value  = (uncached × input + cache_read × cache_read_price + cache_write × cache_write_price + output × output) / 1e6
plan_cost(period) = Σ plan monthly price × days / 30.4375          (API-key accounts: $0, billed per token)
saved_vs_api      = value served by plans − plan_cost
value_multiple    = value served by plans ÷ plan_cost
saved_vs_seats    = active people × seat baseline × days / 30.4375 − plan_cost
```

Failed requests are valued at $0. Prices match the longest model-name prefix; unknown models use a provider default and are flagged as estimated. Workspaces can override prices, and saving re-prices history. Subscription cost is prorated per plan for the days it was connected inside the period, so plans added or removed mid-period are counted fairly.

**Insights** are rules over the same data: a plan connected for 7+ days returning under half its price is "underused" (with the next tier down and the monthly saving); a plan at ≥85% of its weekly or ≥90% of its 5-hour window, or with 3+ provider rate-limit errors, is "near its limit" (with the next tier up); overflow spend above 60% of the cheapest plan "could be a subscription"; members idle for the whole period and keys never used after a week are flagged; a value multiple of 1.5× or more is called out as working well.

**Capacity** comes from provider response headers that each request carries back: `anthropic-ratelimit-unified-{5h,7d}-{utilization,reset}` for Claude, `x-codex-{primary,secondary}-{used-percent,window-minutes,reset-after-seconds}` for Codex. The engine also exposes them per plan. Data appears after the first request through a plan.

## Security

| Data | Stored | Protection |
|---|---|---|
| Passwords | `users.pw_hash` | scrypt with per-user salt |
| Sessions | cookie | HMAC-signed, HttpOnly, SameSite=Lax, 30 days, `Secure` over HTTPS |
| AI Pool keys | `api_keys.key_hash` | SHA-256; plaintext shown once |
| Upstream API keys | `accounts.api_key_enc` | AES-256-GCM with a key derived from `APP_SECRET` |
| Plan sign-ins (OAuth tokens) | `proxy/auths/*.json` | Stored by the engine as files: protect the directory and backups |
| Invite tokens | `invites.token_hash` | SHA-256, single-use, 14-day expiry |

Other protections:
- **Gateway allow-list:** only `/v1/messages`, `/v1/messages/count_tokens`, `/v1/chat/completions`, `/v1/completions`, `/v1/responses`, `/v1/responses/compact` and `/v1/models` are forwarded. The engine's realtime, image, video, audio and search routes are never reachable through AI Pool.
- **CSRF:** state-changing API calls must be JSON and same-origin (`Sec-Fetch-Site`), so cross-site forms can't send them.
- **Abuse limits:** login is limited per account (10 failures / 15 min) and per IP (100 / 15 min); signups 10 per IP per hour; invite lookups 60 per IP per hour; plan sign-ins 20 per user per hour. Caps: 500 keys and 200 plans per workspace, 200 pending invites, 20 workspaces per user.
- **Sessions:** HMAC-signed, HttpOnly, SameSite=Lax, and versioned. Changing your password or choosing "Sign out everywhere" invalidates every other session.
- **Headers:** `Content-Security-Policy` (`script-src 'self'`, no inline scripts), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, HSTS over HTTPS.
- **Privacy between members:** members see shared plans and their own; other members' private plans are hidden and shared plans' account emails are masked. Members' activity shows only their own requests.
- **Invites:** single-use, expire in 14 days, and when created for an email address they can only be accepted by that address.
- **Roles:** checked on every workspace route. Billing, ownership transfer and deletion are owner-only.
- **Management access:** the engine's management API is localhost-only and its key never leaves the server.
- **Reverse proxies:** set `TRUST_PROXY=true` when AI Pool sits behind Caddy/nginx so rate limits see real client IPs; leave it unset otherwise so `X-Forwarded-For` can't be spoofed.
- **Retention:** per-request usage rows are deleted after `REQUEST_RETENTION_DAYS` (default 400).

**Limits of this build:** billing is simulated, there's no email delivery (invite links are copied manually), there's no password *reset* (changing a known password works), and budgets are enforced within a few seconds of usage, so a burst can overshoot slightly.
