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
model: openrouter/openai/gpt-5.6-terra

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

runtime: local
```

The Workbench chooses its runner, model, and runtime. A consuming host either
supports that recipe or reports that it cannot run it.

`spec` is the integer Workbench schema version. A released spec parser is
immutable: engines select the matching parser, normalize its output into the
current internal representation, and retain old parsers for backward
compatibility. Unknown future specs fail without guessing. `version` is the
Workbench author's semantic release version; source revisions and content
digests remain the authority for reproducibility.

The published machine-readable schema for this draft is
[`schemas/v0/workbench.schema.json`](schemas/v0/workbench.schema.json). The
reference engine dispatches to a dedicated spec-0 parser before producing its
canonical internal model. Future parsers are added alongside it rather than
changing spec-0 interpretation.

Environment values never appear in the manifest. The person or host starting a
run supplies them.

`instructions` is a package-relative Markdown file. Each `skills` entry is a
package-relative directory containing a portable `SKILL.md`; adapters expose
those skills through the runner's native on-demand skill mechanism.

`tools` names CLI executables that must be available before a run starts.

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

## Tool preflight

Tools are requirements of the selected runtime, not assumptions about the host
that launched the Workbench.

The execution lifecycle is:

1. Resolve and validate the Workbench package.
2. Select the named runtime provider and prepare its environment.
3. Mount or synchronize the workspace and Workbench assets, and bind the run
   environment.
4. Verify every declared tool inside that environment.
5. Launch the runner and permit model requests only after preflight succeeds.

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
