#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/lib/common.sh"
ensure_browser

if ! result=$(find_build 2>/tmp/find-build.err); then
    echo "FAIL: $(cat /tmp/find-build.err)"
    exit 1
fi
build_dir=$(printf '%s' "$result" | cut -f1)
html=$(printf '%s' "$result" | cut -f2)

base_url=$(serve_static "$build_dir")

# Best of 2 independent attempts within this one gate invocation. The probe
# (see probe.mjs) measures the player's pinned position with hazards
# median-filtered away and is close to deterministic on a given build; the
# second attempt covers a run that lost its time budget to a game dying
# through its retries, not a statistical near-miss. An unresponsive game
# scores near zero on both attempts, so a second attempt buys it nothing.
attempt=1
last_out=""
while [ "$attempt" -le 2 ]; do
    set +e
    last_out=$(node "$DIR/lib/probe.mjs" input "${base_url}/${html}" 2>&1)
    code=$?
    set -e
    if [ "$code" -eq 0 ]; then
        echo "$last_out"
        echo "(decisive on attempt $attempt of 2)"
        exit 0
    fi
    attempt=$((attempt + 1))
done
echo "$last_out"
echo "FAIL: no input signal was decisive in either of 2 attempts"
exit 1
