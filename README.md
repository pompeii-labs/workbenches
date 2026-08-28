<p align="center">
  <img src="./assets/brand/workbench-mark-woodcut.png" alt="Workbench" width="220">
</p>

# Workbench

[![CI](https://github.com/pompeii-labs/workbenches/actions/workflows/ci.yml/badge.svg)](https://github.com/pompeii-labs/workbenches/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/pompeii-labs/workbenches?include_prereleases)](https://github.com/pompeii-labs/workbenches/releases)

**An open standard for packaging expert AI environments.**

A model is capable. A Workbench makes it prepared.

General-purpose agents pay a knowledge ramp-up cost every time they enter an
unfamiliar project. They spend time and model tokens rediscovering architecture,
conventions, tooling, and operating procedures that maintainers already know. A
Workbench packages that expertise once, so every compatible run begins
prepared.

Workbenches package the expertise, runner, model, tools, skills, integrations,
runtime, and authorization requirements needed to perform a specific class of
work. They give maintainers a portable way to publish not only documentation,
but an executable expert environment for their project.

A maintainer publishes the package alongside the project:

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
- Explicit named workspace requirements for multi-repository work
- A local or isolated runtime and, where supported, an image

The manifest is intentionally small:

```yaml
spec: 0
version: 0.1.0

name: migrations
description: Design, review, and safely apply project migrations.

runner: opencode
model:
  id: openai/gpt-5.6-terra

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

workspaces:
  api:
    required: true
    access: read-write

runtime: local
```

The Workbench engine reads this file. The selected runner does not. The engine
validates and resolves the package, prepares the runtime, verifies its declared
requirements before model execution, and translates the canonical Workbench
into the runner's native configuration.

## Reference CLI

This repository contains `workbench`, also available as `wb`: the TypeScript
reference engine and command-line client for the standard.

The project is in public pre-alpha development. The draft-0 format, OpenCode and
Pi adapters, local runtime, and Docker runtime for one-shot and detached
execution are implemented. The format is not yet stable. Other runners and
hosted runtimes are not yet supported by the reference engine.

### Install the current prerelease

Install the current prerelease on macOS or Linux:

```sh
curl -fsSL https://workbenches.dev/install.sh | sh
```

Release binaries are available for arm64 and x64. To inspect the installer
before running it:

```sh
curl -fsSLO https://workbenches.dev/install.sh
less install.sh
sh install.sh
rm install.sh
```

The installer selects the prerelease matching this repository, verifies its published SHA-256
checksum, installs `workbench` to `~/.local/bin` by default, and creates the `wb`
alias. It never invokes `sudo` or edits shell startup files. Use `--version` to
install a specific release and `--bin-dir` to choose another destination.

### Create a Workbench

Run `init` from a repository root to create `.workbenches/<name>`:

```sh
wb init core
wb init migrations --runner opencode --model openai/gpt-5.6-terra
```

This repository also publishes a `creator` Workbench containing the current
schema and maintainer-authored package guidance. Save it once, then use it to
design, author, review, or repair Workbenches in another repository:

```sh
wb add pompeii-labs/workbenches#creator --as workbench-creator
wb run workbench-creator \
  --dir /path/to/repository \
  --task "Inspect this repository and create a focused migrations Workbench"
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

CLI releases and saved Workbench snapshots have separate lifecycles:

```sh
wb update --check
wb update
wb upgrade project-core
wb upgrade
```

`update` checks or replaces the installed Workbench CLI. `upgrade` refreshes one
saved Workbench from its recorded source, or every saved Workbench when no alias
is provided. An upgrade downloads and verifies the candidate package before it
atomically repoints the saved alias. Existing snapshots remain unchanged if the
upgrade fails.

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

Bind manifest-declared environment values from a dotenv file or with repeatable
per-run overrides:

```sh
wb smoke project-core --env-file .env.workbench
wb run project-core --task "Review this migration" --env-file .env.workbench
wb run project-core --task "Review this migration" \
  --env API_URL=https://api.example.com \
  --env API_TOKEN=secret
```

Explicit `--env` values take precedence over `--env-file`, which takes
precedence over inherited process environment. Dotenv entries not declared by
the Workbench are ignored; an undeclared explicit override is rejected as a
likely typo. Values are used only for that invocation and are not written to
saved run metadata or normalized events. Prefer `--env-file` or inherited
environment for secrets because command-line values may be retained in shell
history.

### Connect the locked runner

The Workbench author selects the runner, model, allowed provider routes, and
native runner configuration. Those choices cannot be overridden when the
Workbench runs. Choose one of the runner's compatible connections:

```sh
wb connect project-core
wb run project-core --task "Review this migration"
```

If more than one compatible connection is available, `wb connect` asks which
one this Workbench should use. Run it again to switch connections. When the
runner exposes a documented command-line login operation, `wb connect` can
also open it for another provider. It never injects login commands into an
interactive runner conversation. The selection is stored in
`~/.workbench/connections.json`; it does not change the Workbench package,
runner, model, or credential store.

Local Workbenches use the runner's normal local credential store. OpenCode
exposes a command-line login operation, so Docker Workbenches can retain its
native credentials in a private Docker volume. Pi currently exposes credential
inspection but not command-line login. Configure Pi before local runs. A Docker
Pi Workbench must declare its provider environment and receive it through
`--env-file` or `--env` on each command. The CLI checks only whether an allowed
provider is ready. It does not read, upload, or rewrite provider tokens.

Pi is distributed separately by the Pi project and must be installed in the
selected runtime:

```sh
npm install -g @earendil-works/pi-coding-agent
```

Bind additional repositories or directories only when the manifest declares
them:

```sh
wb run project-core --dir ./app --workspace api=../api \
  --workspace schemas=../schemas --task "Review the cross-repository change"
```

Required bindings fail before runner launch. Inside a local run, the resolved
paths are exposed as `WORKBENCH_WORKSPACE_API` and
`WORKBENCH_WORKSPACE_SCHEMAS`. Docker uses the same names with deterministic
container paths such as `/workspaces/api`; read-only declarations are enforced
by Docker mounts. Local access declarations are preflight checks, not an
operating-system sandbox.

Use `--dry-run` to inspect the translated runner invocation without executing
it:

```sh
wb run project-core --task "Review this migration" --dry-run
```

### Run in Docker

A Docker Workbench can name a published OCI image or a Workbench-local
Dockerfile:

```yaml
runtime: docker
image:
  build: ./Dockerfile.workbench
  context: .
```

`run` automatically pulls or builds the declared image. Use `build` to prepare
it explicitly, then `smoke` to verify the runner, declared tools,
authorizations, instructions, and skills inside the container without making a
model request:

```sh
wb build project-core
wb smoke project-core
wb run project-core --task "Review this migration"
```

Publish a locally built image to the Workbench OCI registry after signing in:

```sh
wb login
docker build -t project-core-local .
wb image push project-core-local \
  --publisher example \
  --as project-core \
  --tag 0.4.0
```

`image push` exports the local image, skips blobs already present in the
registry, uploads missing blobs in bounded chunks, and publishes the original
OCI manifest under `images.workbenches.dev/example/project-core:0.4.0`. The
source image can have any valid local name. Progress is written to stderr and
the resulting image reference is written to stdout. Use `--client` to select an
OCI-compatible client that supports the Docker `image save` interface.

Standard OCI clients can authenticate explicitly too:

```sh
wb image login
docker tag project-core-local \
  images.workbenches.dev/example/project-core:0.4.0
docker push images.workbenches.dev/example/project-core:0.4.0
```

Direct client pushes are subject to the registry edge's per-request body
limit. Use `wb image push` for images with large layers because it controls the
upload chunk size. Standard Docker pulls work for images published through
either path.

The Workbench can then declare the published image:

```yaml
runtime: docker
image: images.workbenches.dev/example/project-core:0.4.0
```

Publishing requires a Workbench registry account with access to the selected
publisher. Use a versioned tag for a published Workbench and avoid changing the
image behind that tag.

Published tags are pulled and execution uses the resolved repository digest.
Local builds use a content-addressed cache and a staged build context that
excludes common credential stores and secret-bearing files. The target
workspace is mounted read-write and the Workbench package is read-only.
Named workspaces are mounted beneath `/workspaces/<name>` with their declared
read-only or read-write access.
Generated runner state is isolated in a writable, ephemeral mount because some
runners update their own configuration at launch. The container root filesystem
is read-only and `/tmp` is a writable temporary filesystem. The engine does not
impose a CPU, memory, or temporary-filesystem size limit in execution protocol
draft 0.

The reference binaries currently support macOS and Linux. On platforms that
expose a numeric host user and group, containers run under that identity so
workspace writes retain host ownership. Docker Desktop still mediates bind
mounts through its virtual machine, so filesystem performance and permission
details can differ from native Linux. Images must tolerate a read-only root and
write caches beneath the provided temporary `HOME`; interactive Docker sessions
are not supported in execution protocol draft 0.

If the Workbench itself must use the host Docker engine, it must declare that
high-risk requirement:

```yaml
runtime: docker
image: ghcr.io/example/project-workbench:0.4.0
docker:
  engine:
    mode: host
```

The declaration is not authorization. Every smoke or run requires an explicit
grant:

```sh
wb smoke project-core --allow-host-docker
wb run project-core --allow-host-docker --task "Start the local stack"
```

Host Docker access is effectively administrative access to the Docker host and
can escape the Workbench container's isolation. The image must contain the
Docker CLI; preflight verifies both the CLI and daemon before model execution.
Host-engine runs preserve host workspace paths inside the Workbench container
so nested Docker and Compose bind mounts resolve correctly. Other Docker engine
modes and non-Unix contexts are rejected rather than silently substituted.

### Detach, attach, and cancel

```sh
wb run project-core --task "Perform the migration" --detach
# wb_...

wb attach wb_...
wb attach              # latest dispatched run
wb attach wb_... --json
wb ps                  # active detached runs
wb ps --all            # detached run history
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
streaming, image input, cancellation, tool events, and explicit permission
decisions for the local runtime. OpenCode's server interface does not currently
provide native mid-turn steering. The Pi adapter supports multi-turn context,
streaming, image input, steering at Pi's next legal model boundary, follow-up
input, cancellation, and tool events. Pi does not provide a native permission
request protocol or MCP transport.

The terminal client does not yet expose image attachment or steering controls.
Those operations are available through the normalized runner session boundary.
Image generation and normalized image output are not implemented yet.
Interactive sessions are not durable, and Docker Workbenches currently require
a one-shot task: interactive sessions cannot yet be detached or recovered.

## Source and authorization boundaries

Remote `list`, `validate`, and `smoke` operations are read-only. Public GitHub
repositories require no credentials. Private repositories can use
`GITHUB_TOKEN` or `GH_TOKEN`; inaccessible private repositories and missing
repositories are reported without pretending GitHub distinguishes them.

Environment values never belong in `workbench.yml`. A manifest declares their
names and whether they are required; the person or host starting the run
provides the values through inherited environment, `--env-file`, or `--env`.
Dry runs, saved package metadata, and normalized events do not expose those
values.

For `runtime: local`, declared tools must exist on the host. For `runtime:
docker`, declared tools and the runner must exist inside the resolved image;
host installations do not satisfy the requirement. Only manifest-declared
environment values and credential variables for the selected model provider are
bound into the container. Their values do not appear in Docker command
arguments or the environment of the host Docker client process. Preflight
failure stops execution before model tokens are spent.

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
bun run test:docker
bun run build
```

`test:docker` requires a running Docker daemon and network access to pull its
pinned fixture image. It exercises the real container boundary; the default
test suite uses deterministic provider doubles and does not require Docker.

`bun run check` runs type checking, Biome, and the unit and integration suite.
The compiled `dist/workbench` binary is self-contained and does not require Bun
on the target machine. Distribution builds include the repository license and
notice.

Both `workbench` and `wb` are package binary names. Commits use Conventional
Commits and are checked by the repository's `commit-msg` hook and CI.

## Project policies

- Use [GitHub Issues](https://github.com/pompeii-labs/workbenches/issues) for
  reproducible bugs and focused feature proposals.
- Use [GitHub Discussions](https://github.com/pompeii-labs/workbenches/discussions)
  for authoring questions and open-ended design discussion.
- Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a change.
- Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).
- Project decisions and maintainership are described in
  [GOVERNANCE.md](GOVERNANCE.md) and [MAINTAINERS.md](MAINTAINERS.md).
- Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

The source code, schemas, conformance fixtures, specification, and documentation
in this repository are licensed under the [Apache License 2.0](LICENSE) unless a
file states otherwise. Workbench packages published by other projects are
independent works and remain subject to the licenses chosen by their publishers.
