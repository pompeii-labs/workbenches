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
node "$DIR/lib/probe.mjs" survive "${base_url}/${html}"
