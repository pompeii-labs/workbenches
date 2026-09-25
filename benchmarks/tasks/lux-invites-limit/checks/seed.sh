#!/usr/bin/env bash
# Brings up a local Lux engine with the baseline schema and two real teams
# (Acme and Globex), each with its own owner admin. Used both as the task's
# `setup` and again by ./checks/probe.sh to rebuild the same starting point
# in a fresh grading daemon.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/ensure-lux.sh"
cd "$(dirname "${BASH_SOURCE[0]}")/baseline"
# Per-invocation scratch dir: reuse the caller's (probe.sh sets
# LUX_PROBE_TMP and cleans it up itself) or make our own when run standalone
# (as the task's `setup`), in which case nothing outside this run needs it
# to survive, so we remove it on exit.
OWN_PROBE_TMP=0
if [ -z "${LUX_PROBE_TMP:-}" ]; then
    LUX_PROBE_TMP="$(mktemp -d "${TMPDIR:-/tmp}/lux-probe-XXXXXX")"
    OWN_PROBE_TMP=1
fi
OUT="$LUX_PROBE_TMP/lux-bench-seed.json"
PASSWORD='Correct-Horse-9'

lux start --no-studio
# `lux start` also drops its own .env.local here, which bun auto-loads
# from the api's cwd on top of (and possibly instead of) the .env file
# written below. Remove it so the values below are the only source.
rm -f .env.local apps/api/.env.local
# Immediately after `lux start` returns, a same-second `lux env export`
# can occasionally race the engine's own auth setup and report WRONGPASS;
# retry briefly rather than fail on that transient.
for _ in $(seq 5); do
    ENV_OUT=$(lux env export local 2>&1) && break
    sleep 1
done
echo "$ENV_OUT" | grep -q '^LUX_URL=' || { echo "lux env export local failed:" >&2; echo "$ENV_OUT" >&2; exit 1; }
eval "$(echo "$ENV_OUT" | sed 's/^export //; s/^/export /')"

bun install --silent
cat >apps/api/.env <<EOF
LUX_URL=$LUX_URL
LUX_SECRET_KEY=$LUX_SECRET_KEY
EOF
# Tag with this exact baseline directory's absolute path so cleanup can
# never touch a process started by a different trial, and wait for the
# port to actually clear (not just send the signal) before returning, so
# the caller never races this process's own shutdown.
BASELINE_MARK="wbm-seed:$PWD:api"
(cd apps/api && PORT=39099 exec -a "$BASELINE_MARK" bun run src/index.ts) >"$LUX_PROBE_TMP/lux-bench-seed-api.log" 2>&1 &
port_free() { ! python3 -c "import socket,sys; s=socket.socket(); sys.exit(0 if s.connect_ex(('127.0.0.1', 39099)) == 0 else 1)" 2>/dev/null; }
trap '
    pkill -9 -f "$BASELINE_MARK" >/dev/null 2>&1 || true
    for _ in $(seq 30); do port_free && break; sleep 0.2; done
    [ "$OWN_PROBE_TMP" = 1 ] && rm -rf "$LUX_PROBE_TMP"
' EXIT

API=http://127.0.0.1:39099
for _ in $(seq 60); do curl -sf "$API/v1" >/dev/null 2>&1 && break; sleep 1; done
curl -sf "$API/v1" >/dev/null

signup() {
    local email=$1
    curl -sS -X POST "$LUX_URL/auth/v1/signup" -H "apikey: $LUX_PUBLISHABLE_KEY" -H 'Content-Type: application/json' \
        -d "{\"email\":\"$email\",\"password\":\"$PASSWORD\"}" >/dev/null || true
    curl -sS -X POST "$LUX_URL/auth/v1/token?grant_type=password" -H "apikey: $LUX_PUBLISHABLE_KEY" \
        -H 'Content-Type: application/json' -d "{\"email\":\"$email\",\"password\":\"$PASSWORD\"}" | jq -r '.access_token'
}

owner_token=$(signup 'owner@acme.test')
other_token=$(signup 'owner@globex.test')
[ -n "$owner_token" ] && [ "$owner_token" != 'null' ] || { echo 'seed sign-up failed' >&2; exit 1; }

# The app's own signup page inserts a profiles row for every new user, and
# its routes join on it (members does). Seeding through Lux auth directly
# skips that, so give each user the profile a real signup would have.
profile() {
    local code
    code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$API/v1/profiles/me" -H "Authorization: Bearer $1" \
        -H 'Content-Type: application/json' -d "{\"username\":\"$2\",\"full_name\":\"$3\"}" || echo 000)
    echo "seed: profile $2 -> http $code"
}
profile "$owner_token" acmeowner 'Acme Owner'
profile "$other_token" globexowner 'Globex Owner'

acme_id=$(curl -sS -X POST "$API/v1/teams" -H "Authorization: Bearer $owner_token" -H 'Content-Type: application/json' \
    -d '{"name":"Acme Robotics","slug":"acme-robotics"}' | jq -r '.data.id')
globex_id=$(curl -sS -X POST "$API/v1/teams" -H "Authorization: Bearer $other_token" -H 'Content-Type: application/json' \
    -d '{"name":"Globex","slug":"globex"}' | jq -r '.data.id')
[ -n "$acme_id" ] && [ "$acme_id" != 'null' ] || { echo 'seed team creation failed' >&2; exit 1; }

direct_host=$(echo "$LUX_DIRECT_URL" | sed -E 's#^luxs?://[^@]*@([^:/]+):([0-9]+).*#\1#')
direct_port=$(echo "$LUX_DIRECT_URL" | sed -E 's#^luxs?://[^@]*@([^:/]+):([0-9]+).*#\2#')

cat >"$OUT" <<EOF
{"acme_id":"$acme_id","globex_id":"$globex_id","owner_email":"owner@acme.test","globex_owner_email":"owner@globex.test","password":"$PASSWORD","lux_url":"$LUX_URL","lux_secret_key":"$LUX_SECRET_KEY","lux_publishable_key":"$LUX_PUBLISHABLE_KEY","lux_direct_host":"$direct_host","lux_direct_port":"$direct_port","lux_direct_url":"$LUX_DIRECT_URL"}
EOF
echo "seeded acme=$acme_id globex=$globex_id"
