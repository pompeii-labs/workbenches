# workbenchmark

Run the same natural-language request with a plain coding agent and with a
Workbench (packaged expertise), grade the result by running it, and compare
working results, time, tokens, and cost per working result.

The published numbers on workbenches.dev come from this directory. The
methodology, the results, the caveats, and the per-task fail reasons are
in [METHODOLOGY.md](./METHODOLOGY.md).

## Quick start

From this directory:

```sh
bun install --frozen-lockfile --ignore-scripts
bun workbenchmark.ts list
bun workbenchmark.ts check
bun workbenchmark.ts images --wb /path/to/linux-amd64/wb
bun workbenchmark.ts smoke
bun --env-file=.env workbenchmark.ts run --campaign first-run --tasks example-hello --reps 1
bun workbenchmark.ts report --campaign first-run
```

`run`, `regrade`, and `calibrate` need a Linux Docker engine with privileged
container support and `OPENROUTER_API_KEY` in the environment: only `run`
calls a model, but the engine checks the key when it prepares a runtime.
Keep the key in an ignored `.env` file, never in a task, a Workbench
manifest, or a command argument. `list`, `check`, `report`, `monitor`, and
`images` need neither; `smoke` exercises the private daemon and package
validation without a model call.

## CLI

| Command | What it does |
| --- | --- |
| `list` | List the tasks in `tasks/`. |
| `check [--tasks a,b] [--wb path]` | Validate task and Workbench definitions; with `--wb`, also validate manifests with the engine. |
| `images --wb <linux amd64 wb binary>` | Build the generic agent image (plain arm) and the engine launcher image. |
| `smoke` | Start a private Docker daemon, stage every package, build nothing else. No model calls. |
| `run --campaign NAME [--tasks a,b] [--arms plain,workbench] [--models v/m] [--reps N] [--parallel N] [--cold]` | Run attempts. Every task x arm x model x rep is one attempt in its own daemon. Campaign names must be new; attempts are never overwritten or retried. |
| `report --campaign NAME` | Aggregate one campaign into `results/NAME/{matrix.md,matrix.json,bars.json}`. |
| `report --campaigns a,b,c [--out NAME]` | Merge campaigns cell by cell (task x model x arm); for each cell the last listed campaign that contains it wins, never a mix. Writes `sources` into the output. |
| `regrade --campaign NAME [--tasks a,b]` | Re-run the gates on saved submissions. No model calls. Used after a gate is fixed. |
| `calibrate [--tasks a,b] [--reference name]` | Grade every reference solution in `tasks/<id>/references/` (or one, by name) through the real harness. No model calls. |
| `monitor --campaign NAME [--once] [--json]` | Watch a running campaign, read-only. |

Common options: `--tasks-dir`, `--workbenches-dir`, `--results-dir`,
`--work-dir`, `--image-cache`. Remote execution: `--ssh ALIAS --remote-dir
/path` on `run`, `regrade` and `calibrate` runs the installed copy on that
host and pulls results back; the target is remembered per campaign.

## Reproducing the published numbers

You need a Linux amd64 machine with Docker (privileged containers allowed),
Bun 1.4, a Linux build of the `wb` CLI, and an OpenRouter key in `.env`.
The published run took about $10 per arm at five attempts per task, and a
few hours per arm one attempt at a time.

```sh
git clone https://github.com/pompeii-labs/workbenches && cd workbenches/benchmarks
bun install --frozen-lockfile --ignore-scripts
bun workbenchmark.ts images --wb /path/to/linux-amd64/wb
bun workbenchmark.ts smoke
bash scripts/build-godot-references.sh
bun --env-file=.env workbenchmark.ts calibrate --tasks all
bun --env-file=.env workbenchmark.ts run --tasks all --reps 5 --parallel 1 --campaign mine
bun workbenchmark.ts report --campaign mine
```

`calibrate` grades every reference solution of every task without a model
call and is the check that the gates still discriminate on your machine:
every `expert` reference must pass, every other reference must fail. Godot
references are committed as project source; `build-godot-references.sh`
exports them into ignored `references/<name>-built/` directories with the
Workbench's own toolchain, and calibrate grades the built copy. The
performance gates compare against a baseline measured in the same run, so
slower hardware changes absolute numbers, not verdicts. Compare your
`bars.json` against the table in [METHODOLOGY.md](./METHODOLOGY.md).

The published numbers were produced by `report --campaigns
launch-1,v11-a,v12-c`. The plain arm's cells come from the first campaign
and were never re-run. Each time a Workbench changed, its cells were re-run
in full in a new campaign, and the latest campaign's attempts replaced the
earlier ones for that cell. The Workbenches in `.workbenches/` are the ones
that produced every Workbench number.

## Adding a task

```text
tasks/my-task/
  task.json
  prompt.md
  fixture/             optional local starting project
  checks/              gate scripts, never copied into the project
  references/expert/   a known-good solution, for calibrate
  references/<other>/  known-bad solutions (naive, naive-badkeys, ...) that must fail a gate
```

See `tasks/example-hello/` for a complete minimal task. Its `task.json`:

```json
{
  "version": 1,
  "id": "example-hello",
  "title": "Add a health check endpoint to a tiny HTTP server",
  "workbench": "example",
  "fixture": { "kind": "dir", "path": "fixture" },
  "timeoutMinutes": 10,
  "gates": [
    { "id": "health-endpoint", "title": "GET /health returns ok", "run": "bash ./checks/health-check.sh" }
  ]
}
```

`fixture` can also be `{ "kind": "empty" }` or a git repository (`url`, full
`commit` SHA, optional `subdir`/`overlay`); the starting project gets a
`baseline` git tag. `prompt.md` is a plain user request; both arms receive
identical text. Optional `setup` runs in the generic image before the agent
starts and must install any product CLI the task needs, for both arms;
`boot` installs and starts the submission before grading.

`gates` are shell commands run against the submission after the attempt
(`./checks/foo.sh` resolves against a staged copy of `checks/`, exposed as
`CHECKS_DIR`, so the agent never sees them). Write gates that test the
running outcome, not the code: start the app, drive it, measure it. Every
published task is gate-only. A task may instead or additionally list
`criteria`, plain-English behaviors judged by the `grader` Workbench; no
published task uses them.

Before a task counts: under `calibrate`, the `expert` reference passes
every gate, each other reference fails the gate it was written to trip,
and an untouched fixture fails. Read every fail's evidence yourself before trusting
a verdict; a gate that fails both arms is a suspect gate first.

## Adding a Workbench

A Workbench lives at `.workbenches/<name>/` with `workbench.yml`,
`instructions.md`, optional `skills/`, and a `Dockerfile` it owns (see
`.workbenches/example/`). There are no task-level Dockerfiles: the Workbench
supplies the runtime, tools, instructions, and skills. The plain arm runs an
ephemeral control package on the generic agent image with no skills, tools,
or instructions beyond the request. Keep general expertise in a Workbench;
keep task names, fixture identifiers, and expected values out of it.

## Reading a result

Each attempt lives at `results/<campaign>/trials/<task>__<model>__<arm>__<rep>/`:

```text
result.json          status, per-gate verdicts with evidence, metrics
prompt.md            the request the agent received
events.ndjson        the agent's tool calls and messages
native-trace.json    the runner's own trace, with token usage
submission.tar.gz    the project as the agent left it
grading/<gate>.log   the gate's full output
regrade-<ts>/        the same, for each later regrade
```

`report` writes `matrix.md` (every attempt, every gate) and `bars.json`
(per task and arm: passed, attempts, cost per working result, medians). A
submission **works** when every gate passes. **Actor dollars per working
result** is the total model cost of every attempt in a cell, failures
included, divided by the number of passing attempts; with zero passes it is
"never passed", never zero or infinite. Missing usage accounting is `null`,
never zero.

## Timing and runtime boundary

Both arms measure a prepared runtime: `wb run --dry-run` acquires the runtime
without calling a model (`preparation_ms`), and only the subsequent actor run
is timed. `--cold` includes acquisition instead. Neither includes generic
image builds or declared service-image preloads.

Both submissions are graded in the same product runtime, prepared without a
model call. Each attempt runs in its own private Docker daemon; grading
starts fresh in another. This isolates trial resources but is not a security
sandbox.

## Development

```sh
bun test lib
bun run typecheck
bun workbenchmark.ts check
```

Results, work directories, image caches, built reference exports and the
`wb` binary are gitignored and must not be committed. Historical result
formats are refused, not migrated: start a new campaign after a breaking
change.
