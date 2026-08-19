# Workbench

Workbench is an open format and reference engine for repository-owned execution
recipes. A Workbench packages the expertise and environment needed to work on a
class of problems, then names the runner that should execute it.

This repository is an early experiment. It is not yet a stable specification or
a working general-purpose runtime.

The v0 execution direction is a managed interactive session rather than a raw
child process. The same runner-neutral handle is intended to support streamed
one-shot runs, detached runs, and a future uniform `wb chat` terminal interface.

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

Run a Workbench with:

```sh
bun run src/cli.ts run /path/to/repo#name \
  --task "Describe or perform the work"
```

Discover, verify, save, and remove packages with:

```sh
wb list /path/to/repo
wb list owner/repo
wb validate /path/to/repo
wb smoke /path/to/repo
wb add owner/repo#name
wb list --saved
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
[docs/SOURCES.md](docs/SOURCES.md) for source/target behavior,
[docs/MODEL_SELECTION.md](docs/MODEL_SELECTION.md) for model evaluation, and
[ROADMAP.md](ROADMAP.md) for the release gap.

The current OpenCode command still emits raw runner JSON and is one-shot. The
runner-neutral managed session types exist, but live OpenCode sessions and the
uniform chat UI are not wired yet.

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
