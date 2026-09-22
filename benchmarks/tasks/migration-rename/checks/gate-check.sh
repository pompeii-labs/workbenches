#!/usr/bin/env bash
set -euo pipefail
source "$CHECKS_DIR/lib.sh"

install_deps
bun run check
