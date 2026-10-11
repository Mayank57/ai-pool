#!/usr/bin/env bash
# Stops the processes started by scripts/start-local.sh.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
for name in app dashboard proxy; do
  pidfile="$ROOT/data/$name.pid"
  if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    kill "$(cat "$pidfile")" && echo "• Stopped $name"
  fi
  rm -f "$pidfile"
done
