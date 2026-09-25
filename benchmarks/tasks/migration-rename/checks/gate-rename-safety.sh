#!/usr/bin/env bash
# Trap gate: the old app version (fullname) must keep working, with zero
# errors, while the migration runs (it is still deployed; nothing has told
# it about a new column). After the migration, a new app version
# (display_name) is introduced alongside it, and both must keep working with
# zero errors, with a write through either name visible through the other.
set -euo pipefail
source "$CHECKS_DIR/lib.sh"

OLD_RESULT="$(mktemp)"
BOTH_RESULT="$(mktemp)"
HOLD="$(mktemp -d)"
LOAD_SCRIPT="$(pwd)/.checks-dual-client-load.ts"
# seed-baseline.ts / migrate-baseline.ts are fixed copies of the fixture's own
# scripts, used only for the pre-submission baseline steps below. The
# project's own scripts/seed.ts and scripts/migrate.ts are never used for the
# baseline: the submission under test is free to edit those files, which
# would otherwise make baseline seeding fail against the pre-migration schema.
SEED_BASELINE_SCRIPT="$(pwd)/.checks-seed-baseline.ts"
MIGRATE_BASELINE_SCRIPT="$(pwd)/scripts/.checks-migrate-baseline.ts"
trap 'rm -f "$OLD_RESULT" "$BOTH_RESULT" "$LOAD_SCRIPT" "$SEED_BASELINE_SCRIPT" "$MIGRATE_BASELINE_SCRIPT"; rm -rf "$HOLD"; compose_down' EXIT

compose_up
install_deps
cp "$CHECKS_DIR/seed-baseline.ts" "$SEED_BASELINE_SCRIPT"
cp "$CHECKS_DIR/migrate-baseline.ts" "$MIGRATE_BASELINE_SCRIPT"

shopt -s nullglob
for f in migrations/*.sql; do
    [ "$(basename "$f")" = "0001_init.sql" ] || mv "$f" "$HOLD/"
done
bun run "$MIGRATE_BASELINE_SCRIPT"
SEED_USERS=20000 SEED_ORDERS=1000 SEED_EVENTS=1000 bun run "$SEED_BASELINE_SCRIPT"
mv "$HOLD"/*.sql migrations/ 2>/dev/null || true

cp "$CHECKS_DIR/dual-client-load.ts" "$LOAD_SCRIPT"

# Phase 1: only the old client is deployed. It must survive the migration.
bun run "$LOAD_SCRIPT" --mode old --out "$OLD_RESULT" --max-seconds 30 &
OLD_PID=$!
sleep 1

if ! bun run migrate; then
    kill "$OLD_PID" 2>/dev/null || true
    wait "$OLD_PID" 2>/dev/null || true
    echo "FAIL: bun run migrate exited non-zero"
    exit 1
fi

kill -TERM "$OLD_PID" 2>/dev/null || true
wait "$OLD_PID" 2>/dev/null || true

if [ ! -s "$OLD_RESULT" ]; then
    echo "FAIL: old-client load produced no result"
    exit 1
fi
cat "$OLD_RESULT"
OLD_ERRORS=$(bun -e "console.log(JSON.parse(require('fs').readFileSync('$OLD_RESULT','utf8')).errors)")
echo "old-client errors during migration: $OLD_ERRORS"
if [ "$OLD_ERRORS" -gt 0 ]; then
    echo "FAIL: the old app version broke while the migration ran"
    exit 1
fi

# Phase 2: the new version is now rolled out alongside the still-running old
# version. Both must work, and a write through either name must be visible
# through the other.
bun run "$LOAD_SCRIPT" --mode both --out "$BOTH_RESULT" --max-seconds 10
cat "$BOTH_RESULT"
BOTH_ERRORS=$(bun -e "console.log(JSON.parse(require('fs').readFileSync('$BOTH_RESULT','utf8')).errors)")
CROSS_FAIL=$(bun -e "console.log(JSON.parse(require('fs').readFileSync('$BOTH_RESULT','utf8')).crossVisibilityFailures)")
echo "both-clients errors after migration: $BOTH_ERRORS; cross-visibility failures: $CROSS_FAIL"

if [ "$BOTH_ERRORS" -gt 0 ]; then
    echo "FAIL: old and new clients did not both keep working after the migration"
    exit 1
fi
if [ "$CROSS_FAIL" -gt 0 ]; then
    echo "FAIL: a write through one name was not visible through the other"
    exit 1
fi

echo "PASS: old client survived the migration; old and new clients both work after, writes cross-visible"
