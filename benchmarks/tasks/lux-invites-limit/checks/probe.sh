#!/usr/bin/env bash
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/ensure-lux.sh"
PROJECT="$PWD"
PASSWORD='Correct-Horse-9'
FAIL=0
pids=()
WINDOW=8
# The two instances run on high, unusual ports rather than the app's
# documented default (3000): the requirement under test is "two instances,
# different ports, same Lux", not any specific port number, and staying off
# 3000 avoids collisions with anything else already using the common one.
PORT_A=39001
PORT_B=39002
# Tag every instance this probe starts with this exact project's absolute
# path plus its port, so cleanup can never match another trial's process.
MARK_A="wbm-app:$PROJECT:$PORT_A"
MARK_B="wbm-app:$PROJECT:$PORT_B"
# Per-invocation scratch dir for logs and response bodies, so two concurrent
# trials never collide on a fixed /tmp path. Exported so seed.sh reuses it
# instead of making its own.
export LUX_PROBE_TMP="$(mktemp -d "${TMPDIR:-/tmp}/lux-probe-XXXXXX")"

log() { echo "[probe] $*"; }
fail() { echo "[FAIL] $*"; FAIL=1; }
cleanup() {
    for p in "${pids[@]:-}"; do kill -9 "$p" >/dev/null 2>&1 || true; done
    pkill -9 -f "$MARK_A" >/dev/null 2>&1 || true
    pkill -9 -f "$MARK_B" >/dev/null 2>&1 || true
    rm -rf "$LUX_PROBE_TMP"
}
trap cleanup EXIT

bash "$CHECKS_DIR/seed.sh" || { fail "seed.sh itself failed; not proceeding with stale/partial seed data"; exit 1; }
# The seeding instance runs on its own port (see checks/seed.sh) and is
# already gone by the time seed.sh returns, so these instances never have
# to race it for a port.
seed=$(cat "$LUX_PROBE_TMP/lux-bench-seed.json")
ACME=$(echo "$seed" | jq -r '.acme_id')
GLOBEX=$(echo "$seed" | jq -r '.globex_id')
OWNER_EMAIL=$(echo "$seed" | jq -r '.owner_email')
GLOBEX_OWNER_EMAIL=$(echo "$seed" | jq -r '.globex_owner_email')
LUX_URL=$(echo "$seed" | jq -r '.lux_url')
LUX_SECRET_KEY=$(echo "$seed" | jq -r '.lux_secret_key')
LUX_PUBLISHABLE_KEY=$(echo "$seed" | jq -r '.lux_publishable_key')
DIRECT_HOST=$(echo "$seed" | jq -r '.lux_direct_host')
DIRECT_PORT=$(echo "$seed" | jq -r '.lux_direct_port')
LUX_DIRECT_URL=$(echo "$seed" | jq -r '.lux_direct_url')

lux migrate run --host "$DIRECT_HOST" --port "$DIRECT_PORT" --password "$LUX_SECRET_KEY" || true

# The same variables `lux env export local` gave the app while it was being
# built. A limiter kept on the direct connection (INCR with a TTL) is a
# legitimate design and must not crash at boot for want of LUX_DIRECT_URL.
cat >apps/api/.env <<EOF
LUX_URL=$LUX_URL
LUX_SECRET_KEY=$LUX_SECRET_KEY
LUX_PUBLISHABLE_KEY=$LUX_PUBLISHABLE_KEY
LUX_DIRECT_URL=$LUX_DIRECT_URL
RATE_LIMIT_MAX_INVITES=5
RATE_LIMIT_WINDOW_SECONDS=$WINDOW
EOF

# `bun run <script-name>` forks a child to run the resolved command
# instead of exec'ing into it, so $! is not reliable here. Resolve the
# underlying command ourselves and exec it directly under a marker.
START_CMD=$(jq -r '.scripts.start' apps/api/package.json)
start_instance() {
    local port=$1 mark=$2
    (cd apps/api && PORT="$port" exec -a "$mark" $START_CMD) >>"$LUX_PROBE_TMP/api-$port.log" 2>&1 &
    sleep 0.3
}
wait_ready() {
    local port=$1
    for _ in $(seq 60); do curl -sf "http://127.0.0.1:$port/v1" >/dev/null 2>&1 && return 0; sleep 1; done
    return 1
}
kill_instances() {
    pkill -9 -f "$MARK_A" >/dev/null 2>&1 || true
    pkill -9 -f "$MARK_B" >/dev/null 2>&1 || true
}

start_instance "$PORT_A" "$MARK_A"
start_instance "$PORT_B" "$MARK_B"
wait_ready "$PORT_A" || { fail "instance on $PORT_A did not start"; cat "$LUX_PROBE_TMP/api-$PORT_A.log"; exit 1; }
wait_ready "$PORT_B" || { fail "instance on $PORT_B did not start"; cat "$LUX_PROBE_TMP/api-$PORT_B.log"; exit 1; }

login() {
    curl -sS -X POST "$LUX_URL/auth/v1/token?grant_type=password" -H "apikey: $LUX_PUBLISHABLE_KEY" \
        -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"$PASSWORD\"}" | jq -r .access_token
}
OWNER_TOKEN=$(login "$OWNER_EMAIL")
GLOBEX_TOKEN=$(login "$GLOBEX_OWNER_EMAIL")
[ -n "$OWNER_TOKEN" ] && [ "$OWNER_TOKEN" != null ] || { fail "owner login failed"; exit 1; }

invite_code() {
    local port=$1 team=$2 email=$3 token=$4
    curl -sS -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$port/v1/teams/$team/invites" \
        -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
        -d "{\"email\":\"$email\",\"role\":\"user\"}"
}

window_start=$(date +%s)
# Alternate every request between the two instances so the cap can only
# hold if the count is shared through Lux, not kept per-process.
ports=("$PORT_A" "$PORT_B" "$PORT_A" "$PORT_B" "$PORT_A")
ok=0
for i in 1 2 3 4 5; do
    port=${ports[$((i - 1))]}
    code=$(invite_code "$port" "$ACME" "limit-$i@acme.test" "$OWNER_TOKEN")
    [ "$code" -lt 300 ] && ok=$((ok + 1)) || fail "invite $i via port $port got http $code, expected success"
done
[ "$ok" = 5 ] || fail "only $ok/5 of the first invites succeeded"
log "alternating-instances: 5/5 invites across ports $PORT_A/$PORT_B succeeded"

sixth=$(invite_code "$PORT_B" "$ACME" 'limit-6@acme.test' "$OWNER_TOKEN")
[ "$sixth" -ge 400 ] && [ "$sixth" -lt 500 ] || fail "6th invite (alternating instance) got http $sixth, expected a 4xx"
log "6th-rejected: over the cap on the OTHER instance still rejected (http $sixth)"

# different team unaffected
gcode=$(invite_code "$PORT_A" "$GLOBEX" 'limit-1@globex.test' "$GLOBEX_TOKEN")
[ "$gcode" -lt 300 ] || fail "a different team's invite was rejected (http $gcode)"

# restart both instances; still rejected (state is not in process memory)
kill_instances
sleep 1
start_instance "$PORT_A" "$MARK_A"
start_instance "$PORT_B" "$MARK_B"
wait_ready "$PORT_A" || { fail "instance on $PORT_A did not restart"; exit 1; }
wait_ready "$PORT_B" || { fail "instance on $PORT_B did not restart"; exit 1; }
after_restart=$(invite_code "$PORT_A" "$ACME" 'limit-7@acme.test' "$OWNER_TOKEN")
[ "$after_restart" -ge 400 ] && [ "$after_restart" -lt 500 ] || fail "after restart, invite got http $after_restart, expected still-rejected 4xx"
log "still rejected after restart (http $after_restart)"

# Allowed again once the window has elapsed. Informational only: the probe can
# only shorten the window through RATE_LIMIT_WINDOW_SECONDS, and an
# implementation that hardcodes one hour is a legitimate reading of the
# request, so this cannot be a pass/fail signal without waiting an hour.
elapsed=$(( $(date +%s) - window_start ))
remaining=$(( WINDOW - elapsed + 2 ))
[ "$remaining" -gt 0 ] && sleep "$remaining"
after_window=$(invite_code "$PORT_B" "$ACME" 'limit-8@acme.test' "$OWNER_TOKEN")
if [ "$after_window" -lt 300 ]; then
    log "allowed again after the shortened window (http $after_window)"
else
    log "note: still rejected after the shortened window (http $after_window); the app may not read RATE_LIMIT_WINDOW_SECONDS, not scored"
fi

if [ "$FAIL" = 0 ]; then
    log PASS
    exit 0
else
    exit 1
fi
