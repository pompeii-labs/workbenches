#!/usr/bin/env bash
# Functional gate: events.user_id is really bigint, and can hold values
# beyond the old int range.
set -euo pipefail
source "$CHECKS_DIR/lib.sh"

HOLD="$(mktemp -d)"
trap 'rm -rf "$HOLD"; compose_down' EXIT

compose_up
install_deps

# seed-baseline.ts / migrate-baseline.ts are fixed copies of the fixture's own
# scripts, used only for the pre-submission baseline steps below. The
# project's own scripts/seed.ts and scripts/migrate.ts are never used for the
# baseline: the submission under test is free to edit those files, which
# would otherwise make baseline seeding fail against the pre-migration schema.
SEED_BASELINE_SCRIPT="$(pwd)/.checks-seed-baseline.ts"
MIGRATE_BASELINE_SCRIPT="$(pwd)/scripts/.checks-migrate-baseline.ts"
trap 'rm -f "$SEED_BASELINE_SCRIPT" "$MIGRATE_BASELINE_SCRIPT"; rm -rf "$HOLD"; compose_down' EXIT
cp "$CHECKS_DIR/seed-baseline.ts" "$SEED_BASELINE_SCRIPT"
cp "$CHECKS_DIR/migrate-baseline.ts" "$MIGRATE_BASELINE_SCRIPT"

shopt -s nullglob
for f in migrations/*.sql; do
    [ "$(basename "$f")" = "0001_init.sql" ] || mv "$f" "$HOLD/"
done
bun run "$MIGRATE_BASELINE_SCRIPT"
SEED_ORDERS=10000 SEED_EVENTS=300000 bun run "$SEED_BASELINE_SCRIPT"
mv "$HOLD"/*.sql migrations/ 2>/dev/null || true

bun run migrate

COL_TYPE=$(psql_c "SELECT data_type FROM information_schema.columns WHERE table_name='events' AND column_name='user_id'")
echo "events.user_id type: $COL_TYPE"
if [ "$COL_TYPE" != "bigint" ]; then
    echo "FAIL: events.user_id is not bigint"
    exit 1
fi

BIG_VALUE=9999999999
psql_c "INSERT INTO events (user_id, kind) VALUES ($BIG_VALUE, 'login')" >/dev/null
STORED=$(psql_c "SELECT user_id FROM events WHERE user_id = $BIG_VALUE")
echo "stored above-int-max value: $STORED"
if [ "$STORED" != "$BIG_VALUE" ]; then
    echo "FAIL: could not store a value above the old int range"
    exit 1
fi

echo "PASS: column is bigint and holds values beyond the old int range"
