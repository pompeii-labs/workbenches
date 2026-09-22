#!/usr/bin/env bash
# Speed gate: re-seeds BOTH baseline and submission at 10x the product count
# the actor saw (per the task design spec), then measures p95 latency for
# four kinds of search term back to back, in the same run:
#   - rare       "Product 4999"          about 111 matches out of 500,000
#   - no-match   "zzz-nonexistent-term"  zero matches
#   - broad      "Product 123"           about 1,111 matches
#   - everything "ordinary"              every product matches
# The submission's p95 for each term must be at least MIN_SPEEDUP times
# faster than baseline's p95 for that same term.
#
# Every request is capped at CAP_SECONDS. The untouched baseline cannot answer
# the "everything" term inside the cap at this scale (it would run for many
# minutes), so its p95 there is recorded as the cap, which understates the
# real baseline and so only ever makes the gate harder to pass, never easier.
# That term is measured last, with few samples, because each capped baseline
# request leaves a query grinding away inside Postgres.
set -euo pipefail
source "$CHECKS_DIR/lib.sh"

MIN_SPEEDUP="${MIN_SPEEDUP:-5}"
CAP_SECONDS="${CAP_SECONDS:-20}"
PORT_N="${SERVER_PORT:-3000}"
SUBMISSION_DIR="$(pwd)"
BASELINE_DIR="$(mktemp -d)"
trap 'stop_server; compose_down; rm -rf "$BASELINE_DIR"' EXIT

declare -a TERM_NAMES=("rare" "no-match" "broad" "everything")
declare -a TERMS=("Product 4999" "zzz-nonexistent-term" "Product 123" "ordinary")
declare -a SAMPLES=(10 10 8 2)

measure_all() {
    local label="$1"
    local i
    # One throwaway search for a term that is never measured, so the database
    # pool and the code path are warm. The measured terms themselves get no
    # warm-up: each one's first, cold request counts, which is what keeps a
    # per-term response cache from passing this gate.
    curl -s -o /dev/null --max-time "$CAP_SECONDS" "http://localhost:${PORT_N}/search?q=warmup-only-term" || true
    for i in "${!TERMS[@]}"; do
        local term_url res p95
        term_url=$(bun -e "console.log(encodeURIComponent(process.argv[1]))" "${TERMS[$i]}")
        res=$(p95_ms "http://localhost:${PORT_N}/search?q=${term_url}" "${SAMPLES[$i]}" "$CAP_SECONDS")
        p95=$(echo "$res" | awk '{print $2}')
        echo "$p95" >> "/tmp/perf-search-$label-$$.txt"
        echo "$label term='${TERMS[$i]}' (${TERM_NAMES[$i]}): p95=${p95}ms"
    done
}

baseline_checkout "$BASELINE_DIR"
rm -f "/tmp/perf-search-baseline-$$.txt" "/tmp/perf-search-submission-$$.txt"

echo "-- measuring baseline (10x scale: $SEED_PRODUCTS_10X products) --"
cd "$BASELINE_DIR"
compose_up >/dev/null
install_deps >/dev/null
bun run migrate >/dev/null
seed_10x
start_server "$PORT_N"
cd "$SUBMISSION_DIR"
measure_all baseline
stop_server
(cd "$BASELINE_DIR" && compose_down)

echo "-- measuring submission (10x scale: $SEED_PRODUCTS_10X products) --"
compose_up >/dev/null
install_deps >/dev/null
bun run migrate >/dev/null
seed_10x
start_server "$PORT_N"
measure_all submission
stop_server
compose_down

BASELINE_P95=()
while read -r line; do BASELINE_P95+=("$line"); done < "/tmp/perf-search-baseline-$$.txt"
SUBMISSION_P95=()
while read -r line; do SUBMISSION_P95+=("$line"); done < "/tmp/perf-search-submission-$$.txt"
rm -f "/tmp/perf-search-baseline-$$.txt" "/tmp/perf-search-submission-$$.txt"

FAIL=0
for i in "${!TERMS[@]}"; do
    b="${BASELINE_P95[$i]}"
    s="${SUBMISSION_P95[$i]}"
    if [ "$s" -le 0 ]; then s=1; fi
    speedup=$(bun -e "console.log((${b} / ${s}).toFixed(2))")
    echo "term='${TERMS[$i]}' (${TERM_NAMES[$i]}): baseline p95=${b}ms submission p95=${s}ms speedup=${speedup}x (need >= ${MIN_SPEEDUP}x)"
    if (( $(bun -e "console.log(${speedup} >= ${MIN_SPEEDUP} ? 1 : 0)") == 0 )); then
        echo "FAIL: '${TERMS[$i]}' is only ${speedup}x faster than baseline, need ${MIN_SPEEDUP}x"
        FAIL=1
    fi
done

if [ "$FAIL" -ne 0 ]; then
    exit 1
fi
echo "PASS: search is at least ${MIN_SPEEDUP}x faster than baseline for every term at 10x scale"
