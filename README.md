# Workbench

**An open standard for packaging expert AI environments.**

A model is capable. A Workbench makes it prepared.

Workbenches package the expertise, runner, model, tools, skills, integrations,
runtime, and authorization requirements needed to perform a specific class of
work. They give maintainers a portable way to publish not only documentation,
but an executable expert environment for their project.

Instead of asking an AI to discover a project's architecture, conventions,
CLI, development environment, and operating procedures while it is already
trying to complete a task, a maintainer can publish that knowledge once:

```text
.workbenches/
  core/
    workbench.yml
    instructions.md
    skills/
```

Any compatible host can then resolve the package, verify its requirements, and
translate it into the selected runner's native interface.

Workbench is not another agent framework. The standard does not define a DAG,
task planner, chat product, or orchestration system. It defines the versioned,
portable package that prepares an AI to do the work. Products can build their
own workflows and interfaces around that package.

## What a Workbench contains

A Workbench can declare:

- Maintainer-authored instructions
- A runner and model selected for the work
- Portable, on-demand skills
- Required CLI tools
- Remote MCP integrations
- Environment-variable requirements without embedded secret values
- A local or isolated runtime and, where supported, an image

The manifest is intentionally small:

```yaml
spec: 0
version: 0.1.0

name: migrations
description: Design, review, and safely apply project migrations.

runner: opencode
model: openrouter/openai/gpt-5.6-terra

instructions: ./instructions.md
skills:
  - ./skills/migrations

tools:
  - cargo
  - lux

mcps:
  - name: lux
    transport: http
    url: https://api.example.com/mcp
    headers:
      Authorization: Bearer ${LUX_TOKEN}

env:
  LUX_TOKEN:
    required: false

runtime: local
```

The Workbench engine reads this file. The selected runner does not. The engine
validates and resolves the package, prepares the runtime, verifies its declared
requirements before model execution, and translates the canonical Workbench
into the runner's native configuration.

## Reference CLI

This repository contains `workbench`, also available as `wb`: the TypeScript
reference engine and command-line client for the standard.

The project is in public pre-alpha development. The draft-0 format, local
runtime, and OpenCode adapter are implemented. The format is not yet stable,
and other runners and isolated runtimes are not yet supported by the reference
engine.

### Install a release

Once the first alpha is published, release binaries will be available for macOS
and Linux on arm64 and x64. Inspect the installer before running it:

```sh
curl -fsSLO https://raw.githubusercontent.com/pompeii-labs/workbenches/main/install.sh
less install.sh
sh install.sh
rm install.sh
```

The installer selects the native archive, verifies its published SHA-256
checksum, installs `workbench` to `~/.local/bin` by default, and creates the `wb`
alias. It never invokes `sudo` or edits shell startup files. Use `--version` to
install a specific release and `--bin-dir` to choose another destination.

### Create a Workbench

Run `init` from a repository root to create `.workbenches/<name>`:

```sh
wb init core
wb init migrations --runner opencode --model openrouter/openai/gpt-5.6-terra
```

### Discover and save Workbenches

Local paths, GitHub URLs, and GitHub repository slugs are accepted:

```sh
wb list .
wb list /path/to/repository
wb list https://github.com/owner/repository
wb list owner/repository

wb validate owner/repository
wb smoke owner/repository
wb add owner/repository#core
```

Remote inspection uses the GitHub API and does not clone or create a temporary
checkout. `add` is the explicit installation boundary: it saves only the
selected Workbench package as a content-addressed local snapshot.

Saved packages can be inspected and managed without returning to their source:

```sh
wb list
wb view project-core
wb view project-core --json
wb remove project-core
```

### Run a task

Pass a positional task or use `--task` for a one-shot run:

```sh
wb run project-core "Explain the storage architecture"
wb run project-core --task "Review this migration"
```

The default output is a colorized, terminal-safe Markdown stream normalized
across runners. For integrations, `--json` emits the runner-neutral Workbench
event protocol as NDJSON. `--final` emits only the final assistant response.

```sh
wb run project-core --task "Review this migration" --json
wb run project-core --task "Review this migration" --final
```

Use `--dry-run` to inspect the translated runner invocation without executing
it:

```sh
wb run project-core --task "Review this migration" --dry-run
```

### Detach, attach, and cancel

```sh
wb run project-core --task "Perform the migration" --detach
# wb_...

wb attach wb_...
wb attach              # latest dispatched run
wb attach wb_... --json
wb kill wb_...
wb kill                # latest active detached run
```

Detached runs persist their normalized events. Attaching replays existing
events before following new ones. Cancellation cooperatively terminates the
runner and records a terminal `run.cancelled` event.

### Interactive client

Running `wb`, `workbench`, or `wb run <name>` without a task opens the
experimental terminal client:

```sh
wb
wb run project-core
```

The OpenCode interactive adapter currently supports multi-turn context,
streaming, cancellation, tool events, and explicit permission decisions. It is
not durable: interactive sessions cannot yet be detached, recovered, or steered
while a turn is active.

## Source and authorization boundaries

Remote `list`, `validate`, and `smoke` operations are read-only. Public GitHub
repositories require no credentials. Private repositories can use
`GITHUB_TOKEN` or `GH_TOKEN`; inaccessible private repositories and missing
repositories are reported without pretending GitHub distinguishes them.

Environment values never belong in `workbench.yml`. A manifest declares their
names and whether they are required; the person or host starting the run
provides the values. Dry runs, saved package metadata, and normalized events do
not expose those values.

For `runtime: local`, declared tools must exist on the host. Future Docker and
hosted runtimes must perform the same checks inside the provisioned environment.
Preflight failure stops execution before model tokens are spent.

## Specification and documentation

- [SPEC.md](SPEC.md) defines the draft-0 Workbench package.
- [docs/EXECUTION.md](docs/EXECUTION.md) defines the draft-0 execution protocol.
- [docs/SOURCES.md](docs/SOURCES.md) documents reference-engine source and
  workspace behavior.
- [docs/RELEASING.md](docs/RELEASING.md) documents the versioned binary release
  process.
- [`schemas/`](schemas) contains the normative JSON Schemas.

The specification and schemas are the interoperability contract. The CLI is a
reference implementation, not the only permitted host.

## Development

The reference CLI uses strict TypeScript, Citty, and Bun. From a clean checkout:

```sh
bun install --frozen-lockfile
bun run check
bun run test:coverage
bun run build
```

`bun run check` runs type checking, Biome, and the unit and integration suite.
The compiled `dist/workbench` binary is self-contained and does not require Bun
on the target machine. Distribution builds include the repository license and
notice.

Both `workbench` and `wb` are package binary names. Commits use Conventional
Commits and are checked by the repository's `commit-msg` hook and CI.

## License

The source code, schemas, conformance fixtures, specification, and documentation
in this repository are licensed under the [Apache License 2.0](LICENSE) unless a
file states otherwise. Workbench packages published by other projects are
independent works and remain subject to the licenses chosen by their publishers.
