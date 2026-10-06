# Gates

A gate is the package's executable definition of done. It is the single most important file in a Workbench. A package without one is asking the model to grade its own work by feel.

## Properties

1. **One command.** `gate [dir]`. A script shipped inside the package is not on PATH: keep it under a skill's `scripts/` and invoke it by the path in the next section, or install it on PATH in the image and declare it in `tools`.
2. **Builds and runs the real thing.** Compile, test, serve, launch the simulator, apply the migration to a scratch database. Evidence comes from the running result, never from reading the source.
3. **Manifest-driven.** The work declares up front what must be proven (states, viewports, screens, migrations, endpoints) in a file such as `artifacts/evidence.json` or a table in the design artifact. The gate fails when a declared item has no evidence, and when evidence exists for an item that was not declared. A failing item cannot be made to pass by deleting it.
4. **Numbered runs.** Each invocation writes `run-<n>` and records the run number in its summary; a `--next` flag advances it. History cannot be rewritten to hide a failure.
5. **Machine-readable summary.** Writes a JSON summary (per-item pass or fail and the reason) next to the evidence, and prints one line per item.
6. **Exit code is the verdict.** Non-zero on any failure, including infrastructure failures the work must fix.
7. **Cleans up after itself.** Stops servers, deletes simulators, removes scratch databases, even when it fails.
8. **Cheap to read.** Produces contact sheets, a summary, or a short `review.md` checklist, so the model inspects evidence without opening every artifact.

## Where the package is during a run

The shell's working directory is the target workspace, not the package. The engine copies each declared skill to `skills/<skill-name>/` inside a staged config directory and exports that directory to the runner: `OPENCODE_CONFIG_DIR` for OpenCode, `PI_CODING_AGENT_DIR` for Pi. This is the same on `local`, `docker`, `e2b`, and `daytona`. The directory is a temporary path that changes every run and is read-only, so never hard-code it and never write into it. Write the invocation into the skill or the instructions with the variable, run the script through its interpreter, and pass the workspace as the directory:

```bash
bash "$OPENCODE_CONFIG_DIR/skills/proof/scripts/gate" .
```

Pi on Docker with a credential volume is the one case where `PI_CODING_AGENT_DIR` is `/tmp/workbench-pi`, a copy of the same staged directory. The engine sets no other variable for the package location. In the first trial, have the run print the variable once to confirm the shell sees it.

## The required look

After the gate passes, the instructions require the model to open the evidence and judge it against the rubric, and to record findings in a review file the gate created. Add the prior: "A review with no findings on a first pass is almost always a review that did not look." A pass with an ugly, wrong, or empty result is a defect: fix it, advance the run number, and gate again.

## Naming the cheats

Every gate invites a shortcut. Name it in the instructions as a rule:

- Never remove a failing item from the manifest.
- Test hooks drive real states. Never short-circuit them to satisfy a capture.
- Never edit the gate, its config, or its outputs.
- Never hard-code the data a check reads.

## Skeleton

```bash
#!/usr/bin/env bash
# gate: build, run, capture, check. Exit 0 is done.
set -euo pipefail
dir="${1:-.}"
cd "$dir"
manifest="artifacts/evidence.json"
[ -f "$manifest" ] || { echo "FAIL manifest: $manifest is missing"; exit 1; }
run="$(cat artifacts/run 2>/dev/null || echo 1)"
[ "${2:-}" = "--next" ] && run=$((run + 1))
echo "$run" > artifacts/run
out="artifacts/run-$run"
rm -rf "$out" && mkdir -p "$out"
cleanup() { stop_servers; }
trap cleanup EXIT

build_project            # compile and test; any failure is a FAIL line
start_server_background  # never foreground
capture_every_item "$manifest" "$out"
check_items "$manifest" "$out" > "$out/summary.json"
print_lines "$out/summary.json"
all_passed "$out/summary.json"
```

Replace each placeholder function with the domain's real commands. Keep the gate in the package, versioned with it.
