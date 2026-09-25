#!/usr/bin/env bash
# Functional gate: existing values are preserved through the migration,
# under whichever of fullname / display_name the submission leaves live.
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
SEED_USERS=5000 SEED_ORDERS=100 SEED_EVENTS=100 bun run "$SEED_BASELINE_SCRIPT"
BEFORE_CHECKSUM=$(psql_c "SELECT md5(string_agg(fullname, '|' ORDER BY id)) FROM users")
mv "$HOLD"/*.sql migrations/ 2>/dev/null || true

bun run migrate

HAS_FULLNAME=$(psql_c "SELECT count(*) FROM information_schema.columns WHERE table_name='users' AND column_name='fullname'")
HAS_DISPLAY=$(psql_c "SELECT count(*) FROM information_schema.columns WHERE table_name='users' AND column_name='display_name'")
echo "has fullname: $HAS_FULLNAME; has display_name: $HAS_DISPLAY"

if [ "$HAS_FULLNAME" = "0" ] && [ "$HAS_DISPLAY" = "0" ]; then
    echo "FAIL: neither fullname nor display_name exists after migration"
    exit 1
fi

if [ "$HAS_FULLNAME" != "0" ]; then
    AFTER=$(psql_c "SELECT md5(string_agg(fullname, '|' ORDER BY id)) FROM users")
    echo "fullname checksum before=$BEFORE_CHECKSUM after=$AFTER"
    if [ "$AFTER" != "$BEFORE_CHECKSUM" ]; then
        echo "FAIL: fullname values changed"
        exit 1
    fi
fi
if [ "$HAS_DISPLAY" != "0" ]; then
    AFTER=$(psql_c "SELECT md5(string_agg(display_name, '|' ORDER BY id)) FROM users")
    echo "display_name checksum before=$BEFORE_CHECKSUM after=$AFTER"
    if [ "$AFTER" != "$BEFORE_CHECKSUM" ]; then
        echo "FAIL: display_name values do not match the original fullname values"
        exit 1
    fi
fi

echo "PASS: existing values preserved"
