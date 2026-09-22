#!/usr/bin/env bash
# Brings the live fixture database up and loads it, leaving Postgres running
# for the actor to inspect. Runs once, before the actor starts.
set -euo pipefail
source "$CHECKS_DIR/lib.sh"

compose_up
install_deps
bun run migrate
bun run seed
echo "setup: live database ready"
