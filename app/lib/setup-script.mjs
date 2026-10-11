// The one-line installer served at /setup.sh:
//   curl -fsSL http://localhost:8320/setup.sh | sh
// It asks for the key interactively (never via URL), validates it, then
// configures Claude Code and/or Codex. Existing files are backed up first.
// Non-interactive use (CI/tests): AIPOOL_KEY=... AIPOOL_TOOLS="claude codex" sh setup.sh
export function setupScript(baseUrl) {
  const base = baseUrl.replace(/\/+$/, '');
  return `#!/bin/sh
# AI Pool setup: point Claude Code / Codex at your workspace.
set -eu
BASE="${base}"
STAMP=$(date +%Y%m%d%H%M%S)

say() { printf '%s\\n' "$*"; }
ask() { # ask "question" default -> echoes answer
  if [ -n "\${AIPOOL_TOOLS:-}" ]; then echo "$2"; return; fi
  printf '%s ' "$1" > /dev/tty; read -r a < /dev/tty || a=""; [ -z "$a" ] && a="$2"; echo "$a"
}

say ""
say "AI Pool setup  ($BASE)"
say "--------------------------------------------"

KEY="\${AIPOOL_KEY:-}"
if [ -z "$KEY" ]; then
  printf 'Paste your AI Pool key (starts with aip_): ' > /dev/tty
  stty -echo < /dev/tty 2>/dev/null || true
  read -r KEY < /dev/tty
  stty echo < /dev/tty 2>/dev/null || true
  printf '\\n' > /dev/tty
fi
case "$KEY" in aip_*) ;; *) say "That doesn't look like an AI Pool key."; exit 1 ;; esac

CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" "$BASE/v1/models" || echo 000)
if [ "$CODE" != "200" ]; then
  say "Key check failed (HTTP $CODE). Is the key correct and is $BASE reachable?"; exit 1
fi
say "✓ Key works"

TOOLS="\${AIPOOL_TOOLS:-}"
if [ -z "$TOOLS" ]; then
  command -v claude >/dev/null 2>&1 && [ "$(ask 'Configure Claude Code? [Y/n]' y)" != "n" ] && TOOLS="$TOOLS claude"
  command -v codex  >/dev/null 2>&1 && [ "$(ask 'Configure Codex CLI? [Y/n]' y)" != "n" ] && TOOLS="$TOOLS codex"
  if [ -z "$TOOLS" ]; then
    [ "$(ask 'Neither claude nor codex found on PATH. Configure Claude Code anyway? [y/N]' n)" = "y" ] && TOOLS="claude"
  fi
fi

JSONTOOL=""
command -v node >/dev/null 2>&1 && JSONTOOL=node
[ -z "$JSONTOOL" ] && command -v python3 >/dev/null 2>&1 && JSONTOOL=python3

for t in $TOOLS; do
  case "$t" in
  claude)
    F="$HOME/.claude/settings.json"; mkdir -p "$HOME/.claude"
    [ -f "$F" ] && cp "$F" "$F.bak.$STAMP"
    if [ "$JSONTOOL" = node ]; then
      AIPOOL_F="$F" AIPOOL_B="$BASE" AIPOOL_K="$KEY" node -e '
        const fs=require("fs"),f=process.env.AIPOOL_F;let j={};
        try{j=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}
        j.env=Object.assign({},j.env,{ANTHROPIC_BASE_URL:process.env.AIPOOL_B,ANTHROPIC_AUTH_TOKEN:process.env.AIPOOL_K});
        delete j.env.ANTHROPIC_API_KEY;
        fs.writeFileSync(f,JSON.stringify(j,null,2)+"\\n")'
    elif [ "$JSONTOOL" = python3 ]; then
      AIPOOL_F="$F" AIPOOL_B="$BASE" AIPOOL_K="$KEY" python3 -c '
import json,os
f=os.environ["AIPOOL_F"]
try: j=json.load(open(f))
except Exception: j={}
e=dict(j.get("env") or {}); e.update(ANTHROPIC_BASE_URL=os.environ["AIPOOL_B"], ANTHROPIC_AUTH_TOKEN=os.environ["AIPOOL_K"]); e.pop("ANTHROPIC_API_KEY",None)
j["env"]=e; open(f,"w").write(json.dumps(j,indent=2)+"\\n")'
    else
      say "Need node or python3 to edit $F. Add this manually:"
      say "  \\"env\\": {\\"ANTHROPIC_BASE_URL\\": \\"$BASE\\", \\"ANTHROPIC_AUTH_TOKEN\\": \\"$KEY\\"}"
      continue
    fi
    say "✓ Claude Code configured ($F)"
    say "  If Claude Code was signed in to a personal account, run /logout inside it once."
    ;;
  codex)
    F="$HOME/.codex/config.toml"; mkdir -p "$HOME/.codex"; touch "$F"
    cp "$F" "$F.bak.$STAMP"
    # Drop any previous AI Pool block and model_provider line, then add ours.
    awk 'BEGIN{skip=0}
         /^\\[model_providers\\.aipool\\]/{skip=1;next}
         /^\\[/{skip=0}
         skip==1{next}
         /^model_provider[ \\t]*=/{next}
         {print}' "$F.bak.$STAMP" > "$F.tmp"
    { printf 'model_provider = "aipool"\\n'; cat "$F.tmp"; printf '\\n[model_providers.aipool]\\nname = "AI Pool"\\nbase_url = "%s/v1"\\nenv_key = "AIPOOL_API_KEY"\\nwire_api = "responses"\\n' "$BASE"; } > "$F"
    rm -f "$F.tmp"
    RC="$HOME/.bashrc"; case "\${SHELL:-}" in */zsh) RC="$HOME/.zshrc";; esac
    touch "$RC"; grep -v '^export AIPOOL_API_KEY=' "$RC" > "$RC.tmp.$STAMP" || true
    printf 'export AIPOOL_API_KEY="%s"\\n' "$KEY" >> "$RC.tmp.$STAMP"; cat "$RC.tmp.$STAMP" > "$RC"; rm -f "$RC.tmp.$STAMP"
    say "✓ Codex configured ($F) and AIPOOL_API_KEY added to $RC"
    say "  Open a new terminal (or run: source $RC) before starting codex."
    ;;
  esac
done

say ""
say "Done. Every request now goes through your AI Pool workspace."
say "Usage shows up in $BASE/app within a few seconds."
`;
}
