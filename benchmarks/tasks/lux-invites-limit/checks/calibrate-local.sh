#!/usr/bin/env bash
# Local calibration: stand up Lux + the seeded fixture, overlay a reference
# (expert/naive/none), run every gate, print a pass/fail table. Docker only.
#
# Usage: ./checks/calibrate-local.sh [expert|naive|none]
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/ensure-lux.sh"
TASK="$(dirname "$HERE")"
REF="${1:-expert}"
WORK="$(mktemp -d /tmp/wbm-cal-invites-limit.XXXXXX)"
PROJECT="$WORK/project"
COMMIT=2f8b050fc3a2f39e680bf8d6013e9f29e314c636

echo "== calibrating lux-invites-limit / $REF =="
echo "work dir: $WORK"

git init -q "$WORK/src"
git -C "$WORK/src" fetch -q --depth 1 https://github.com/pompeii-labs/lux-starter "$COMMIT"
git -C "$WORK/src" checkout -q FETCH_HEAD
mkdir -p "$PROJECT"
tar --exclude=.git -cf - -C "$WORK/src" . | tar -xf - -C "$PROJECT"
cp -R "$TASK/overlay/." "$PROJECT/"
if [ "$REF" != "none" ]; then
    cp -R "$TASK/references/$REF/." "$PROJECT/"
fi

(cd "$PROJECT" && bun install --silent) || { echo "install failed"; exit 1; }
printf 'PUBLIC_LUX_URL=http://localhost:5890\nPUBLIC_LUX_PUBLISHABLE_KEY=lux_pub_placeholder\nPUBLIC_API_URL=http://localhost:3000\n' > "$PROJECT/apps/web/.env"

export CHECKS_DIR="$TASK/checks"

pass=0
fail=0
declare -a rows

run_gate() {
    local id=$1 cmd=$2
    echo "--- gate: $id ---"
    (cd "$PROJECT" && eval "$cmd")
    local code=$?
    if [ "$code" -eq 0 ]; then rows+=("$id | PASS"); pass=$((pass + 1))
    else rows+=("$id | FAIL (exit $code)"); fail=$((fail + 1)); fi
}

run_gate check "bun run check"
run_gate rate-limit "bash \"$CHECKS_DIR/probe.sh\""

echo
echo "== results ($REF) =="
printf '%s\n' "${rows[@]}"
echo
echo "pass=$pass fail=$fail"

echo
echo "== cleanup =="
(cd "$TASK/checks/baseline" && lux stop --clear >/dev/null 2>&1) || true
# `--clear` drops the data volume but not the saved local credentials; a
# stale credentials file pointed at a since-cleared volume causes the next
# `lux start` to hand out a password the fresh engine never set (WRONGPASS).
rm -rf "$TASK/checks/baseline/lux/.env-profiles" "$TASK/checks/baseline/lux/.lux-local.json" "$TASK/checks/baseline/.env.local" "$TASK/checks/baseline/apps/api/.env"
pkill -9 -f "bun run src/index.ts" >/dev/null 2>&1 || true
true >/dev/null 2>&1 || true
pkill -9 -f "bun run src/index.ts" >/dev/null 2>&1 || true
rm -rf "$WORK"
echo "removed $WORK"
