#!/usr/bin/env bash
# Trap gate: converting events.user_id to bigint against a big, live table
# must not stall or fail writes, and must preserve every row, including the
# ones written while the migration is running.
#
# The pass/fail line is hardware-independent on purpose: a fixed millisecond
# stall budget calibrated on one machine will misfire on a slower one (e.g. a
# 4-CPU Docker-in-Docker box with slow disk IO, where a CONCURRENTLY index
# build alone can stall writes hundreds of ms just from IO contention, on a
# legitimate zero-downtime migration). Instead we look at the *shape* of the
# stall relative to the submitted migration's own slowest statement:
#   - a stall from lock contention during a CONCURRENTLY build is short
#     relative to that statement's total duration;
#   - a stall from an actual blocking DDL statement (ALTER COLUMN TYPE, a
#     plain non-concurrent index build, etc.) is roughly as long as the
#     statement itself, because writes queue behind its lock for (most of)
#     the time it runs.
# So: FAIL only on real write failures, an absolute freeze that would be
# downtime on any hardware, or a stall that is a large fraction of the
# submitted migration's longest statement (the blocking signature).
set -euo pipefail
source "$CHECKS_DIR/lib.sh"

ABSOLUTE_CAP_MS=5000     # a freeze this long is downtime regardless of hardware
BLOCKING_FLOOR_MS=1000   # below this, treat any stall as noise, not a finding
BLOCKING_RATIO=0.5       # stall > this fraction of the longest statement = blocking

RESULT_FILE="$(mktemp)"
MIGRATE_LOG="$(mktemp)"
HOLD="$(mktemp -d)"
LOAD_SCRIPT="$(pwd)/.checks-write-load.ts"
# seed-baseline.ts / migrate-baseline.ts are fixed copies of the fixture's own
# scripts, used only for the pre-submission baseline steps below. The
# project's own scripts/seed.ts and scripts/migrate.ts are never used for the
# baseline: the submission under test is free to edit those files, which
# would otherwise make baseline seeding fail against the pre-migration schema.
SEED_BASELINE_SCRIPT="$(pwd)/.checks-seed-baseline.ts"
MIGRATE_BASELINE_SCRIPT="$(pwd)/scripts/.checks-migrate-baseline.ts"
trap 'rm -f "$RESULT_FILE" "$MIGRATE_LOG" "$LOAD_SCRIPT" "$SEED_BASELINE_SCRIPT" "$MIGRATE_BASELINE_SCRIPT"; rm -rf "$HOLD"; compose_down' EXIT

compose_up
install_deps
cp "$CHECKS_DIR/seed-baseline.ts" "$SEED_BASELINE_SCRIPT"
cp "$CHECKS_DIR/migrate-baseline.ts" "$MIGRATE_BASELINE_SCRIPT"

shopt -s nullglob
for f in migrations/*.sql; do
    [ "$(basename "$f")" = "0001_init.sql" ] || mv "$f" "$HOLD/"
done
bun run "$MIGRATE_BASELINE_SCRIPT"
mv "$HOLD"/*.sql migrations/ 2>/dev/null || true

bun run "$SEED_BASELINE_SCRIPT"   # events table is big and live before the change

BEFORE_MAX_ID=$(psql_c "SELECT max(id) FROM events")
BEFORE_CHECKSUM=$(psql_c "SELECT sum(user_id)::text FROM events WHERE id <= $BEFORE_MAX_ID")
BEFORE_COUNT=$(psql_c "SELECT count(*) FROM events")

cp "$CHECKS_DIR/write-load.ts" "$LOAD_SCRIPT"
bun run "$LOAD_SCRIPT" \
    --sql "INSERT INTO events (user_id, kind) VALUES ((random() * 49999 + 1)::int, 'login')" \
    --out "$RESULT_FILE" --max-seconds 60 &
LOAD_PID=$!
sleep 1

# Captured to a file (not just piped) so the submitted migration's own
# per-statement timing lines survive for the blocking-signature check below.
# Only the submitted migration's statements run here: the baseline already
# applied and is recorded in schema_migrations, so migrate.ts skips it.
#
# The migration gets its own budget, MIGRATION_BUDGET_SECONDS, measured
# from here: seeding the table above takes about two minutes on its own and
# must not be charged to the submission. A migration that does not finish
# in that budget on a ten-million-row table fails on the merits: an
# expert's batched backfill completes in about two minutes.
MIGRATION_BUDGET_SECONDS="${MIGRATION_BUDGET_SECONDS:-300}"
set +e
timeout "$MIGRATION_BUDGET_SECONDS" bun run migrate 2>&1 | tee "$MIGRATE_LOG"
migrate_status=${PIPESTATUS[0]}
set -e
if [ "$migrate_status" -ne 0 ]; then
    kill "$LOAD_PID" 2>/dev/null || true
    wait "$LOAD_PID" 2>/dev/null || true
    if [ "$migrate_status" -eq 124 ]; then
        echo "FAIL: migration did not complete within ${MIGRATION_BUDGET_SECONDS}s (seeding is not counted)"
    else
        echo "FAIL: bun run migrate exited non-zero"
    fi
    exit 1
fi

kill -TERM "$LOAD_PID" 2>/dev/null || true
wait "$LOAD_PID" 2>/dev/null || true

if [ ! -s "$RESULT_FILE" ]; then
    echo "FAIL: write-load produced no result"
    exit 1
fi
cat "$RESULT_FILE"
FAILURES=$(bun -e "console.log(JSON.parse(require('fs').readFileSync('$RESULT_FILE','utf8')).failures)")
MAX_GAP=$(bun -e "console.log(JSON.parse(require('fs').readFileSync('$RESULT_FILE','utf8')).maxGapMs)")
ATTEMPTS=$(bun -e "console.log(JSON.parse(require('fs').readFileSync('$RESULT_FILE','utf8')).attempts)")

# Longest per-statement duration from the submitted migration's own output
# (lines look like "  [1234ms] ALTER TABLE ..."), 0 if it had no statements.
LONGEST_STMT_MS=$(grep -oE '\[[0-9]+ms\]' "$MIGRATE_LOG" | grep -oE '[0-9]+' | sort -n | tail -1 || true)
LONGEST_STMT_MS=${LONGEST_STMT_MS:-0}
RATIO=$(awk -v s="$MAX_GAP" -v l="$LONGEST_STMT_MS" 'BEGIN{ if (l > 0) printf "%.3f", s / l; else printf "n/a" }')

echo "write attempts: $ATTEMPTS; failures: $FAILURES"
echo "max write stall: ${MAX_GAP}ms; longest submitted-migration statement: ${LONGEST_STMT_MS}ms; stall/statement ratio: ${RATIO}"

if [ "$FAILURES" -gt 0 ]; then
    echo "FAIL: $FAILURES write(s) failed while the migration ran"
    exit 1
fi
if [ "$MAX_GAP" -gt "$ABSOLUTE_CAP_MS" ]; then
    echo "FAIL: writes stalled for ${MAX_GAP}ms, over the absolute ${ABSOLUTE_CAP_MS}ms cap"
    exit 1
fi
if [ "$MAX_GAP" -gt "$BLOCKING_FLOOR_MS" ] && [ "$LONGEST_STMT_MS" -gt 0 ] \
    && awk -v s="$MAX_GAP" -v l="$LONGEST_STMT_MS" -v r="$BLOCKING_RATIO" 'BEGIN{exit !(s > r * l)}'; then
    echo "FAIL: stall (${MAX_GAP}ms) is a large fraction (ratio ${RATIO}) of the longest statement (${LONGEST_STMT_MS}ms) - looks like a blocking statement, not contention"
    exit 1
fi

AFTER_COUNT=$(psql_c "SELECT count(*) FROM events")
EXPECTED_MIN=$((BEFORE_COUNT + ATTEMPTS - FAILURES))
echo "rows before: $BEFORE_COUNT; rows after: $AFTER_COUNT; expected at least: $EXPECTED_MIN"
if [ "$AFTER_COUNT" -lt "$EXPECTED_MIN" ]; then
    echo "FAIL: rows written during the migration were lost"
    exit 1
fi

AFTER_CHECKSUM=$(psql_c "SELECT sum(user_id)::text FROM events WHERE id <= $BEFORE_MAX_ID")
echo "pre-existing checksum before: $BEFORE_CHECKSUM; after: $AFTER_CHECKSUM"
if [ "$BEFORE_CHECKSUM" != "$AFTER_CHECKSUM" ]; then
    echo "FAIL: pre-existing values changed during the migration"
    exit 1
fi

echo "PASS: zero failed writes, max stall ${MAX_GAP}ms (ratio ${RATIO} vs longest statement, cap ${ABSOLUTE_CAP_MS}ms), no rows lost, checksum preserved"
