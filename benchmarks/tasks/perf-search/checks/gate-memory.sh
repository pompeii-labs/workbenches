#!/usr/bin/env bash
# Memory gate: the submission's server must not balloon its resident memory
# while serving a burst of searches at 10x scale.
#
# Method: seed at 10x scale, start the submission's server as a plain `bun`
# process on the host, then fire BURST_REQUESTS concurrent searches (cycling
# through the everything/broad/rare/no-match terms, no limit/page params,
# each capped at 30s) while a background loop samples the server's RSS with
# `ps -o rss= -p <pid>` (KB, same on Linux and macOS) every 200ms. The peak
# sample must stay under RSS_BUDGET_KB. A server that materializes every
# matching row per request blows far past the budget. One that returns a
# bounded page stays flat.
set -euo pipefail
source "$CHECKS_DIR/lib.sh"

RSS_BUDGET_KB="${RSS_BUDGET_KB:-400000}"
BURST_REQUESTS="${BURST_REQUESTS:-32}"
PORT_N="${SERVER_PORT:-3000}"
SAMPLES_FILE="$(mktemp)"
POLL_PID=""
trap '[ -n "$POLL_PID" ] && kill "$POLL_PID" 2>/dev/null; stop_server; compose_down; rm -f "$SAMPLES_FILE"' EXIT

compose_up >/dev/null
install_deps >/dev/null
bun run migrate >/dev/null
seed_10x
start_server "$PORT_N"

sleep 0.5
IDLE_RSS=$(rss_kb "$SERVER_PID")
echo "idle RSS: ${IDLE_RSS}KB"
echo "$IDLE_RSS" > "$SAMPLES_FILE"

(
    while kill -0 "$SERVER_PID" 2>/dev/null; do
        rss_kb "$SERVER_PID" >> "$SAMPLES_FILE" || true
        sleep 0.2
    done
) &
POLL_PID=$!

declare -a TERMS=("ordinary" "Product%20123" "Product%204999" "zzz-nonexistent-term")
PIDS=()
for i in $(seq 1 "$BURST_REQUESTS"); do
    term="${TERMS[$(( i % 4 ))]}"
    curl -s -o /dev/null --max-time 30 "http://localhost:${PORT_N}/search?q=${term}" &
    PIDS+=("$!")
done
for pid in "${PIDS[@]}"; do
    wait "$pid" || true
done

sleep 0.5
kill "$POLL_PID" >/dev/null 2>&1 || true
wait "$POLL_PID" 2>/dev/null || true
POLL_PID=""

if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "FAIL: server died during the burst"
    exit 1
fi

PEAK_RSS=$(grep -E '^[0-9]+$' "$SAMPLES_FILE" | sort -n | tail -1)
SAMPLE_COUNT=$(grep -cE '^[0-9]+$' "$SAMPLES_FILE")
stop_server
compose_down

echo "peak RSS over ${SAMPLE_COUNT} samples during a burst of ${BURST_REQUESTS} requests: ${PEAK_RSS}KB (budget ${RSS_BUDGET_KB}KB)"
if [ "$PEAK_RSS" -gt "$RSS_BUDGET_KB" ]; then
    echo "FAIL: peak RSS ${PEAK_RSS}KB is over the ${RSS_BUDGET_KB}KB budget"
    exit 1
fi
echo "PASS: peak RSS ${PEAK_RSS}KB stayed under the ${RSS_BUDGET_KB}KB budget"
