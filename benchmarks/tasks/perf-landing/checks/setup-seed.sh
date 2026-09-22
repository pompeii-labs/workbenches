#!/usr/bin/env bash
# Brings up the fixture database and loads a modest amount of data, leaving
# Postgres running for the actor to inspect. Runs once, before the actor
# starts. This task is about the landing page's front-end weight, not the
# database, so scale stays small.
set -euo pipefail
source "$CHECKS_DIR/lib.sh"

compose_up
install_deps
bun run migrate
seed_fixed
echo "setup: storefront database ready"
