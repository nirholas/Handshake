#!/usr/bin/env bash
# Keep the Vite dev server alive on a pinned port despite other workspace
# sessions issuing broad `pkill -f vite`. Whenever the server exits, restart it.
set -u
PORT="${1:-3007}"
cd "$(dirname "$0")/.."
while true; do
  echo "[keepalive] starting dev server on :$PORT ($(date '+%H:%M:%S'))"
  npm run dev -- --port "$PORT" --strictPort
  code=$?
  echo "[keepalive] dev exited (code $code); restarting in 2s"
  sleep 2
done
