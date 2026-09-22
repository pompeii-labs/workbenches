#!/usr/bin/env bash
# Local-only calibration: stands up the fixture, overlays a reference
# (expert|naive|none), runs every gate, and prints a pass/fail table.
# Usage: checks/calibrate-local.sh <expert|naive|none>
set -euo pipefail
cd "$(dirname "$0")/.."
TASK_DIR="$(pwd)"
REF="${1:-none}"
SCRATCH="$(mktemp -d)"
PROJECT="$SCRATCH/project"

cleanup() {
    (cd "$PROJECT" 2>/dev/null && COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" docker compose down -v --remove-orphans >/dev/null 2>&1) || true
    rm -rf "$SCRATCH"
}
trap cleanup EXIT

mkdir -p "$PROJECT"
cp -r "$TASK_DIR/fixture/." "$PROJECT/"
(cd "$PROJECT" && git init -q && git add -A && git -c user.email=cal@local -c user.name=cal commit -q -m baseline && git tag baseline)
if [ "$REF" != "none" ]; then
    if [ ! -d "$TASK_DIR/references/$REF" ]; then
        echo "no reference '$REF'" >&2
        exit 2
    fi
    cp -r "$TASK_DIR/references/$REF/." "$PROJECT/"
fi

export COMPOSE_PROJECT_NAME="wbm-cal-perf-landing-$REF"
export CHECKS_DIR="$TASK_DIR/checks"
# Local machines are shared: pick a free host port for Postgres and for the
# app server per invocation, so two concurrent calibrations never collide.
free_port() {
    python3 -c "import socket; s = socket.socket(); s.bind(('127.0.0.1', 0)); print(s.getsockname()[1]); s.close()"
}
export PGPORT="${PGPORT:-$(free_port)}"
export SERVER_PORT="${SERVER_PORT:-$(free_port)}"
echo "using PGPORT=$PGPORT SERVER_PORT=$SERVER_PORT"

cd "$PROJECT"
echo "== calibrating perf-landing / reference=$REF =="

declare -a NAMES=("speed" "visual" "typecheck")
declare -a SCRIPTS=("gate-speed.sh" "gate-visual.sh" "gate-check.sh")
declare -a RESULTS=()

for i in "${!SCRIPTS[@]}"; do
    name="${NAMES[$i]}"
    script="$CHECKS_DIR/${SCRIPTS[$i]}"
    # Optional: ONLY_GATES="visual typecheck" runs a subset.
    if [ -n "${ONLY_GATES:-}" ] && [[ " $ONLY_GATES " != *" $name "* ]]; then
        continue
    fi
    echo "--- gate: $name ---"
    if bash "$script"; then
        RESULTS+=("$name=PASS")
    else
        RESULTS+=("$name=FAIL")
    fi
    echo
done

echo "== summary (reference=$REF) =="
printf '%s\n' "${RESULTS[@]}"
