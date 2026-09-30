# Workbench package specification, draft 0

**Status:** pre-release working draft

A Workbench is a repository-owned execution recipe that packages the expertise
and environment needed to work on a class of problems.

A Workbench is not an agent. It does not define a DAG, workflow, user
interface, or product-level run. A host can add those things around it.

The host-facing runner boundary is defined separately by
[`docs/EXECUTION.md`](docs/EXECUTION.md). A run is a managed, potentially
interactive session; the Workbench format still does not own its presentation or
orchestration.

## Repository layout

```text
.workbenches/
  core/
    workbench.yml
    instructions.md
    skills/
      migrations/
        SKILL.md
```

Each immediate child directory is one Workbench. Its manifest is named
`workbench.yml`.

## Initial manifest

```yaml
spec: 0
version: 0.1.0

name: project-core
description: Work on the project using its maintainers' own practices.

runner: opencode
model:
  id: openai/gpt-5.6-terra

instructions: ./instructions.md
skills:
  - ./skills/migrations

tools:
  - cargo

mcps:
  - name: project
    transport: http
    url: https://example.com/mcp
    headers:
      Authorization: Bearer ${PROJECT_TOKEN}

env:
  PROJECT_TOKEN:
    required: false

workspaces:
  api:
    required: true
    access: read-write
  schemas:
    required: false
    access: read-only

runtime: local
```

The Workbench chooses its runner, model, and runtime. A consuming host either
supports that recipe or reports that it cannot run it.

## Runner, model, and authentication

The Workbench author locks the runner and model policy. A person starting a run
cannot replace the runner, model, allowed provider routes, or packaged native
runner configuration. This keeps a published Workbench equivalent to the
configuration its maintainer tested.

A model object identifies a model independently from the service used to reach
it:

```yaml
runner: opencode
model:
  id: openai/gpt-5.6-terra
```

The identifier uses `lab/model`, where `lab` identifies the organization that
defines the model. It is not a provider selection. An engine resolves the model
through verified model metadata and chooses the first route for which the
selected runner has compatible credentials. The engine may update that metadata
independently of the Workbench package, but the metadata version used for a run
is part of the resolved runner configuration.

An author can restrict or order the allowed providers:

```yaml
model:
  id: openai/gpt-5.6-terra
  routes:
    - provider: openai
    - provider: openrouter
```

Routes must serve the same model identity. They are not fallbacks to different
models. A route can include a provider-native model identifier when it differs
from the catalog or when the model is absent from the catalog:

```yaml
model:
  id: private-lab/review-model
  routes:
    - provider: internal-gateway
      model: deployment-42
runner_config: ./runner
```

An unknown model requires explicit native model identifiers for every route and
a packaged `runner_config`. `runner_config` is a package-relative file or
directory interpreted only by the selected runner adapter. Pi requires a
directory. The path must remain inside the Workbench package and cannot contain
symbolic links, credential files, or literal credential values. Configuration
can name environment bindings declared by the manifest, but values are supplied
only when the Workbench runs.

A Workbench package never owns a person's runner credentials. Engines verify
that at least one allowed route is ready before sending a model request. When a
runner exposes a documented command-line authentication operation, an engine
can offer it as part of connection setup. An engine must never inject login
commands or simulated user input into an interactive runner conversation. When
no command-line operation exists, the person configures the runner separately
or supplies a declared environment credential when the Workbench runs. Local
runtimes use the runner's normal local credential store. Isolated runtimes can
mount a private, persistent credential store only when it can be populated
through a supported command-line flow. Engines must not parse, copy into
package state, upload, or print provider token contents.

`spec` is the integer Workbench schema version. Draft 0 is an unreleased format
and can change while the standard remains in pre-release development. Once a
spec is released, its parser becomes immutable: engines select the matching
parser, normalize its output into the current internal representation, and
retain old parsers for backward compatibility. Unknown future specs fail
without guessing. `version` is the Workbench author's semantic release version;
source revisions and content digests remain the authority for reproducibility.

The published machine-readable schema for this draft is
[`schemas/v0/workbench.schema.json`](schemas/v0/workbench.schema.json). Future
released parsers are added alongside older released parsers rather than changing
their interpretation.

Environment values never appear in the manifest. The person or host starting a
run supplies them.

`instructions` is a package-relative Markdown file. Each `skills` entry is a
package-relative directory containing a portable `SKILL.md`; adapters expose
those skills through the runner's native on-demand skill mechanism.

`tools` names CLI executables that must be available before a run starts.

## Workspace bindings

Every run has one primary workspace. The person or host starting the run selects
it; the reference CLI uses the current directory by default and accepts `--dir`
to select another directory. The primary workspace is available to the runner as
its working directory and is read-write.

A Workbench can also declare named workspaces when its expertise legitimately
spans additional repositories or directories. Declarations contain logical
names and access requirements, never machine-specific paths:

```yaml
workspaces:
  api:
    required: true
    access: read-write
  schemas:
    required: false
    access: read-only
```

Names are lowercase and hyphenated; `primary` is reserved. `required` defaults
to `true` and `access` defaults to `read-only`. A host binds a directory to a
declared name for an individual run. The reference CLI accepts repeatable
`--workspace NAME=PATH` arguments and rejects missing required bindings,
undeclared names, unavailable directories, and duplicate resolved paths before
launch.

Runtimes expose named workspace locations through
`WORKBENCH_WORKSPACE_<NAME>`, replacing hyphens with underscores. The local
runtime uses resolved host paths. The Docker runtime mounts them at
`/workspaces/<name>` and enforces the declared mount access. The reference E2B
runtime copies them to `/workspaces/<name>` and returns declared read-write
changes as pending outcomes, never applying them implicitly to the host. The
local runtime checks host
readability or writability but cannot prevent a host process from writing
elsewhere; engines must not represent local access declarations as an isolation
boundary.

## Runtime selection and images

`runtime` is the provider identifier selected by the Workbench. Draft 0 defines
`local`; the reference engine may register additional providers such as
`docker` or `e2b`. An unknown provider is an error and must not silently fall
back to the host.

`image` is optional provider input. A string names a published image:

```yaml
runtime: docker
image: ghcr.io/example/project-workbench:0.4.0
```

A local image build uses an object instead:

```yaml
runtime: docker
image:
  build: ./Dockerfile.workbench
  context: ../..
```

`build` is a Workbench-package-relative Dockerfile. `context` is also
package-relative and defaults to `.`. Both must remain within the containing
repository. Providers that do not accept images, including `local`, reject the
field. Providers decide how to cache prepared images, but the observable result
must be equivalent to preparing the declared input again.

The reference Docker and E2B providers require `image`. The E2B provider accepts
the same public OCI reference or local build object, prepares an E2B template,
and creates a fresh hosted sandbox for each execution. It stages the primary
workspace at `/workspace`, named workspaces at `/workspaces/<name>`, and the
Workbench package at `/workbench`. Host credentials, repository metadata,
ignored files, and undeclared assets are not portable package inputs and must
not be inferred for upload.

### Host Docker engine binding

A Docker Workbench that must build or run sibling containers can request the
host's Docker engine:

```yaml
runtime: docker
image: ghcr.io/example/project-workbench:0.4.0
docker:
  engine:
    mode: host
```

This is a high-risk provider-specific requirement. It does not grant access by
itself: the person or host starting each run must explicitly authorize it. The
reference CLI requires `--allow-host-docker`. Without that grant, preparation
fails before the image or runner is launched. A host-engine binding gives code
inside the Workbench effective administrative control over the Docker host and
must be presented as such.

The image must contain the Docker CLI. The provider binds the active local Unix
socket, verifies the CLI and daemon from inside the prepared runtime, and does
not silently use a TCP endpoint or another engine mode. To keep nested bind
mounts correct, the reference Docker provider uses path-preserving primary and
named workspace mounts for host-engine runs. Their runtime-visible paths and
`WORKBENCH_WORKSPACE_<NAME>` values are therefore the resolved host paths, not
`/workspace` and `/workspaces/<name>`. Ordinary Docker Workbenches retain the
deterministic paths described above.

## Tool preflight

Tools are requirements of the selected runtime, not assumptions about the host
that launched the Workbench.

The execution lifecycle is:

1. Resolve and validate the Workbench package.
2. Select the named runtime provider and prepare its environment.
3. Mount or copy the primary workspace, named workspaces, and Workbench
   assets, then bind the run environment.
4. Verify every declared tool inside that environment.
5. Launch the runner and permit model requests only after preflight succeeds.

Durable executions collect changesets, artifacts, and links through the separate
[portable outcomes contract](docs/OUTCOMES.md). Local and Docker execution keep
their in-place workspace behavior. Copy-based E2B execution requires explicit
host acceptance of returned changes. Result collection does not authorize Git
publishing or turn the package into a workflow or orchestration service.

For `runtime: local`, the environment is the host process environment. The v0
reference engine resolves each declared tool from `PATH` and rejects the run if
an executable is missing. For an image, container, VM, or hosted sandbox such as
E2B, the executor must perform the same check inside the provisioned environment;
a tool present on the host does not satisfy the Workbench requirement.

Preflight failure must stop the run before spending model tokens and identify the
missing or incompatible tool. Executors must not trust an image label or cached
image metadata as proof that its tools are usable.

Draft 0 defines tools as executable names and asserts presence only:

```yaml
tools:
  - cargo
  - lux
```

An engine must not claim that executable presence proves version compatibility
or correct behavior.

`mcps` currently describes remote Streamable HTTP servers. Header values can
reference root environment declarations with `${NAME}`. A server that references
an unset optional environment variable is omitted from the run. An unset required
variable rejects the run. Adapters must preserve the reference instead of placing
the secret value in generated config or dry-run output.

## Scope

Draft 0 does not define setup hooks, knowledge-file semantics, orchestration,
user interfaces, or registry behavior. Implementations must reject unsupported
runners, runtimes, images, or integration transports explicitly.

# Spec 1

**Status:** pre-release working draft

Everything above this heading defines spec 0. Spec 0 is frozen: its manifest is
exactly what the engine accepted before spec 1 existed, and it never gains
fields. Spec 1 is a separate manifest version, declared with `spec: 1` and
described by
[`schemas/v1/workbench.schema.json`](schemas/v1/workbench.schema.json). A spec 1
manifest keeps every spec 0 field except the runtime fields, which spec 1
replaces with `requirements` and `runtimes`.

## Versioning rule

A spec version that has shipped to main never changes. An addition, removal, or
change of meaning requires a new spec number. Engines dispatch on `spec`, accept
every spec they support, and reject any other value with "Manifest spec N is not
supported by this engine; upgrade wb". They never guess at an unknown spec.

## Requirements, runtimes, and images

A spec 1 Workbench states two separate things about where it runs.
`requirements` describe what the environment must satisfy regardless of
provider. `runtimes` list the providers the author supports and the
provider-specific input each needs. An engine picks one declared runtime for a
run and checks the requirements against it before anything is launched.

`runtimes` is the only form. `runtime`, top-level `image`, and top-level
`docker` are spec 0 fields and are invalid in spec 1. `runtimes` is required and
must declare at least one runtime. An engine that reads a spec 0 manifest
resolves its single `runtime` into a one-entry runtimes map so selection and
preflight behave the same for both specs. That normalization is internal to the
engine and is not a manifest form.

```yaml
spec: 1
version: 0.1.0

name: project-core
runner: opencode
model:
  id: openai/gpt-5.6-terra
instructions: ./instructions.md

requirements:
  os: [linux, macos]
  cpu: 4
  memory_gb: 8

runtimes:
  local: {}
  docker:
    image: ghcr.io/example/project-workbench:0.4.0
```

### Requirements

`requirements` is an optional object. Every field is optional, and an absent
field places no constraint:

```yaml
requirements:
  os: [linux, macos]
  arch: [arm64, x64]
  cpu: 4
  memory_gb: 8
  disk_gb: 20
  gpu: false
```

- `os` is a non-empty list of `linux`, `macos`, and `windows`. The environment
  must run any one of them.
- `arch` is a non-empty list of `x64` and `arm64`. The environment must use any
  one of them.
- `cpu` is the minimum number of vCPUs, a positive integer.
- `memory_gb` and `disk_gb` are minimums in GiB, positive numbers.
- `gpu` is a boolean and defaults to `false`. `true` means the Workbench needs a
  GPU.

An engine normalizes an absent object to `gpu: false` with no other
constraint.

### Runtimes

`runtimes` is a map from provider name to that provider's configuration.
Declaration order matters: the first entry is the default. The `local` entry
may be written `local: {}` or with no value (`local:`).

| Provider  | Configuration                           | Status                                            |
| --------- | --------------------------------------- | ------------------------------------------------- |
| `local`   | none, written `{}`                      | implemented by the reference engine               |
| `docker`  | `image` (required), `docker` (optional) | implemented by the reference engine               |
| `e2b`     | `image` (required)                      | implemented by the reference engine               |
| `daytona` | `class` (required), `image` (optional)  | implemented by the reference engine               |

The Daytona `class` is one of `linux`, `windows`, `gpu`, or `macos`. The
reference engine creates a Daytona sandbox from the entry's `image` and, when the
entry has none, from the `docker` entry's image. It fails to prepare a `daytona`
entry when neither declares an image, and supports the `linux` class only; the
other classes fail with "class X is not available yet". An unknown provider name
is an error and must not silently fall back to the host.

`image` is a string naming a published image, or a build object with a
package-relative `build` Dockerfile and a package-relative `context` that
defaults to `.`. Both must remain within the containing repository. Providers
decide how to cache prepared images, but the observable result must be
equivalent to preparing the declared input again. Runtime image behavior, the
E2B staging layout (shared by Daytona), and the host Docker engine binding
(`docker: { engine: { mode: host } }` under the docker entry, authorized per run
with `--allow-host-docker`) follow the spec 0 text above, applied to the
selected runtime's entry.

### Selection

The person or host starting a run can name one declared runtime. The reference
CLI accepts `--runtime <name>` on `wb run`, `wb smoke`, `wb build`, and
`wb create`. Without it, the first declared runtime is used. Naming a runtime the
manifest does not declare is an error that lists the declared ones.

### Requirements against the selected runtime

Requirements are checked against the selected runtime before the runtime is
prepared, so a mismatch stops the run before it spends anything. The same checks
apply to a spec 0 manifest, which has no requirements to check:

- `local` compares `os` and `arch` with the host, and compares `cpu` and
  `memory_gb` with the host's CPU count and total memory. A `gpu: true`
  requirement cannot be verified on the host and is refused with
  "GPU requirements are not checked on the local runtime" unless the person
  starting the run accepts it. The reference CLI accepts
  `--allow-unchecked-gpu`. `disk_gb` is not checked and is reported as such.
- `docker` and `e2b` run Linux containers and sandboxes, so `os` must include
  `linux` or be absent. `docker` also requires `arch` to include the host
  architecture, and applies `cpu` and `memory_gb` as container limits. `e2b`
  does not enforce `arch`, `cpu`, `memory_gb`, or `disk_gb` at sandbox creation
  in the reference engine, and reports them as unchecked. `gpu: true` is
  refused on both.
- `daytona` requires its `class` to be compatible with `os`. The `linux` class
  needs `os` to include `linux` or be absent. The `macos` class needs `macos`.
  The `windows` class needs `windows`. The `gpu` class needs `linux` and
  `gpu: true`, and a `gpu: true` requirement needs the `gpu` class.

A requirement an engine cannot verify or enforce must be reported as unchecked,
never presented as satisfied.
