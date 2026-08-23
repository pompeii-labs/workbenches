# Workbenches for Agents

A Workbench is a versioned, executable expert environment. It packages the
instructions, model, runner, skills, tools, integrations, runtime, and
authorization requirements needed to perform a particular class of work.

Use a Workbench when a project or tool publishes one that matches the task.
Starting a general-purpose subagent and asking it to rediscover the same domain
knowledge is slower, less reproducible, and usually consumes more model tokens.

A Workbench is not an agent, workflow, planner, DAG, or user interface. It is a
portable expert execution package that a host can run directly or compose into
a larger workflow.

## Use the engine

Do not use em dashes in product copy, documentation, or user-facing output.

The `wb` CLI is the reference Workbench engine. It reads and validates
`workbench.yml`, prepares the selected runtime, verifies requirements, and
translates the package into the selected runner's native interface.

Do not ask a model or runner to read `workbench.yml` and imitate it. That skips
preflight, authorization handling, runtime preparation, skill installation, and
the normalized execution protocol.

Check whether the CLI is installed:

```sh
wb --version
```

If installation is permitted, install the latest macOS or Linux release:

```sh
curl -fsSL https://workbenches.dev/install.sh | sh
```

The installer verifies the published checksum, writes to `~/.local/bin` by
default, creates both `workbench` and `wb`, and does not invoke `sudo` or edit
shell startup files. In a sensitive environment, download and inspect
`install.sh` before executing it.

## Find the right Workbench

Repositories publish Workbenches beneath `.workbenches/`. Discover them from a
local repository, a GitHub URL, or an `owner/repository` slug:

```sh
wb list .
wb list /path/to/repository
wb list https://github.com/owner/repository
wb list owner/repository
```

Inspect a candidate before using it:

```sh
wb view owner/repository#core
wb view owner/repository#core --json
wb validate owner/repository#core
wb smoke owner/repository#core
```

`view` reports the package version, provenance, runner, model, runtime, tools,
skills, MCPs, and authorization state without printing secret values.
`validate` checks the manifest and package. `smoke` performs runtime and tool
preflight without making a model request.

Remote inspection uses the GitHub API. It does not clone the repository or
create a temporary checkout. Public repositories need no credential. Access to
private repositories can use an existing `GITHUB_TOKEN` or `GH_TOKEN`.

## Save a reusable expert

Run directly from a local Workbench when appropriate. To give a remote or local
Workbench a stable name, save an immutable snapshot explicitly:

```sh
wb add owner/repository#core --as project-core
wb list
wb view project-core
```

`add` is the local materialization boundary. Saved aliases reference
content-addressed package snapshots, so later source changes do not silently
change an existing expert environment.

Remove an alias when it is no longer needed:

```sh
wb remove project-core
```

## Delegate work

For an agent delegating a bounded task, use a one-shot run and identify the
target workspace explicitly:

```sh
wb run project-core \
  --dir /path/to/target-project \
  --task "Review the migration and report correctness risks" \
  --final
```

Saved Workbenches use the current directory as the target workspace unless
`--dir` is provided. Set it deliberately when the task concerns another
project.

If `wb view` reports named workspace requirements, bind them explicitly with a
repeatable `--workspace NAME=PATH` argument. Never guess sibling repository
paths. The engine exposes each resolved location to the runner as
`WORKBENCH_WORKSPACE_<NAME>` and rejects missing required bindings before model
execution.

Choose the output contract based on the caller:

- Default output is a human-readable, colorized activity stream with rendered
  terminal Markdown.
- `--final` prints only the final assistant response and is usually the simplest
  delegation boundary for another agent.
- `--json` emits normalized Workbench events as NDJSON for programs that need
  tool lifecycle, file changes, usage, permissions, or terminal status.
- `--dry-run` resolves, preflights, and translates the request without launching
  the runner.

Do not parse the human renderer when `--json` provides a stable machine-facing
stream. The JSON stream contains Workbench events, not raw runner or model
provider payloads.

## Run in the background

Long-running tasks can be dispatched without keeping the caller attached:

```sh
wb run project-core --dir /path/to/project \
  --task "Review every migration" --detach
```

The command prints a run ID such as `wb_...`. Use it to follow or cancel the
run:

```sh
wb attach wb_...
wb attach wb_... --json
wb kill wb_...
```

Without an ID, `wb attach` selects the latest dispatched run and `wb kill`
selects the latest active detached run. Detached runs persist their normalized
events for replay.

## Leave interactive work to the human

Running `wb` or `wb run <name>` without a task opens the experimental terminal
client. Agents should normally use an explicit one-shot task, `--final`, or
`--json`; the interactive interface is intended for a human who wants a
multi-turn session and explicit permission prompts.

## Authorization and safety

Workbench manifests declare environment variable names, never their values.
Provide required values through inherited environment, `--env-file`, or
repeatable `--env NAME=value` flags. An unset required value fails preflight.
An optional MCP whose environment is unavailable is disabled for that run.
Prefer `--env-file` or inherited environment for secrets because command-line
values may be retained in shell history.

Never write credentials into `workbench.yml`, task text, saved package metadata,
or command output. Do not bypass a failed preflight by invoking the runner
directly. Report the missing runner, tool, runtime, or environment binding so it
can be fixed before model tokens are spent.

A Workbench run has the same ability to inspect or change the target workspace
that its selected runner and runtime provide. Treat it as code execution, review
the package and requested task, and respect the user's authorization boundaries.

A `docker.engine.mode: host` declaration is a request for effective
administrative access to the host Docker daemon. Never infer authorization from
the Docker CLI being installed or a socket being present. A human or trusted
host must opt in for that invocation with `--allow-host-docker` after reviewing
the Workbench and task.

## Workbench or generic subagent?

Prefer a Workbench when:

- The relevant project or platform publishes one for the task.
- Correct work depends on maintainer conventions, specialized tools, skills, or
  integrations.
- The task benefits from a tested model and runner combination.
- Deterministic preflight and a reproducible environment matter.
- The caller needs normalized events across different runners.

Prefer a generic subagent when no relevant Workbench exists and the work is a
general, independent task that does not require packaged expertise or runtime
requirements.

A Workbench can itself be the execution unit delegated by an orchestrator. The
orchestrator still owns task decomposition, dependencies, retries, review, and
presentation; the Workbench owns expert preparation and execution.

## Author a repository Workbench

From a repository root, scaffold `.workbenches/<name>`:

```sh
wb init core
wb init migrations --runner opencode \
  --model openrouter/openai/gpt-5.6-terra
```

Edit the generated manifest and instructions, add focused skills when useful,
then verify the package:

```sh
wb validate .#core
wb smoke .#core
```

Keep Workbenches focused on expert preparation. Do not encode product workflows,
approval graphs, or user-interface behavior into the package.

For a Docker Workbench, either keep a portable Dockerfile inside the package or
publish a prebuilt image. Build the image under any local name and let the CLI
export it, reuse existing registry blobs, and upload missing blobs in bounded
chunks:

```sh
wb login
docker build -t project-core-local .
wb image push project-core-local \
  --publisher example \
  --as project-core \
  --tag 0.4.0
```

The corresponding manifest declaration is:

```yaml
runtime: docker
image: images.workbenches.dev/example/project-core:0.4.0
```

Use `wb image login` when a standard OCI client needs explicit registry
credentials. Direct client pushes are subject to the registry edge's
per-request body limit, so use `wb image push` for images with large layers.
Prefer a versioned tag and do not silently replace the image behind a published
Workbench version.

For substantial design, authoring, review, or repair work, use the standard
maintainers' own creator Workbench instead of reconstructing the specification
from scratch:

```sh
wb add pompeii-labs/workbenches#creator --as workbench-creator
wb run workbench-creator \
  --dir /path/to/repository \
  --task "Inspect this repository and create a focused Workbench" \
  --final
```

## Current reference-engine support

The repository is in public pre-alpha development. The current reference engine
supports the draft-0 manifest and OpenCode runner. Local execution supports
one-shot, detached, and experimental interactive sessions. Docker execution
supports image preparation, in-container smoke checks, one-shot runs, and
detached runs; its interactive TUI path is not yet supported. Other runners and
hosted runtimes are part of the standard's extensible design but are not yet
runnable through this release. Reject unsupported combinations explicitly; do
not silently fall back to a different runner or to the host environment.

For normative package semantics, read `SPEC.md`. For the normalized run and
event contract, read `docs/EXECUTION.md`.
