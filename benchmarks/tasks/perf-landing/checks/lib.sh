#!/usr/bin/env bash
# Shared helpers for perf-landing gates and calibration.
set -euo pipefail

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-perf-landing}"
export PGPASSWORD=app
export PGPORT="${PGPORT:-5432}"
export SERVER_PORT="${SERVER_PORT:-3000}"
export DATABASE_URL="postgres://app:app@localhost:${PGPORT}/app"

SEED_PRODUCTS_N="${SEED_PRODUCTS_N:-50}"
SEED_CUSTOMERS_N="${SEED_CUSTOMERS_N:-20}"
SEED_ORDERS_N="${SEED_ORDERS_N:-50}"


compose_up() {
    docker compose up -d --wait --wait-timeout 60 postgres
    local cid
    cid="$(docker compose ps -q postgres)"
    if [ -z "$cid" ]; then
        echo "compose_up: postgres container did not start for project $COMPOSE_PROJECT_NAME" >&2
        return 1
    fi
    local container_status
    container_status="$(docker inspect -f '{{.State.Status}}' "$cid")"
    if [ "$container_status" != "running" ]; then
        echo "compose_up: postgres container status is '$container_status' (not running) for project $COMPOSE_PROJECT_NAME" >&2
        docker compose logs postgres >&2 || true
        return 1
    fi
}

compose_down() {
    docker compose down -v --remove-orphans >/dev/null 2>&1 || true
}

install_deps() {
    bun install --silent
}

# Installs the checks/ folder's own devDependencies (playwright-core etc.),
# separate from the fixture's own node_modules. node_modules is not shipped
# (see checks/.gitignore), so this must run before the first use in a fresh
# checkout; guarded to skip once it's already present.
install_check_deps() {
    [ -d "$CHECKS_DIR/node_modules" ] && return 0
    (cd "$CHECKS_DIR" && bun install --frozen-lockfile --silent)
}

seed_fixed() {
    SEED_CUSTOMERS="$SEED_CUSTOMERS_N" SEED_PRODUCTS="$SEED_PRODUCTS_N" SEED_ORDERS="$SEED_ORDERS_N" \
        HEAVY_CUSTOMER_ORDERS=2 LIGHT_CUSTOMER_ORDERS=1 \
        bun run seed
}

# Starts `bun run src/server.ts` in the current directory on $1 (default 3000),
# waits for /health, and sets SERVER_PID.
start_server() {
    local port="${1:-$SERVER_PORT}"
    PORT="$port" DATABASE_URL="$DATABASE_URL" bun run src/server.ts >/tmp/perf-landing-server-$$.log 2>&1 &
    SERVER_PID=$!
    for _ in $(seq 1 100); do
        if curl -s -o /dev/null "http://localhost:$port/health"; then
            return 0
        fi
        sleep 0.2
    done
    echo "server on :$port did not become healthy" >&2
    cat "/tmp/perf-landing-server-$$.log" >&2 || true
    return 1
}

stop_server() {
    [ -n "${SERVER_PID:-}" ] || return 0
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
}

# Materializes the fixture's `baseline` git tag into $1, a fresh directory.
baseline_checkout() {
    local dest="$1"
    mkdir -p "$dest"
    git archive baseline | tar -x -C "$dest"
}

# measure_page <url> <out-json> [screenshot-path] [--no-throttle]
# Runs checks/measure.ts against a URL with a headless Chromium under mobile
# emulation, a slow-4G-like network throttle, and 4x CPU throttle. Writes
# {lcp, cls, bytes} as JSON to <out-json>, and optionally a PNG screenshot.
measure_page() {
    local url="$1"
    local out_json="$2"
    local screenshot="${3:-}"
    local extra="${4:-}"
    (cd "$CHECKS_DIR" && bun run measure.ts "$url" "$out_json" "$screenshot" $extra)
}

json_field() {
    bun -e "console.log(JSON.parse(require('fs').readFileSync('$1','utf8'))['$2'])"
}
