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
if [ "$REF" != "none" ]; then
    if [ ! -d "$TASK_DIR/references/$REF" ]; then
        echo "no reference '$REF'" >&2
        exit 2
    fi
    cp -r "$TASK_DIR/references/$REF/." "$PROJECT/"
fi

export COMPOSE_PROJECT_NAME="wbm-cal-bigint-$REF"
export CHECKS_DIR="$TASK_DIR/checks"

cd "$PROJECT"
echo "== calibrating migration-bigint / reference=$REF =="

declare -a NAMES=("write-safety" "functional" "typecheck")
declare -a SCRIPTS=("gate-write-safety.sh" "gate-functional.sh" "gate-check.sh")
declare -a RESULTS=()

for i in "${!SCRIPTS[@]}"; do
    name="${NAMES[$i]}"
    script="$CHECKS_DIR/${SCRIPTS[$i]}"
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
