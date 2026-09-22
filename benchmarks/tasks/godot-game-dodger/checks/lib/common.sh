#!/usr/bin/env bash
# Shared helpers for the Godot web-build gates. Copied verbatim into every
# godot-game-* task's checks/lib/. No thresholds live here; each gate script
# owns its own pass/fail numbers.
set -euo pipefail

PROBE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE_DIR="${CHECKS_DIR}/.cache"
MODULES_DIR="$CACHE_DIR/pw-modules"
PW_VERSION="1.55.0"

# Gates run inside prepareEvaluationRuntime's resolved image (lib/packaging.ts),
# which always stages and builds THIS TASK'S OWN Workbench (task.workbench =
# godot-web-games), never a plain-control image. That is true for both arms:
# grading is explicitly "the same product runtime for both submissions"
# (lib/grading.ts's `contract: 'shared-product-runtime-v1'`, and the README).
# So both arms' gates run in an image that already has Chromium and the
# `playwright` package (the same ones the actor used) -- this function should
# find them and do nothing. The apt-get/npm branch below is a defensive
# fallback ONLY, for someone running these checks outside this harness (e.g.
# against a manually-served build on a bare machine); it should never fire in
# a real trial and is not exercised by calibrate-local.sh, which builds the
# real godot-web-games Dockerfile so gates run under the same contract here
# too.
ensure_browser() {
    if command -v chromium >/dev/null 2>&1; then
        export CHROMIUM_PATH="$(command -v chromium)"
    elif command -v chromium-browser >/dev/null 2>&1; then
        export CHROMIUM_PATH="$(command -v chromium-browser)"
    else
        echo "probe: WARNING no preinstalled Chromium found; this should not" >&2
        echo "probe: happen under the harness (see comment above). Falling" >&2
        echo "probe: back to installing one now." >&2
        apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends chromium >/dev/null
        export CHROMIUM_PATH="$(command -v chromium)"
    fi

    if [ -d "/opt/browser/node_modules/playwright" ]; then
        export PW_MODULE_DIR="/opt/browser/node_modules"
    else
        echo "probe: WARNING no preinstalled playwright module found; same" >&2
        echo "probe: caveat as above." >&2
        mkdir -p "$CACHE_DIR"
        if [ ! -e "$MODULES_DIR/node_modules/playwright/package.json" ]; then
            npm install --prefix "$MODULES_DIR" --no-audit --no-fund --silent \
                "playwright@$PW_VERSION" >/dev/null
        fi
        export PW_MODULE_DIR="$MODULES_DIR"
    fi
}

# Prints "<dir>\t<html-file>" for the newest complete web export found
# anywhere in the repo, or exits 1 with a reason on stderr.
find_build() {
    node "$PROBE_LIB_DIR/find-build.mjs" "$PWD"
}

# Serves $1 on 127.0.0.1 with a bare static file server: no COOP/COEP, no
# caching headers, nothing that a naive static host would not also send.
# Prints the base URL on stdout.
serve_static() {
    local dir="$1"
    local port
    port=$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close();});')
    (cd "$dir" && exec python3 -m http.server "$port" --bind 127.0.0.1) >/tmp/probe-server.log 2>&1 &
    echo $! >/tmp/probe-server.pid
    for _ in $(seq 1 60); do
        if curl -fsS "http://127.0.0.1:${port}/" >/dev/null 2>&1; then
            echo "http://127.0.0.1:${port}"
            return 0
        fi
        sleep 0.25
    done
    echo "probe: static server never came up" >&2
    return 1
}

stop_static() {
    if [ -f /tmp/probe-server.pid ]; then
        kill "$(cat /tmp/probe-server.pid)" 2>/dev/null || true
        rm -f /tmp/probe-server.pid
    fi
}
trap stop_static EXIT
