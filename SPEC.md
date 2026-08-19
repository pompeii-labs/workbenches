# Workbench format v0

**Status:** working draft

A Workbench is a repository-owned execution recipe that packages the expertise
and environment needed to work on a class of problems.

A Workbench is not an agent. It does not define a DAG, workflow, user
interface, or product-level run. A host such as Pompeii can add those things
around it.

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
version: 0

name: project-core
description: Work on the project using its maintainers' own practices.

runner: opencode
model: openrouter/openai/gpt-5.6-luna

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

Environment values never appear in the manifest. The person or host starting a
run supplies them.

`instructions` is a package-relative Markdown file. Each `skills` entry is a
package-relative directory containing a portable `SKILL.md`; adapters expose
those skills through the runner's native on-demand skill mechanism.

`tools` names CLI executables that must be available before a run starts.

## Tool preflight

Tools are requirements of the selected runtime, not assumptions about the host
that launched the Workbench.

The execution lifecycle is:

1. Resolve and validate the Workbench package.
2. Provision or select the runtime environment.
3. Verify every declared tool inside that environment.
4. Launch the runner and permit model requests only after preflight succeeds.

For `runtime: local`, the environment is the host process environment. The v0
reference engine resolves each declared tool from `PATH` and rejects the run if
an executable is missing. For an image, container, VM, or hosted sandbox such as
E2B, the executor must perform the same check inside the provisioned environment;
a tool present on the host does not satisfy the Workbench requirement.

Preflight failure must stop the run before spending model tokens and identify the
missing or incompatible tool. Executors must not trust an image label or cached
image metadata as proof that its tools are usable.

The current string form asserts executable presence only:

```yaml
tools:
  - cargo
  - lux
```

A structured tool form for version constraints and deterministic health/version
commands remains an open v0 design question. Until that contract exists, the
reference engine must not claim that presence proves version compatibility or
correct behavior.

`mcps` currently describes remote Streamable HTTP servers. Header values can
reference root environment declarations with `${NAME}`. A server that references
an unset optional environment variable is omitted from the run. An unset required
variable rejects the run. Adapters must preserve the reference instead of placing
the secret value in generated config or dry-run output.

## Current reference-engine support

The current experiment implements only OpenCode on the local machine. It loads
`instructions` through OpenCode's native configuration and passes the run task
as a separate user message. It stages declared skills in an isolated OpenCode
config directory so they remain native, on-demand skills. It translates eligible
remote MCPs into OpenCode configuration.

Non-local runtimes, local-process MCPs, and images are intentionally rejected
until they are actually implemented.

The format does not currently define setup hooks, knowledge files, runner
capabilities, orchestration, UI events, or registry behavior.
