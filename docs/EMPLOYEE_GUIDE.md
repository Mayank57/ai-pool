# Employee guide

Your company uses AI Pool to share Claude and ChatGPT plans. You get a personal key that works in Claude Code, Codex and other tools. Setup takes about 5 minutes.

## 1. Join

Open the invite link your admin sent (`…/invite/…`). Create your AI Pool login, or log in if you have one, and you're in the workspace.

## 2. Already pay for Claude or ChatGPT? (optional)

On **Overview** or **Plans**, click **Connect Claude plan** or **Connect ChatGPT plan** and sign in.

- **Private**: only you use it. Your requests go to your plan first and fall back to the team pool when it's at its limit.
- **Shared**: the whole team can use it.

You can change this later on the Plans page, or remove the plan. Removing it doesn't cancel your subscription.

## 3. Create your key

**Keys → Create key**. Copy it right away; it's shown only once. **Send test request** checks that it works.

## 4. Set up your tools

```bash
curl -fsSL <AI Pool URL>/setup.sh | sh
```

Paste your key when asked. The script checks the key, backs up your current config, and configures **Claude Code** and/or **Codex**.

- Claude Code: if it was signed in to a personal account, run `/logout` inside it once.
- Codex: open a new terminal before running `codex`.
- Other tools (Cursor, Cline, OpenCode, SDKs): **Connect your tools** in the app has the base URLs.

## Your account

**Account** (bottom of the sidebar) lets you change your name or password, sign out of every other device, leave a workspace, or delete your login. Changing your password signs out your other devices.

## FAQ

**What can my admin see?** Time, model, token counts, which key and plan, and latency for each request. Prompt and response text aren't stored. The routing engine keeps the last few failed requests on the server for debugging. Other members never see your private plans or your activity.

**`401`?** Your key was revoked or mistyped. Create a new one.
**`429 budget_exceeded`?** Your key's monthly budget is used up. Ask an admin.
**`402`?** The workspace trial ended. Ask the owner to activate it.
**Lost your key?** Revoke it under Keys and create a new one, then re-run the setup script.
