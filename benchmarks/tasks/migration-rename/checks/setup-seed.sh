#!/usr/bin/env bash
set -euo pipefail
source "$CHECKS_DIR/lib.sh"

compose_up
install_deps
bun run migrate
bun run seed
echo "setup: live database ready"
