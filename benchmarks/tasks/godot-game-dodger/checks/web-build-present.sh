#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/lib/common.sh"

if ! result=$(find_build 2>/tmp/find-build.err); then
    echo "FAIL: $(cat /tmp/find-build.err)"
    exit 1
fi
dir=$(printf '%s' "$result" | cut -f1)
html=$(printf '%s' "$result" | cut -f2)
echo "PASS: web export found (${html} + matching .wasm/.pck) under ${dir#"$PWD"/}"
