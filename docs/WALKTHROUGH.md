# Walkthrough: be AI Pool's first user

This takes about 15 minutes on localhost. You'll play two people: **the admin**, who sets up the company, and **an employee**, who joins and starts working. Use your normal browser window for the admin and a **private/incognito window** for the employee, so the two logins don't mix.

Make sure it's running: `scripts/start-local.sh`, then open **http://localhost:8320**.

---

## Part 1: You are the admin (CEO)

### 1. Discover and sign up
1. Read the landing page and try the **Build your pool** calculator.
2. Click **Start free**. Enter your name, email, a password (8+ characters) and a workspace name (e.g. your company).
3. You land in your workspace on a **7-day trial** (banner at the top). The **Overview** shows a 5-step checklist.

### 2. Connect your plans (checklist step 1)
1. Click **Connect** (or go to **Plans → Connect Claude plan**).
2. Choose **Claude** and **Shared with the workspace**, then **Continue to sign-in**.
3. Click **Open Claude sign-in**, sign in with **claude-work**, and approve. The dialog finishes by itself, since this computer is running the pool.
4. Repeat for your second Claude account (**claude**). Right-click the sign-in button, choose **Open link in incognito window**, and sign in there, otherwise Claude signs you in as claude-work again.
5. **Connect ChatGPT plan**, sign in with your **Codex/ChatGPT** account.
6. In **Plans**, set each plan's **Type** (Pro, Max 5x, Max 20x, ChatGPT Plus/Pro). This drives the savings numbers.

> If a dialog ever shows a `localhost:54545` / `localhost:1455` page that won't load, copy that page's full address into the dialog's box and click **Submit**.

### 3. Create and test a key (step 2)
1. **Keys → Create key**. Name it (e.g. "My laptop"), scope **Person: you**, and leave the budget empty.
2. Copy the key. It's shown only once.
3. Click **Send test request**. A real request goes through your pool and you'll see a model reply "pong".

### 4. Point your tools at the pool (step 4)
In a terminal:
```bash
curl -fsSL http://localhost:8320/setup.sh | sh
```
Paste your key when asked and accept Claude Code and/or Codex. Then run `claude` (use `/logout` once if it was signed in to a personal account) or open a new terminal and run `codex`. Within seconds your requests appear under **Activity**, and the checklist ticks the step.

### 5. Look around as an admin
- **Capacity**: each plan's 5-hour and weekly usage and when it resets (fills in after the first requests).
- **Overview**: savings vs API prices, value multiple, and charts by key and person. Try the date ranges.
- **Keys → Create key** with scope **Client** and a **$5 budget** to see budget meters.
- **Settings**: seat cost, plan prices, model prices.
- **Billing**: what you'd pay after the trial; **Activate plan** (simulated, no card).

### 6. Invite an employee (step 3)
**Members → Invite people**, enter any email (e.g. `priya@yourco.test`), role **Member**, and click **Create invite link**. Copy the link.

---

## Part 2: You are the employee

Open a **private/incognito window** and paste the invite link.

1. You'll see "*You* invited you to *Workspace*". Create a login (any name, email, password). You land in the workspace as a **member**: the menu has no Members or Settings.
2. The Overview says **Welcome**, with three steps:
   - **Bring your own plan (optional).** If this employee already paid for Claude or ChatGPT, they'd connect it here as **Private**, used first for them and with the team pool as backup. (You can skip it; your accounts are already in the pool.)
   - **Create your key.** Keys → Create key. Members can only create personal keys, and budgets are set by admins.
   - **Run the setup script.** Same one-liner as above. To keep your own machine on your admin key, just click **Send test request** instead.
3. Check **Capacity** (shared plans only) and **Overview → Your usage**: members see only their own numbers.

## Part 3: Back as admin, see the result

In your normal window:
- **Members** shows the employee, their keys and usage.
- **Overview → People** attributes their usage to them.
- Try **Keys → Budget** on their key, or **Members → Remove**. Their key stops working immediately (send another test request from the employee window to see the 401).

---

### Things to know on localhost
- Billing is simulated. Nothing is charged, and "Activate" just flips the status.
- There's no email sending: invite links are shown for you to copy.
- Sign-ins for connected plans are stored by the routing engine in `proxy/auths/` on this machine.
- Reset everything: `scripts/stop-local.sh`, delete `data/aipool.db*` and the files in `proxy/auths/`, then start again.
