#!/usr/bin/env bash
# Content/pagination contract gate. See compare-search.ts for the exact
# fields and prefix rule. Measured at the setup-seed.sh scale (the scale the
# actor worked with), not the 10x scale used by the speed and memory gates.
# Seeding is deterministic, so baseline and submission, seeded independently,
# hold identical rows.
#
# Probes, all with NO limit/page/cursor params (the default response):
#   - "Product 12"            1,111 matches, so a paginated submission is
#                             compared on its first page against the front of
#                             baseline's fully sorted list
#   - "Product 4999"          11 matches, fewer than any sane page size, so
#                             the submission must return all of them in order
#   - "zzz-nonexistent-term"  zero matches, results must be empty
set -euo pipefail
source "$CHECKS_DIR/lib.sh"

PORT_N="${SERVER_PORT:-3000}"
SUBMISSION_DIR="$(pwd)"
BASELINE_DIR="$(mktemp -d)"
OUT_DIR="$(mktemp -d)"
trap 'stop_server; compose_down; rm -rf "$BASELINE_DIR" "$OUT_DIR"' EXIT

declare -a TERMS=("Product 12" "Product 4999" "zzz-nonexistent-term")

capture() {
    local label="$1"
    local i
    for i in "${!TERMS[@]}"; do
        local term_url
        term_url=$(bun -e "console.log(encodeURIComponent(process.argv[1]))" "${TERMS[$i]}")
        curl -s --max-time 60 "http://localhost:${PORT_N}/search?q=${term_url}" -o "$OUT_DIR/$label-$i.json" || true
    done
}

baseline_checkout "$BASELINE_DIR"

echo "-- capturing baseline responses --"
cd "$BASELINE_DIR"
compose_up >/dev/null
install_deps >/dev/null
bun run migrate >/dev/null
seed_fixed >/dev/null
start_server "$PORT_N"
cd "$SUBMISSION_DIR"
capture baseline
stop_server
(cd "$BASELINE_DIR" && compose_down)

echo "-- capturing submission responses --"
compose_up >/dev/null
install_deps >/dev/null
bun run migrate >/dev/null
seed_fixed >/dev/null
start_server "$PORT_N"
capture submission
stop_server
compose_down

FAIL=0
for i in "${!TERMS[@]}"; do
    echo "term='${TERMS[$i]}':"
    if ! bun run "$CHECKS_DIR/compare-search.ts" "$OUT_DIR/baseline-$i.json" "$OUT_DIR/submission-$i.json"; then
        FAIL=1
    fi
done

if [ "$FAIL" -ne 0 ]; then
    echo "FAIL: default search response no longer begins with baseline's results"
    exit 1
fi
echo "PASS: default search response begins with baseline's results, in order, for every term"
