#!/usr/bin/env bash
# Runs the routing engine (CLIProxyAPI) + AI Pool on this computer (macOS / Linux).
# Logs: data/proxy.log, data/app.log, proxy/auths/logs/.  Stop with scripts/stop-local.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
[[ -f .env && -f proxy/config.yaml ]] || { echo "Run scripts/setup.sh first." >&2; exit 1; }

BIN="$ROOT/CLIProxyAPI/cli-proxy-api"
if [[ ! -x "$BIN" ]]; then
  if [[ ! -d "$ROOT/CLIProxyAPI" ]]; then
    echo "• Cloning CLIProxyAPI…"
    git clone --depth 1 https://github.com/router-for-me/CLIProxyAPI.git "$ROOT/CLIProxyAPI"
  fi
  command -v go >/dev/null || { echo "Go 1.26+ is required to build CLIProxyAPI (brew install go), or use Docker mode." >&2; exit 1; }
  echo "• Building CLIProxyAPI…"
  (cd "$ROOT/CLIProxyAPI" && go build -o cli-proxy-api ./cmd/server)
fi

command -v node >/dev/null || { echo "Node.js 22.13+ is required (brew install node)." >&2; exit 1; }

mkdir -p data
is_running() { [[ -f "$1" ]] && kill -0 "$(cat "$1")" 2>/dev/null; }

if is_running data/proxy.pid; then
  echo "• Proxy already running (pid $(cat data/proxy.pid))"
else
  if lsof -nP -iTCP:8317 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port 8317 is already in use by another process. Stop it first (lsof -iTCP:8317)." >&2
    exit 1
  fi
  # The proxy resolves relative paths (logs, plugins) from its working directory.
  cd "$ROOT/proxy"
  nohup "$BIN" --config "$ROOT/proxy/config.yaml" >"$ROOT/data/proxy.log" 2>&1 &
  echo $! >"$ROOT/data/proxy.pid"
  cd "$ROOT"
  echo "• Started proxy (pid $(cat data/proxy.pid))"
fi

for _ in $(seq 1 40); do
  curl -sS -o /dev/null http://127.0.0.1:8317/ 2>/dev/null && break
  sleep 0.25
done
is_running data/proxy.pid || { echo "Proxy failed to start; see data/proxy.log" >&2; exit 1; }

if is_running data/app.pid; then
  echo "• AI Pool already running (pid $(cat data/app.pid))"
else
  nohup node app/server.mjs >data/app.log 2>&1 &
  echo $! >data/app.pid
  echo "• Started AI Pool (pid $(cat data/app.pid))"
fi

set -a; source .env; set +a
echo
echo "AI Pool:  ${APP_PUBLIC_URL:-http://localhost:8320}"
