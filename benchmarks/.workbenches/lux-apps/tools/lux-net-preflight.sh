# Shared by lux-up and lux-upgrade-check.
#
# `lux start` runs the local engine as a sibling container on the host
# Docker engine (docker.engine.mode: host in workbench.yml), then this
# container waits for it and later talks to it over 127.0.0.1. That only
# works if this container can reach its own siblings' published ports over
# loopback. On the ordinary bridge network Docker gives this container,
# it cannot: sibling ports land on the real Docker host's network, not on
# this container's loopback. There is no fix available from inside this
# image (no NET_ADMIN, no --network host), so detect it up front and bail
# with one line instead of leaving `lux start` to hang and time out, or
# leaving a half-started engine behind.
#
# Usage: . lux-net-preflight.sh "$0" (or a fixed tool name) before doing
# anything else that assumes the local engine is reachable.
lux_net_preflight() {
    tool="${1:-lux-up}"
    fail() {
        echo "$tool: cannot run here ($1). Skip this tool; do not try to repair it." >&2
        exit 1
    }

    [ "${WORKBENCH_DOCKER_ENGINE:-}" = "host" ] || return 0

    command -v docker >/dev/null 2>&1 || fail "docker CLI missing for the declared host engine binding"
    docker version >/dev/null 2>&1 || fail "host Docker engine is not reachable"

    img=$(docker inspect --format '{{.Config.Image}}' "$(hostname)" 2>/dev/null || true)
    [ -n "$img" ] || return 0

    probe="lux-net-probe-$$"
    docker run -d --rm --name "$probe" -p 127.0.0.1::8000 "$img" python3 -m http.server 8000 >/dev/null 2>&1 || true
    port=$(docker port "$probe" 8000/tcp 2>/dev/null | head -1 | cut -d: -f2)

    reachable=1
    if [ -n "$port" ]; then
        for _ in $(seq 10); do
            curl -sf -m 1 "http://127.0.0.1:$port/" >/dev/null 2>&1 && { reachable=0; break; }
            sleep 0.3
        done
    fi
    docker rm -f "$probe" >/dev/null 2>&1 || true

    [ "$reachable" -eq 0 ] || fail "this container cannot reach its own sibling containers' published ports over loopback, so the local Lux engine can never become reachable here"
}
