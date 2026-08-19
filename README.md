# Workbench

Workbench is an open format and reference engine for repository-owned execution
recipes. A Workbench packages the expertise and environment needed to work on a
class of problems, then names the runner that should execute it.

This repository is an early experiment. It is not yet a stable specification or
a general-purpose multi-runner runtime.

The v0 execution contract is a versioned, runner-neutral event stream. OpenCode
one-shot runs can currently stream in the foreground or continue as durable
detached runs. The same contract will support a uniform interactive terminal UI;
that UI is deliberately still a stub.

## Current experiment

The current local slice supports:

- `runner: opencode`
- `runtime: local`
- A selected model
- A native OpenCode instruction file
- Portable, on-demand `SKILL.md` skills
- Optional authenticated remote MCP servers
- Required local CLI tools and environment variables
- Local discovery and read-only GitHub API inspection
- Content-addressed saved package aliases
- Static validation and token-free smoke preflight

Run a one-shot Workbench with human-readable streaming output:

```sh
wb run /path/to/repo#name --task "Describe or perform the work"
wb run saved-name "Describe or perform the work"
```

Select machine-readable NDJSON or final-answer-only output:

```sh
wb run saved-name --task "Describe the schema" --json
wb run saved-name --task "Describe the schema" --final
```

Human output uses color when stdout is an interactive terminal. `NO_COLOR` and
`--no-color` disable it; `--color` forces color when output is being captured.
Machine-readable and final-only output never contain ANSI formatting.

Dispatch a durable background run and attach to it later:

```sh
wb run saved-name --task "Perform the migration" --detach
# wb_...

wb attach wb_...
wb attach                 # latest dispatched run
wb attach wb_... --json
wb kill wb_...            # cancel a detached run
wb kill                   # latest active detached run
```

`--detach` prints only the run ID. Attached clients replay the persisted event
history and then follow live events until the run terminates. Cancellation is a
cooperative request to the detached worker, which terminates its harness and
records `run.cancelled`. `wb run <name>` without a task is reserved for the
interactive TUI and currently returns an explicit not-implemented error.

Discover, verify, save, and remove packages with:

```sh
wb list /path/to/repo
wb list owner/repo
wb validate /path/to/repo
wb smoke /path/to/repo
wb add owner/repo#name
wb list                    # saved Workbenches
wb list .                  # Workbenches published by the current repository
wb view saved-name         # resolved configuration and provenance
wb view saved-name --json  # same information for tools
wb remove saved-name
```

Remote `list`, `validate`, and `smoke` use the GitHub API in memory and never
clone or create a temporary checkout. `add` is the explicit operation that saves
selected package bytes. A remote package must be saved before `run`.

Inspect the translated OpenCode launch without executing it:

```sh
bun run src/cli.ts run /path/to/repo/.workbenches/name \
  --task "Describe or perform the work" \
  --dry-run
```

The Workbench engine reads `workbench.yml`. OpenCode does not. The engine
resolves the manifest and supplies instructions through OpenCode's native
configuration while sending the task separately as the user message. Declared
skills are staged for native OpenCode discovery, and remote MCP environment
references are translated without exposing their values in generated config.

See [SPEC.md](SPEC.md) for the format sketch,
[docs/EXECUTION.md](docs/EXECUTION.md) for execution,
[docs/RUNNER_COMPATIBILITY.md](docs/RUNNER_COMPATIBILITY.md) for researched
runner integration surfaces,
[docs/SOURCES.md](docs/SOURCES.md) for source/target behavior,
[docs/MODEL_SELECTION.md](docs/MODEL_SELECTION.md) for model evaluation, and
[ROADMAP.md](ROADMAP.md) for the release gap.

OpenCode is the only live adapter. Its native JSON is normalized into Workbench
events; arbitrary runner payloads are intentionally not copied into portable
output. Detached cancellation is implemented. Multi-turn input, steering, and
the uniform TUI are not wired yet.

## Development

The CLI is written in strict TypeScript using [Citty](https://unjs.io/packages/citty/)
for command parsing and help generation, with Bun as the development runtime and
standalone-binary compiler.

```sh
bun install
bun run check
bun run test:coverage
bun run build
```

`bun run check` runs type checking, Biome, and all unit and integration tests.
Coverage is enforced per source file. The compiled `dist/workbench` binary is
self-contained and does not require Bun on the target machine.

Both `workbench` and `wb` are package binary names. Commits use Conventional
Commits and are checked by the repository's `commit-msg` hook and CI.
