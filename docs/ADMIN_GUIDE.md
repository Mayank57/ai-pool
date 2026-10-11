# Admin guide

For the person setting AI Pool up for a company (CEO, CTO, IT). Trying it on your own machine first? Start with [WALKTHROUGH.md](WALKTHROUGH.md).

## 0. Before you start

- **Check the provider terms** for the plans you'll connect ([HOW_IT_WORKS.md](HOW_IT_WORKS.md#provider-terms)). Consumer plans (Claude Pro/Max, ChatGPT Plus/Pro) are licensed to one person. The lowest-risk setup is **private** mode: each person connects their own company-paid plan and only they use it, while AI Pool gives you keys, budgets and reporting. Use shared mode for plans whose terms allow it, and API keys as overflow.
- **List your plans**: provider, plan type, monthly price, and whose it is.
- **Pick a seat baseline**: what you'd otherwise pay per active person per month (default $120 = Claude Max 5x + ChatGPT Plus).

## 1. Install

| Where | Command | Endpoint people use |
|---|---|---|
| This computer | `scripts/setup.sh && scripts/start-local.sh` | `http://localhost:8320` |
| A server (Docker) | `scripts/setup.sh --mode docker --url https://ai.acme.com` then `docker compose -f deploy/docker-compose.yml --env-file .env up -d` | `https://ai.acme.com` |

For a server, point DNS at it, add `APP_DOMAIN=ai.acme.com` and `TRUST_PROXY=true` to `.env`, set `APP_PUBLISH=127.0.0.1:8320` so the raw port isn't public, and add `--profile caddy` to the compose command for automatic HTTPS. Only ports 80/443 need to be public. The routing engine is never exposed.

Generated files (keep them private): `.env` (secrets), `proxy/config.yaml`, `proxy/auths/` (plan sign-ins, **most sensitive**), and `data/aipool.db` or the `app-data` volume.

## 2. Create your workspace

Open the site, click **Start free**, and sign up. Signing up creates your workspace with you as **owner** and starts the 7-day trial. The Overview shows a checklist; each step below matches one item.

## 3. Connect plans

**Plans → Connect Claude plan / Connect ChatGPT plan**

1. Choose **Shared** (whole workspace) or **Private** (only the owner, with the team pool as backup).
2. Click **Open … sign-in**, sign in with the plan's account, and approve.
3. Browser on the same machine as AI Pool: it completes on its own. Otherwise the browser lands on a `localhost:54545` (Claude) or `localhost:1455` (OpenAI) page that won't load. Copy its full address into the dialog and click **Submit**.
4. For a second account at the same provider, open the sign-in link in a private window.
5. Set each plan's **Type** (or a custom $/mo). Plans without a type count as $0, and the Overview warns you.
6. Optional: **Add overflow API key** (Anthropic or OpenAI). It's used only when every plan is at its limit, and the provider bills it per token.

## 4. Create keys

**Keys → Create key**

- **Scope**: *person* (usage attributed to them), or *team*, *project* or *client* for shared budgets and chargeback.
- **Budgets**: monthly dollars (API-equivalent) and/or tokens. When a key hits its budget it gets `429 budget_exceeded` until the 1st of next month or until you raise it.
- The key is shown **once**. Click **Send test request** to make a real call.

## 5. Invite your team

**Members → Invite people**: an optional email (pre-fills their sign-up) and a role.

| Role | Can |
|---|---|
| Owner | Everything, including billing |
| Admin | Everything except billing |
| Member | Create personal keys, connect their own plans (private or shared), see shared plans, capacity and their own usage |

Send the link privately. Links are single-use and expire after 14 days. Send employees [EMPLOYEE_GUIDE.md](EMPLOYEE_GUIDE.md).

## 6. Activate billing

**Billing → Activate plan** before the trial ends ($20 per connected plan per month; **simulated**, no payment). If you don't, keys return `402` after the trial, and nothing else is affected.

## 7. Read the numbers

| Number | Meaning |
|---|---|
| Saved vs paying API prices | Value delivered by subscription plans (at API list prices) − what those plans cost for the period |
| Value multiple | Plan value ÷ plan cost. Above 1× means the plans beat paying per token |
| Saved vs a seat each | Active people × seat baseline − plan cost |
| Capacity | Each plan's 5-hour and weekly usage and reset time; "% unused, resets in …" warns when weekly capacity is about to expire unused |
| Insights | Concrete recommendations: downgrade an underused plan (with the saving), upgrade or add capacity for a saturated one, replace heavy overflow spend with a plan, chase idle members, revoke never-used keys |
| Collecting data | A new workspace shows this instead of savings until it has a day of traffic and 20 requests, so early numbers don't mislead |

Model prices marked **verify** (Settings) came from secondary sources. Check them against the provider's pricing page; saving re-prices history.

## 8. Day-to-day

| Task | Where |
|---|---|
| Offboard someone | Members → Remove: keys revoked and their plans leave the pool. History is kept |
| Hand over the workspace | Settings → Ownership & deletion → Transfer (owner only); you stay as admin |
| Close the workspace | Settings → Ownership & deletion → Delete: disconnects every plan, revokes every key, erases history |
| Your own login | Account (bottom of the sidebar): change name or password, sign out everywhere, leave workspaces, delete account |
| Leaked key | Keys → Revoke, then create a new one |
| Plan misbehaving | Plans → Pause / Remove |
| Back up | `data/aipool.db` and `proxy/auths/` (encrypt: they hold live sign-ins) |
| Update the routing engine | `cd CLIProxyAPI && git pull && go build -o cli-proxy-api ./cmd/server`, then restart (Docker: `docker compose pull`) |
| Logs | `data/app.log`, `data/proxy.log`, `proxy/auths/logs/` |

## Troubleshooting

| Symptom | Fix |
|---|---|
| `401` | Wrong or revoked key |
| `402` | Trial ended or workspace canceled: Billing → Activate |
| `429 budget_exceeded` | Key budget used up: Keys → Budget |
| `429` from the provider / plans "Cooling down" | Every plan for that model is at its limit. Add plans or an overflow key |
| `unknown provider for model …` | No plan in this workspace offers that model |
| Connect dialog: "already connected to another workspace" | That account is in another workspace on this server; remove it there first |
| Settings → System shows an error | The routing engine is down or `MANAGEMENT_KEY` doesn't match: check `data/proxy.log` |
