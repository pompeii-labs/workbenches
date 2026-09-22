#!/usr/bin/env bash
# Export every Godot reference solution into references/<name>-built/ so
# calibrate can grade it. References are committed as project source only;
# a Godot submission is only gradable with its web export, and calibrate
# grades <name>-built in place of <name> when both exist. Exports use the
# godot-web-games Workbench image and its own game-export tool, the same
# toolchain the Workbench arm has. naive-no-export (marked .skip-export) is
# left as source on purpose: shipping no build is the failure it models.
#
# Usage, from benchmarks/: bash scripts/build-godot-references.sh
# Needs Docker on linux/amd64 (the image pins amd64 downloads).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

IMAGE="wbm-godot-refbuild:local"
trap 'docker rmi "$IMAGE" >/dev/null 2>&1 || true' EXIT
docker build -q -t "$IMAGE" .workbenches/godot-web-games >/dev/null

status=0
for task in tasks/godot-*/; do
    for src in "$task"references/*/; do
        ref=$(basename "$src")
        case "$ref" in *-built) continue ;; esac
        [ -f "$src/.skip-export" ] && continue
        out="${task}references/$ref-built"
        rm -rf "$out"
        mkdir -p "$out"
        cp -R "$src". "$out"/
        if docker run --rm --user "$(id -u):$(id -g)" \
            -v "$PWD/$out:/work/project" "$IMAGE" \
            bash -c "cd /work/project && game-export /work/project /work/project/build/web" >/dev/null 2>&1; then
            echo "built $out"
        else
            echo "FAILED $out"
            status=1
        fi
    done
done
exit $status
