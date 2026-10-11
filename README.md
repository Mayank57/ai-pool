# AI Pool

Pool your team's Claude and ChatGPT plans behind one endpoint. Everyone gets a personal key. Requests are spread across the plans, fail over when one hits its limit, and every request is valued at API prices, so you can see what the plans are worth.

**Concept demo (no install, runs in your browser):** https://mayank57.github.io/ai-pool/

Multi-workspace (any company can sign up), runs on localhost or your own server, and needs no npm dependencies. The routing engine is [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), unmodified.

```
 Members' tools                          AI Pool (:8320)                           Routing engine          Providers
 ─────────────                           ───────────────                           ──────────────          ─────────
 Claude Code ─┐                    ┌───────────────────────────┐   prefix model   ┌──────────────┐   ┌─ Claude Pro/Max
 Codex CLI   ─┼─ aip_ key ────────▶│ /v1 gateway               │──"wsX/claude…"──▶│ CLIProxyAPI  │──▶┤
 Cursor, SDK ─┘                    │  auth · trial · budgets   │                  │  (:8317,     │   └─ ChatGPT Plus/Pro/Business
                                   │  private→shared fallback  │◀── usage events ─│  localhost)  │
 Admin / member ── browser ───────▶│ website + workspace app   │── mgmt API ─────▶│              │
                                   │ SQLite: users, keys, usage│                  └──────────────┘
                                   └───────────────────────────┘
```

## Run it (localhost)

```bash
scripts/setup.sh          # once: secrets in .env + routing config in proxy/
scripts/start-local.sh    # builds CLIProxyAPI if needed, starts everything
open http://localhost:8320
```

Stop with `scripts/stop-local.sh`. Requirements: Node.js 22.13+, and Go 1.26+ to build CLIProxyAPI the first time.

**First time?** Follow **[docs/WALKTHROUGH.md](docs/WALKTHROUGH.md)**. It walks you through the product as an admin and then as an employee, in about 15 minutes.

## What's in it

| | |
|---|---|
| **Website** | Landing page with a pool-cost calculator, pricing, docs |
| **Sign-up & workspaces** | Email + password; each sign-up creates a workspace with a 7-day trial; one login can belong to many workspaces |
| **Plans** | Connect Claude / ChatGPT plans by signing in from the browser. **Shared** (whole team) or **private** (only the owner, team pool as backup). Optional **overflow API keys** used only when every plan is at its limit |
| **Keys** | Scoped to a person, team, project or client; monthly $ and token budgets; shown once; instant revoke |
| **Members** | Invite links (single-use, 14 days), roles owner / admin / member, offboarding revokes keys and removes their plans |
| **Capacity** | 5-hour and weekly usage per plan with reset countdowns, read from provider responses |
| **Savings** | API-equivalent value vs prorated subscription cost, value multiple, savings vs a seat per person, by key / person / model |
| **Insights** | Rule-based recommendations: underused plans (downgrade and save $X/mo), saturated plans (upgrade or add capacity), overflow spend that should be a plan, idle members, never-used keys |
| **Account** | Change name and password (signs out other devices), sign out everywhere, leave or transfer or delete a workspace, delete account |
| **Setup script** | `curl -fsSL http://localhost:8320/setup.sh \| sh` configures Claude Code and Codex |
| **Billing** | $20 per connected plan per month after the trial. **Simulated**: no payments |

## Tests

```bash
cd app
npm test            # unit tests
npm run test:e2e    # starts a real CLIProxyAPI + mock Anthropic/OpenAI upstream and runs 17 end-to-end scenarios
```

The end-to-end suite (24 scenarios) covers sign-up, invites bound to an email, permissions, routing for Claude and Codex, streaming, workspace isolation, private plans with fallback and privacy, budgets, billing gates, revocation, offboarding, leave/transfer/delete, password change, login throttling, gateway route allow-list, security headers, capacity data, and the setup script. `node site/test/demo-flow.mjs` drives the public demo through the admin and employee journey in headless Chrome; CI runs it before every deploy.

## Security model (short version)

- Each workspace's plans carry a routing prefix inside the engine; the gateway adds it, clients can't choose it, and unprefixed requests reach nothing. Private plans serve only their owner.
- The gateway exposes only chat/completions/responses/messages/models; the engine's realtime, media and search routes are not reachable.
- Passwords: scrypt. Sessions: signed, HttpOnly, versioned (password change signs out other devices). Keys: stored hashed, shown once. Upstream API keys: AES-256-GCM.
- Login limits per account and per IP, signup/invite/OAuth limits, caps on keys/plans/invites/workspaces, CSP and other security headers, JSON-only + same-origin checks on every mutation.
- Details and the terms-of-service discussion: [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md).

## Docs

- [docs/WALKTHROUGH.md](docs/WALKTHROUGH.md): try the full admin and employee journey on localhost
- [docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md): everything an admin/CEO does, and running it on a server
- [docs/EMPLOYEE_GUIDE.md](docs/EMPLOYEE_GUIDE.md): what employees do
- [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md): architecture, isolation, savings math, security, **provider terms**

## Public demo site

`site/` builds a static version of the product for GitHub Pages: the same frontend as `app/public`, with an in-browser simulated backend (`site/demo/demo-api.js`). Visitors can sign up, connect simulated plans, create and test keys, invite themselves as an employee, and explore a sample workspace with 30 days of data. Everything is stored in their own browser. `.github/workflows/pages.yml` builds and deploys it on every push to `main`.

```bash
node site/build.mjs   # outputs site/dist
```

## Layout

```
app/                AI Pool (Node, zero dependencies)
  server.mjs        routes: website, /api, /v1 gateway, /setup.sh
  lib/              db, security, pool (proxy sync + usage), gateway, reports, pricing, setup script
  public/           landing, pricing, docs, auth, app (vanilla JS)
  test/             unit tests, e2e suite, mock upstream
deploy/             docker-compose.yml, Caddyfile
scripts/            setup.sh, start-local.sh, stop-local.sh
docs/               guides
site/               static concept demo for GitHub Pages (build.mjs + in-browser backend)
CLIProxyAPI/        routing engine (git clone, unmodified)
proxy/, data/, .env generated config, credentials, database (gitignored, secret)
```
