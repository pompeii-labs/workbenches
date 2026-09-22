#!/usr/bin/env bash
set -euo pipefail

node server.js &
pid=$!
trap 'kill "$pid" 2>/dev/null || true' EXIT

ready=0
for _ in $(seq 1 20); do
    if curl -fsS http://127.0.0.1:3000/health >/tmp/example-hello-health 2>/dev/null; then
        ready=1
        break
    fi
    sleep 0.5
done

[ "$ready" = "1" ]
grep -qx 'ok' /tmp/example-hello-health
