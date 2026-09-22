#!/usr/bin/env bash
# Shared helpers for perf-search gates and calibration.
set -euo pipefail

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-perf-search}"
export PGPASSWORD=app
export PGPORT="${PGPORT:-5432}"
export DATABASE_URL="postgres://app:app@localhost:${PGPORT}/app"

# Seed scale the actor sees while working (setup-seed.sh).
SEED_CUSTOMERS_N="${SEED_CUSTOMERS_N:-500}"
SEED_PRODUCTS_N="${SEED_PRODUCTS_N:-50000}"
SEED_ORDERS_N="${SEED_ORDERS_N:-20000}"
HEAVY_ORDERS="${HEAVY_ORDERS:-50}"
LIGHT_ORDERS="${LIGHT_ORDERS:-3}"

# 10x seed scale used by the speed and memory gates, per the task design: the
# gate re-seeds at 10x the products the agent saw, both for baseline and for
# the submission, independently and sequentially. Only the product count is
# scaled. The untouched search pays one full order_items scan per matched
# product, so scaling orders too would push baseline from seconds to hours
# without telling us anything new.
SEED_CUSTOMERS_10X="${SEED_CUSTOMERS_10X:-$SEED_CUSTOMERS_N}"
SEED_PRODUCTS_10X="${SEED_PRODUCTS_10X:-$(( SEED_PRODUCTS_N * 10 ))}"
SEED_ORDERS_10X="${SEED_ORDERS_10X:-$SEED_ORDERS_N}"
HEAVY_ORDERS_10X="${HEAVY_ORDERS_10X:-$HEAVY_ORDERS}"
LIGHT_ORDERS_10X="${LIGHT_ORDERS_10X:-$LIGHT_ORDERS}"

# Retries for a while if the compose stack fails to come up cleanly, then
# gives up loudly.
compose_up() {
    local attempt
    for attempt in $(seq 1 40); do
        if docker compose up -d --wait --wait-timeout 60 postgres; then
            return 0
        fi
        docker compose down -v --remove-orphans >/dev/null 2>&1 || true
        sleep 5
    done
    echo "could not start postgres" >&2
    return 1
}

compose_down() {
    docker compose down -v --remove-orphans >/dev/null 2>&1 || true
}

psql_c() {
    psql -h localhost -p "$PGPORT" -U app -d app -v ON_ERROR_STOP=1 -Atqc "$1"
}

install_deps() {
    bun install --silent
}

# seed_fixed: seeds at the scale the actor saw (setup-seed.sh scale).
seed_fixed() {
    SEED_CUSTOMERS="$SEED_CUSTOMERS_N" SEED_PRODUCTS="$SEED_PRODUCTS_N" SEED_ORDERS="$SEED_ORDERS_N" \
        HEAVY_CUSTOMER_ORDERS="$HEAVY_ORDERS" LIGHT_CUSTOMER_ORDERS="$LIGHT_ORDERS" \
        bun run seed
}

# seed_10x: seeds at 10x the product count the actor saw, for the speed and
# memory gates.
seed_10x() {
    SEED_CUSTOMERS="$SEED_CUSTOMERS_10X" SEED_PRODUCTS="$SEED_PRODUCTS_10X" SEED_ORDERS="$SEED_ORDERS_10X" \
        HEAVY_CUSTOMER_ORDERS="$HEAVY_ORDERS_10X" LIGHT_CUSTOMER_ORDERS="$LIGHT_ORDERS_10X" \
        bun run seed
}

# Starts `bun run src/server.ts` in the current directory on $1 (default 3000),
# waits for /health, and sets SERVER_PID.
start_server() {
    local port="${1:-3000}"
    PORT="$port" DATABASE_URL="$DATABASE_URL" bun run src/server.ts >/tmp/perf-search-server-$$.log 2>&1 &
    SERVER_PID=$!
    for _ in $(seq 1 150); do
        if ! kill -0 "$SERVER_PID" 2>/dev/null; then
            # Our process died (most likely the port is taken), so a healthy
            # answer on this port would be somebody else's server.
            echo "server on :$port exited during startup" >&2
            cat "/tmp/perf-search-server-$$.log" >&2 || true
            return 1
        fi
        if curl -s -o /dev/null "http://localhost:$port/health"; then
            sleep 0.3
            kill -0 "$SERVER_PID" 2>/dev/null || { echo "server on :$port is not ours" >&2; return 1; }
            return 0
        fi
        sleep 0.2
    done
    echo "server on :$port did not become healthy" >&2
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

# p95_ms <url> <samples> [cap_seconds]: sequential GETs, prints "p50 p95" in
# ms. Each request is capped at cap_seconds (default 20). A request that hits
# the cap, or answers with anything other than HTTP 200, is recorded as the
# full cap, so an error page can never count as a fast search.
p95_ms() {
    local url="$1"
    local n="${2:-15}"
    local cap="${3:-20}"
    local times=()
    for _ in $(seq 1 "$n"); do
        local out code t
        out=$(curl -s -o /dev/null --max-time "$cap" -w "%{http_code} %{time_total}" "$url" || true)
        code=$(echo "$out" | awk '{print $1}')
        t=$(echo "$out" | awk '{print $2}')
        if [ "$code" != "200" ]; then
            t="$cap"
        fi
        times+=("$(bun -e "console.log(Math.round(${t} * 1000))")")
    done
    printf '%s\n' "${times[@]}" | sort -n > /tmp/perf-search-times-$$.txt
    local count
    count=$(wc -l < /tmp/perf-search-times-$$.txt)
    local p50_idx=$(( (count * 50 + 99) / 100 ))
    local p95_idx=$(( (count * 95 + 99) / 100 ))
    [ "$p50_idx" -lt 1 ] && p50_idx=1
    [ "$p95_idx" -lt 1 ] && p95_idx=1
    [ "$p95_idx" -gt "$count" ] && p95_idx=$count
    local p50 p95
    p50=$(sed -n "${p50_idx}p" /tmp/perf-search-times-$$.txt)
    p95=$(sed -n "${p95_idx}p" /tmp/perf-search-times-$$.txt)
    rm -f /tmp/perf-search-times-$$.txt
    echo "$p50 $p95"
}

# rss_kb <pid>: resident set size in KB, works on both Linux and macOS.
rss_kb() {
    ps -o rss= -p "$1" 2>/dev/null | tr -d ' '
}
