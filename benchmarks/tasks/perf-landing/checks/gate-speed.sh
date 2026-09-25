#!/usr/bin/env bash
# Speed gate: on a slow-4G-like mobile connection with 4x CPU throttle, the
# landing page's LCP must be under an absolute budget AND dramatically better
# than the untouched baseline measured back to back in this same run; total
# transferred bytes for the first load must also be well under baseline.
set -euo pipefail
source "$CHECKS_DIR/lib.sh"

LCP_BUDGET_MS="${LCP_BUDGET_MS:-6500}"
MIN_LCP_SPEEDUP="${MIN_LCP_SPEEDUP:-5}"
MAX_BYTES_RATIO="${MAX_BYTES_RATIO:-0.35}"
MAX_CLS="${MAX_CLS:-0.1}"

SUBMISSION_DIR="$(pwd)"
BASELINE_DIR="$(mktemp -d)"
trap 'stop_server; compose_down; rm -rf "$BASELINE_DIR"' EXIT

install_check_deps

baseline_checkout "$BASELINE_DIR"

echo "-- measuring baseline --"
cd "$BASELINE_DIR"
compose_up
install_deps >/dev/null
bun run migrate >/dev/null
seed_fixed >/dev/null
start_server "$SERVER_PORT"
cd "$SUBMISSION_DIR"
measure_page "http://localhost:$SERVER_PORT/" /tmp/pl-baseline-speed.json
stop_server
(cd "$BASELINE_DIR" && compose_down)

echo "-- measuring submission --"
compose_up
install_deps >/dev/null
bun run migrate >/dev/null
seed_fixed >/dev/null
start_server "$SERVER_PORT"
measure_page "http://localhost:$SERVER_PORT/" /tmp/pl-submission-speed.json
stop_server
compose_down

BASELINE_LCP=$(json_field /tmp/pl-baseline-speed.json lcp)
SUBMISSION_LCP=$(json_field /tmp/pl-submission-speed.json lcp)
BASELINE_BYTES=$(json_field /tmp/pl-baseline-speed.json bytes)
SUBMISSION_BYTES=$(json_field /tmp/pl-submission-speed.json bytes)
SUBMISSION_CLS=$(json_field /tmp/pl-submission-speed.json cls)
BASELINE_TIMED_OUT=$(json_field /tmp/pl-baseline-speed.json timedOut)
SUBMISSION_TIMED_OUT=$(json_field /tmp/pl-submission-speed.json timedOut)
rm -f /tmp/pl-baseline-speed.json /tmp/pl-submission-speed.json

# A timed-out baseline is fine: its capped LCP (the timeout value) is used
# in the ratio as-is, which only understates the baseline and makes the
# gate stricter. A timed-out submission is a straight fail -- the whole
# point of this task is a page that loads fast.
if [ "$BASELINE_TIMED_OUT" = "true" ]; then
    echo "baseline timed out at ${BASELINE_LCP}ms (capped)"
fi

BASELINE_LCP_INT=${BASELINE_LCP%.*}
SUBMISSION_LCP_INT=${SUBMISSION_LCP%.*}
[ -z "$SUBMISSION_LCP_INT" ] && SUBMISSION_LCP_INT=0
[ "$SUBMISSION_LCP_INT" -le 0 ] && SUBMISSION_LCP_INT=1

LCP_SPEEDUP=$(bun -e "console.log((${BASELINE_LCP} / ${SUBMISSION_LCP_INT}).toFixed(2))")
BYTES_RATIO=$(bun -e "console.log((${SUBMISSION_BYTES} / ${BASELINE_BYTES}).toFixed(3))")

echo "LCP: baseline=${BASELINE_LCP}ms submission=${SUBMISSION_LCP}ms (speedup ${LCP_SPEEDUP}x, need >= ${MIN_LCP_SPEEDUP}x and submission <= ${LCP_BUDGET_MS}ms)"
echo "bytes: baseline=${BASELINE_BYTES} submission=${SUBMISSION_BYTES} (ratio ${BYTES_RATIO}, need <= ${MAX_BYTES_RATIO})"
echo "CLS: submission=${SUBMISSION_CLS} (need <= ${MAX_CLS})"

FAIL=0
if [ "$SUBMISSION_TIMED_OUT" = "true" ]; then
    echo "FAIL: submission navigation timed out at ${SUBMISSION_LCP}ms"
    FAIL=1
fi
if [ "$SUBMISSION_LCP_INT" -gt "$LCP_BUDGET_MS" ]; then
    echo "FAIL: submission LCP ${SUBMISSION_LCP_INT}ms exceeds absolute budget ${LCP_BUDGET_MS}ms"
    FAIL=1
fi
if [ "$(bun -e "console.log(${LCP_SPEEDUP} >= ${MIN_LCP_SPEEDUP} ? 1 : 0)")" != "1" ]; then
    echo "FAIL: LCP speedup ${LCP_SPEEDUP}x is under the required ${MIN_LCP_SPEEDUP}x"
    FAIL=1
fi
if [ "$(bun -e "console.log(${BYTES_RATIO} <= ${MAX_BYTES_RATIO} ? 1 : 0)")" != "1" ]; then
    echo "FAIL: submission bytes are ${BYTES_RATIO}x of baseline, over the ${MAX_BYTES_RATIO}x budget"
    FAIL=1
fi
if [ "$(bun -e "console.log(${SUBMISSION_CLS} <= ${MAX_CLS} ? 1 : 0)")" != "1" ]; then
    echo "FAIL: submission CLS ${SUBMISSION_CLS} exceeds ${MAX_CLS}"
    FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
    exit 1
fi
echo "PASS: LCP ${SUBMISSION_LCP_INT}ms (<= ${LCP_BUDGET_MS}ms, ${LCP_SPEEDUP}x >= ${MIN_LCP_SPEEDUP}x faster than baseline); bytes ratio ${BYTES_RATIO} (<= ${MAX_BYTES_RATIO}); CLS ${SUBMISSION_CLS} (<= ${MAX_CLS})"
