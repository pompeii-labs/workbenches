#!/usr/bin/env bash
# Exports a reference project SOURCE with the real godot-web-games tools,
# then runs every gate in this task against that build, all inside a local
# mirror of the actual Workbench image -- matching the harness's own
# contract: prepareEvaluationRuntime (lib/packaging.ts) always builds and
# grades in the task's OWN Workbench image for BOTH arms (see the comment
# in checks/lib/common.sh and grading.ts's `shared-product-runtime-v1`).
# Local Docker only.
#
# Usage: checks/calibrate-local.sh <path-to-reference-source-dir> [label]
set -euo pipefail
TASK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BENCH_DIR="$(cd "$TASK_DIR/../../.." && pwd)"
WORKBENCH_SRC="$BENCH_DIR/.workbenches/godot-web-games"
PROJECT_SRC="$(cd "$1" && pwd)"
LABEL="${2:-$(basename "$PROJECT_SRC")}"
IMAGE="wbm-cal-godot-workbench:arm64"
DOWNLOAD_CACHE="${WBM_CAL_GODOT_CACHE:-$HOME/.cache/wbm-cal-godot-downloads}"
SCRATCH="$(mktemp -d "/tmp/wbm-cal-godot-run.XXXXXX")"
LOCKDIR="$DOWNLOAD_CACHE/.build.lock"
trap 'rm -rf "$SCRATCH"; docker rm -f "wbm-cal-godot-export-$$" "wbm-cal-godot-check-$$" >/dev/null 2>&1 || true; rmdir "$LOCKDIR" 2>/dev/null || true' EXIT

# --- Build a LOCAL, arm64 mirror of the real godot-web-games Dockerfile ---
# The shipped Dockerfile (.workbenches/godot-web-games/Dockerfile) is
# linux/amd64 with sha-pinned official downloads, by design, and stays that
# way. This mirror exists only so calibration runs at native speed on an
# arm64 dev machine; it uses the SAME tools/ scripts unmodified. Godot does
# publish an official linux.arm64 build; it is not used in the shipped
# package, only here.
# Concurrent calibrate-local.sh invocations (e.g. one per task, run in
# parallel) must not race on the shared download cache or the shared image
# name: a simple mkdir-based lock (portable, no `flock` dependency, released
# by the EXIT trap above even on error) plus a double-check of the image
# after acquiring it.
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    mkdir -p "$DOWNLOAD_CACHE"
    waited=0
    while ! mkdir "$LOCKDIR" 2>/dev/null; do
        sleep 1
        waited=$((waited + 1))
        [ "$waited" -gt 600 ] && { echo "timed out waiting for image build lock" >&2; exit 1; }
    done
    if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
        echo "building $IMAGE (one-time; downloads cached under $DOWNLOAD_CACHE)..." >&2
        BUILD_CTX="$(mktemp -d)"
        fetch_verified() {
            # $1 url  $2 dest  $3 sha512
            if [ -f "$2" ] && ! (echo "$3  $2" | sha512sum -c - >/dev/null 2>&1); then
                echo "cached $2 failed checksum, re-fetching" >&2
                rm -f "$2"
            fi
            if [ ! -f "$2" ]; then
                curl -fL --retry 3 -o "$2" "$1"
            fi
            echo "$3  $2" | sha512sum -c -
        }
        fetch_verified \
            https://github.com/godotengine/godot-builds/releases/download/4.7.1-stable/Godot_v4.7.1-stable_linux.arm64.zip \
            "$DOWNLOAD_CACHE/godot-arm64.zip" \
            de64efe4d936ac0403769e078a73d961a9c647cab04168c5fb5a7fe33728e200a67324ed99368eeb27964e205e72a61e48efb63b52d5de34d12dd6a95ca0fc45
        fetch_verified \
            https://github.com/godotengine/godot-builds/releases/download/4.7.1-stable/Godot_v4.7.1-stable_export_templates.tpz \
            "$DOWNLOAD_CACHE/templates.tpz" \
            afcc83d8d3d298038f19c58744a0d660fa75dd4baa33cb55d1011bb2565a2a8c2381728924564cb909e37c205a23f21b521b23bd057993afd43ae4da0b2f9d47
        cp "$DOWNLOAD_CACHE/godot-arm64.zip" "$BUILD_CTX/godot-arm64.zip"
        cp "$DOWNLOAD_CACHE/templates.tpz" "$BUILD_CTX/templates.tpz"
        cp -R "$WORKBENCH_SRC/tools" "$BUILD_CTX/tools"
        cat >"$BUILD_CTX/Dockerfile" <<'EOF'
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
        bash ca-certificates curl git unzip jq ripgrep procps iproute2 python3 \
        chromium fonts-liberation libfontconfig1 libx11-6 libxcursor1 libxinerama1 \
        libgl1 libxi6 libxrandr2 libasound2 libpulse0 \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --prefix /opt/browser --save-exact playwright@1.55.0 && npm cache clean --force
ENV PLAYWRIGHT_MODULE_DIR=/opt/browser/node_modules
ENV NODE_PATH=/opt/browser/node_modules
COPY godot-arm64.zip /tmp/godot.zip
COPY templates.tpz /tmp/templates.tpz
RUN mkdir -p /opt/godot \
 && unzip -q /tmp/godot.zip -d /opt/godot \
 && mv /opt/godot/Godot_v4.7.1-stable_linux.arm64 /opt/godot/godot \
 && chmod 755 /opt/godot/godot && rm /tmp/godot.zip
RUN mkdir -p /opt/godot/templates/4.7.1.stable \
 && unzip -jqo /tmp/templates.tpz 'templates/web*.zip' -d /opt/godot/templates/4.7.1.stable \
 && rm /tmp/templates.tpz
COPY tools/godot /usr/local/bin/godot
COPY tools/game-export.mjs /usr/local/bin/game-export
COPY tools/game-playcheck.mjs /usr/local/bin/game-playcheck
RUN chmod 755 /usr/local/bin/godot /usr/local/bin/game-export /usr/local/bin/game-playcheck
EOF
        docker build -t "$IMAGE" "$BUILD_CTX" >&2
        rm -rf "$BUILD_CTX"
    fi
    rmdir "$LOCKDIR" 2>/dev/null || true
fi

# --- Copy the reference SOURCE and export it fresh, with the real tool ---
mkdir -p "$SCRATCH/project" "$SCRATCH/checks"
cp -R "$PROJECT_SRC/." "$SCRATCH/project/"
cp -R "$TASK_DIR/." "$SCRATCH/checks/"
rm -rf "$SCRATCH/checks/.cache"
mkdir -p "$SCRATCH/checks/.cache"

if [ -f "$SCRATCH/project/.skip-export" ]; then
    echo "$LABEL has .skip-export; testing the source as delivered (the no-export naive case)" >&2
elif [ -f "$SCRATCH/project/project.godot" ]; then
    echo "exporting $LABEL with game-export (source -> web build, on the fly)..." >&2
    docker run --rm --name "wbm-cal-godot-export-$$" \
        -v "$SCRATCH/project:/work/project" -w /work/project \
        "$IMAGE" bash -c "game-export /work/project /work/project/build/web" >&2
else
    echo "no project.godot in $PROJECT_SRC; testing as-is (e.g. the empty fixture)" >&2
fi

printf '%-28s %-6s %8s  %s\n' "gate" "result" "seconds" "reason"
printf -- '-------------------------------------------------------------------\n'

overall=0
for gate in web-build-present loads-on-plain-static-host renders responds-to-input survives-play; do
    start=$(date +%s)
    set +e
    out=$(docker run --rm --name "wbm-cal-godot-check-$$" \
        -e CHECKS_DIR=/work/checks \
        -e HOME=/work/home \
        -v "$SCRATCH/project:/work/project" \
        -v "$SCRATCH/checks:/work/checks" \
        -w /work/project \
        "$IMAGE" bash -c "mkdir -p /work/home && bash /work/checks/${gate}.sh" 2>&1)
    code=$?
    set -e
    end=$(date +%s)
    status="FAIL"
    [ "$code" -eq 0 ] && status="PASS"
    [ "$status" = "FAIL" ] && overall=1
    reason=$(printf '%s' "$out" | grep -E '^RESULT: |^FAIL: |^PASS: ' | tail -1)
    printf '%-28s %-6s %8s  %s\n' "$gate" "$status" "$((end - start))" "${reason:-$(printf '%s' "$out" | tail -1)}"
done

echo
echo "label: $LABEL"
exit $overall
