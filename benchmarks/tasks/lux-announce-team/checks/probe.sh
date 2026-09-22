#!/usr/bin/env bash
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/ensure-lux.sh"
PROJECT="$PWD"
API=http://127.0.0.1:3000
PASSWORD='Correct-Horse-9'
FAIL=0
pids=()
API_MARK="wbm-app:$PROJECT:api"
# Per-invocation scratch dir for logs and response bodies, so two concurrent
# trials never collide on a fixed /tmp path. Exported so seed.sh reuses it
# instead of making its own.
export LUX_PROBE_TMP="$(mktemp -d "${TMPDIR:-/tmp}/lux-probe-XXXXXX")"

log() { echo "[probe] $*"; }
fail() { echo "[FAIL] $*"; FAIL=1; }
cleanup() {
    for p in "${pids[@]:-}"; do kill -9 "$p" >/dev/null 2>&1 || true; done
    pkill -9 -f "$API_MARK" >/dev/null 2>&1 || true
    rm -rf "$LUX_PROBE_TMP"
}
trap cleanup EXIT

bash "$CHECKS_DIR/seed.sh" || { fail "seed.sh itself failed; not proceeding with stale/partial seed data"; exit 1; }
# The seeding instance runs on its own port (see checks/seed.sh) and is
# already gone by the time seed.sh returns, so the submission's own
# instance on :3000 never has to race it.
seed=$(cat "$LUX_PROBE_TMP/lux-bench-seed.json")
ACME=$(echo "$seed" | jq -r '.acme_id')
GLOBEX=$(echo "$seed" | jq -r '.globex_id')
OWNER_EMAIL=$(echo "$seed" | jq -r '.owner_email')
MEMBER_EMAIL=$(echo "$seed" | jq -r '.member_email')
OUTSIDER_EMAIL=$(echo "$seed" | jq -r '.outsider_email')
LUX_URL=$(echo "$seed" | jq -r '.lux_url')
LUX_SECRET_KEY=$(echo "$seed" | jq -r '.lux_secret_key')
LUX_PUBLISHABLE_KEY=$(echo "$seed" | jq -r '.lux_publishable_key')
DIRECT_HOST=$(echo "$seed" | jq -r '.lux_direct_host')
DIRECT_PORT=$(echo "$seed" | jq -r '.lux_direct_port')
LUX_DIRECT_URL=$(echo "$seed" | jq -r '.lux_direct_url')

lux migrate run --host "$DIRECT_HOST" --port "$DIRECT_PORT" --password "$LUX_SECRET_KEY" || true

# The same variables `lux env export local` gave the app while it was being
# built; a submission may legitimately use any of them.
cat >apps/api/.env <<EOF
LUX_URL=$LUX_URL
LUX_SECRET_KEY=$LUX_SECRET_KEY
LUX_PUBLISHABLE_KEY=$LUX_PUBLISHABLE_KEY
LUX_DIRECT_URL=$LUX_DIRECT_URL
EOF

START_CMD=$(jq -r '.scripts.start' apps/api/package.json)
(cd apps/api && PORT=3000 exec -a "$API_MARK" $START_CMD) >>"$LUX_PROBE_TMP/api.log" 2>&1 &
pids+=("$!")
for _ in $(seq 60); do curl -sf "$API/v1" >/dev/null 2>&1 && break; sleep 1; done
curl -sf "$API/v1" >/dev/null || { fail "app did not start"; cat "$LUX_PROBE_TMP/api.log"; exit 1; }

login() {
    curl -sS -X POST "$LUX_URL/auth/v1/token?grant_type=password" -H "apikey: $LUX_PUBLISHABLE_KEY" \
        -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"$PASSWORD\"}"
}
OWNER=$(login "$OWNER_EMAIL")
OWNER_TOKEN=$(echo "$OWNER" | jq -r .access_token)
MEMBER=$(login "$MEMBER_EMAIL")
MEMBER_TOKEN=$(echo "$MEMBER" | jq -r .access_token)
OUTSIDER=$(login "$OUTSIDER_EMAIL")
OUTSIDER_TOKEN=$(echo "$OUTSIDER" | jq -r .access_token)
for v in OWNER_TOKEN MEMBER_TOKEN OUTSIDER_TOKEN; do
    [ -n "${!v}" ] && [ "${!v}" != null ] || { fail "login failed for $v"; exit 1; }
done

code_of() { curl -sS -o "$LUX_PROBE_TMP/resp.json" -w '%{http_code}' "$@"; }

# The request never named an announcement's fields, so every write sends a
# superset of plausible names. A non-strict validator keeps the ones it knows.
ann_json() { printf '{"title":"%s","body":"%s","content":"%s","text":"%s","message":"%s"}' "$1" "$2" "$2" "$2" "$2"; }

# member-posts + teammate-reads
post_code=$(code_of -X POST "$API/v1/teams/$ACME/announcements" -H "Authorization: Bearer $MEMBER_TOKEN" \
    -H 'Content-Type: application/json' -d "$(ann_json 'Standup moved' '9am now')")
[ "$post_code" -lt 300 ] || { fail "member could not post (http $post_code)"; cat "$LUX_PROBE_TMP/resp.json"; }
ANN_ID=$(jq -r '.data.id' "$LUX_PROBE_TMP/resp.json")
[ -n "$ANN_ID" ] && [ "$ANN_ID" != null ] || fail "no announcement id returned"

read_code=$(code_of "$API/v1/teams/$ACME/announcements" -H "Authorization: Bearer $OWNER_TOKEN")
[ "$read_code" -lt 300 ] || fail "owner could not read announcements (http $read_code)"
echo "$(jq -c . "$LUX_PROBE_TMP/resp.json")" | jq -e --arg id "$ANN_ID" '[.data[] | select(.id == $id)] | length == 1' >/dev/null \
    || { fail "teammate did not see the new announcement (looking for $ANN_ID)"; head -c 1500 "$LUX_PROBE_TMP/resp.json"; echo; }

# outsider-cannot-post / outsider-cannot-read (API)
oc=$(code_of -X POST "$API/v1/teams/$ACME/announcements" -H "Authorization: Bearer $OUTSIDER_TOKEN" \
    -H 'Content-Type: application/json' -d "$(ann_json 'x' 'y')")
[ "$oc" -ge 400 ] || fail "outsider was able to post to Acme (http $oc)"
oc2=$(code_of "$API/v1/teams/$ACME/announcements" -H "Authorization: Bearer $OUTSIDER_TOKEN")
[ "$oc2" -ge 400 ] || fail "outsider was able to read Acme announcements via API (http $oc2)"

# Direct Lux reads with a user's own session and the publishable key. The
# owner (a member) must see the announcement this way first: that proves
# the request shape and the read grant work, so an empty or error response
# for the outsider below is a real block, not a broken request.
DIRECT_READ="$LUX_URL/tables/announcements?where=team_id%20%3D%20%27$ACME%27"
direct_rows() { jq 'if (.result | type) == "array" then (.result | length) else "error" end' 2>/dev/null || echo error; }
owner_direct=$(curl -sS "$DIRECT_READ" -H "apikey: $LUX_PUBLISHABLE_KEY" -H "Authorization: Bearer $OWNER_TOKEN")
on=$(echo "$owner_direct" | direct_rows)
if ! echo "$owner_direct" | grep -q "$ANN_ID"; then
    fail "member could not read Acme announcements directly with their own session ($on rows)"
    head -c 800 <<<"$owner_direct"; echo
fi

# outsider-cannot-read (direct Lux, own session, publishable key)
direct=$(curl -sS "$DIRECT_READ" -H "apikey: $LUX_PUBLISHABLE_KEY" -H "Authorization: Bearer $OUTSIDER_TOKEN")
n=$(echo "$direct" | direct_rows)
if [ "$n" != 0 ] && [ "$n" != '"error"' ] || echo "$direct" | grep -q "$ANN_ID"; then
    fail "outsider read $n Acme announcements directly with their own session"
fi

# live-teammate: subscribe as owner via Lux's own .live(), then post as member.
# Run from inside the submitted project so it resolves the project's own
# installed @luxdb/sdk (this script directory has no node_modules of its own).
cp "$CHECKS_DIR/live-wait.ts" apps/api/.live-wait-probe.ts
(cd apps/api && bun .live-wait-probe.ts "$LUX_URL" "$LUX_PUBLISHABLE_KEY" "$OWNER_TOKEN" "$ACME" 8000) >"$LUX_PROBE_TMP/live.out" 2>"$LUX_PROBE_TMP/live.err" &
live_pid=$!
pids+=("$live_pid")
sleep 1.5
code_of -X POST "$API/v1/teams/$ACME/announcements" -H "Authorization: Bearer $MEMBER_TOKEN" \
    -H 'Content-Type: application/json' -d "$(ann_json 'Live test' 'should push')" >/dev/null
wait "$live_pid" 2>/dev/null
rm -f apps/api/.live-wait-probe.ts
if grep -q '"ok":true' "$LUX_PROBE_TMP/live.out" && grep -q '"event":"insert"' "$LUX_PROBE_TMP/live.out"; then
    log "live-teammate ok"
else
    fail "teammate's live subscription never saw the insert"
    cat "$LUX_PROBE_TMP/live.out" "$LUX_PROBE_TMP/live.err"
fi

# author-edits
ec=$(code_of -X PUT "$API/v1/teams/$ACME/announcements/$ANN_ID" -H "Authorization: Bearer $MEMBER_TOKEN" \
    -H 'Content-Type: application/json' -d "$(ann_json 'Standup moved again' '10am now')")
[ "$ec" -lt 300 ] || fail "author could not edit their announcement (http $ec)"

# non-author-blocked (API)
nc=$(code_of -X PUT "$API/v1/teams/$ACME/announcements/$ANN_ID" -H "Authorization: Bearer $OWNER_TOKEN" \
    -H 'Content-Type: application/json' -d "$(ann_json 'hijacked' 'hijacked')")
[ "$nc" -ge 400 ] || fail "non-author was able to edit via the API (http $nc)"

# non-author-blocked (direct Lux write with the non-author's own session).
# Write to a text column the announcement actually has, so a rejected write
# means the grant blocked it rather than an unknown column.
TEXT_COL=$(curl -sS "$API/v1/teams/$ACME/announcements" -H "Authorization: Bearer $OWNER_TOKEN" \
    | jq -r --arg id "$ANN_ID" '[.data[] | select(.id == $id)][0] | keys[]' 2>/dev/null \
    | grep -m1 -E '^(body|content|text|message|title)$' || echo body)
where=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(\"id = '$ANN_ID'\"))" 2>/dev/null)
direct_write=$(curl -sS -X PATCH "$LUX_URL/tables/announcements?where=$where" \
    -H "apikey: $LUX_PUBLISHABLE_KEY" -H "Authorization: Bearer $OWNER_TOKEN" \
    -H 'Content-Type: application/json' -d "{\"$TEXT_COL\":\"hijacked directly\"}")
dn=$(echo "$direct_write" | direct_rows)
if [ "$dn" != 0 ] && [ "$dn" != '"error"' ] || echo "$direct_write" | grep -q 'hijacked directly'; then
    fail "non-author updated the announcement directly with their own session ($dn rows)"
fi
# And confirm through the API that the row really was not changed.
after_direct=$(curl -sS "$API/v1/teams/$ACME/announcements" -H "Authorization: Bearer $OWNER_TOKEN")
echo "$after_direct" | grep -q 'hijacked directly' && fail "non-author's direct write changed the announcement"

# author-deletes
dc=$(code_of -X DELETE "$API/v1/teams/$ACME/announcements/$ANN_ID" -H "Authorization: Bearer $MEMBER_TOKEN")
[ "$dc" -lt 300 ] || fail "author could not delete their announcement (http $dc)"

if [ "$FAIL" = 0 ]; then
    log PASS
    exit 0
else
    # Evidence for reading the fail: the app's own log, so a 500 can be
    # traced to the submission's exception rather than guessed at.
    echo "--- api.log (last 60 lines) ---"
    tail -n 60 "$LUX_PROBE_TMP/api.log" 2>/dev/null
    exit 1
fi
