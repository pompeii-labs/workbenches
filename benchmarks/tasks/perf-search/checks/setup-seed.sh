#!/usr/bin/env bash
# Brings up the fixture database and loads it at the scale the actor sees,
# leaving Postgres running for the actor to inspect. Runs once, before the
# actor starts.
set -euo pipefail
source "$CHECKS_DIR/lib.sh"

compose_up
install_deps
bun run migrate
seed_fixed
echo "setup: storefront database ready (products: $SEED_PRODUCTS_N)"
