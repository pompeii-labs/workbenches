#!/usr/bin/env bash
# Shared helpers for the migration gates and calibration.
set -euo pipefail

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-orders-svc}"
export PGPASSWORD=app
export DATABASE_URL="postgres://app:app@localhost:5432/app"

compose_up() {
    docker compose up -d --wait --wait-timeout 60 postgres
}

compose_down() {
    docker compose down -v --remove-orphans >/dev/null 2>&1 || true
}

psql_c() {
    psql -h localhost -U app -d app -v ON_ERROR_STOP=1 -Atqc "$1"
}

install_deps() {
    bun install --silent
}
