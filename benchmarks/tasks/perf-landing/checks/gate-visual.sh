#!/usr/bin/env bash
# Visual-parity gate: at a fixed mobile viewport (390x844), the landing page
# must look the same as the untouched baseline after load. The comparison
# in compare-screens.ts is perceptual (downscaled and blurred before
# diffing), so it tolerates the hero image being re-encoded, resized,
# recompressed, or regenerated without per-pixel noise grain, while still
# catching the hero being removed, swapped for a different image, or the
# page being badly restyled.
#
# Tolerance calibrated locally against six cases (see checks/calibrate-local.sh):
#   expert (re-encoded hero)         ~0.127  PASS
#   a grain-free re-encoded hero     ~0.024  PASS
#   naive (no visible change)         0.000  PASS
#   hero swapped for different image  ~0.256 FAIL
#   hero removed                      ~0.330 FAIL
#   dark restyle                      ~0.737 FAIL
# 0.18 sits between the highest legitimate case (0.127, 1.4x below the
# bar) and the lowest broken case (0.256, 1.4x above it). The margin is
# modest on both sides; a submission that re-encodes the hero AND shifts
# layout could land near the bar, and its screenshots are kept in the gate
# log for a person to read.
set -euo pipefail
source "$CHECKS_DIR/lib.sh"

MAX_DIFF_FRACTION="${MAX_DIFF_FRACTION:-0.18}"

SUBMISSION_DIR="$(pwd)"
BASELINE_DIR="$(mktemp -d)"
trap 'stop_server; compose_down; rm -rf "$BASELINE_DIR"; rm -f /tmp/pl-baseline.png /tmp/pl-submission.png /tmp/pl-baseline-visual.json /tmp/pl-submission-visual.json' EXIT

install_check_deps

baseline_checkout "$BASELINE_DIR"

echo "-- capturing baseline screenshot --"
cd "$BASELINE_DIR"
compose_up
install_deps >/dev/null
bun run migrate >/dev/null
seed_fixed >/dev/null
start_server "$SERVER_PORT"
cd "$SUBMISSION_DIR"
measure_page "http://localhost:$SERVER_PORT/" /tmp/pl-baseline-visual.json /tmp/pl-baseline.png --no-throttle
stop_server
(cd "$BASELINE_DIR" && compose_down)

echo "-- capturing submission screenshot --"
compose_up
install_deps >/dev/null
bun run migrate >/dev/null
seed_fixed >/dev/null
start_server "$SERVER_PORT"
measure_page "http://localhost:$SERVER_PORT/" /tmp/pl-submission-visual.json /tmp/pl-submission.png --no-throttle
stop_server
compose_down

DIFF=$(cd "$CHECKS_DIR" && bun run compare-screens.ts /tmp/pl-baseline.png /tmp/pl-submission.png)
echo "screenshot diff fraction: ${DIFF} (need <= ${MAX_DIFF_FRACTION})"

if [ "$(bun -e "console.log(${DIFF} <= ${MAX_DIFF_FRACTION} ? 1 : 0)")" != "1" ]; then
    echo "FAIL: screenshot differs from baseline by ${DIFF}, over the ${MAX_DIFF_FRACTION} tolerance"
    exit 1
fi
echo "PASS: screenshot within tolerance of baseline (diff ${DIFF} <= ${MAX_DIFF_FRACTION})"
