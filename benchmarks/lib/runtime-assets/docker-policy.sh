#!/usr/bin/env bash
# Applies only to the harness launcher inside a private benchmark daemon.
# Product packages use their own Docker CLI. Keep nested runner networking equal
# to the plain runner so local product CLIs can reach sibling services.
set -euo pipefail
real_docker="${DOCKER_REAL:-/usr/local/libexec/docker-real}"
args=("$@")

if [[ "${1:-}" == port && "${3:-}" =~ ^([0-9]+)/tcp$ ]]; then
    port="${BASH_REMATCH[1]}"
    mode=$("$real_docker" inspect --format '{{.HostConfig.NetworkMode}}' "$2")
    if [[ "$mode" == host ]]; then
        # Host networking has no published-port mapping. The launcher and runner
        # share this private namespace, so resolve the requested loopback port.
        printf '127.0.0.1:%s\n' "$port"
        exit 0
    fi
fi

if [[ "${1:-}" == run ]]; then
    for ((i=0; i<${#args[@]}-1; i++)); do
        if [[ "${args[$i]}" == --network && "${args[$((i+1))]}" == bridge ]]; then
            args[$((i+1))]=host
        elif [[ "${args[$i]}" == --network=bridge ]]; then
            args[$i]=--network=host
        fi
    done
fi
exec "$real_docker" "${args[@]}"
