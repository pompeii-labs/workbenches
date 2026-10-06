<p align="center">
  <img src="../assets/brand/workbench-mark-woodcut.png" alt="Workbench" width="220">
</p>

# Workbench reference

[![CI](https://github.com/pompeii-labs/workbenches/actions/workflows/ci.yml/badge.svg)](https://github.com/pompeii-labs/workbenches/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/v/release/pompeii-labs/workbenches)](https://github.com/pompeii-labs/workbenches/releases)

This is the complete reference for the Workbench CLI and execution model. For the shortest path from install to a useful run, start with the [project README](../README.md).

A model is capable. A Workbench makes it prepared.

General-purpose agents pay a knowledge ramp-up cost every time they enter an unfamiliar project. They spend time and model tokens rediscovering architecture, conventions, tooling, and operating procedures that maintainers already know. A Workbench packages that expertise once, so every compatible run begins prepared.

Workbenches package the expertise, runner, model, tools, skills, integrations, runtime, and authorization requirements needed to perform a specific class of work. They give maintainers a portable way to publish not only documentation, but an executable expert environment for their project.

A maintainer publishes the package alongside the project:

```text
.workbenches/
  core/
    workbench.yml
    instructions.md
    skills/
```

Any compatible host can then resolve the package, verify its requirements, and translate it into the selected runner's native interface.

Workbench is not another agent framework. The standard does not define a DAG, task planner, chat product, or orchestration system. It defines the versioned, portable package that prepares an AI to do the work. Products can build their own workflows and interfaces around that package.

## What a Workbench contains

A Workbench can declare:

- Maintainer-authored instructions
- A runner and model selected for the work
- Portable, on-demand skills
- Required CLI tools
- Remote MCP integrations
- Environment-variable requirements without embedded secret values
- Explicit named workspace requirements for multi-repository work
- Environment requirements (OS, architecture, CPU, memory, disk, GPU)
- The runtimes it supports (local, Docker, E2B, Daytona) and, where a runtime needs one, an image

The manifest is intentionally small:

```yaml
spec: 1
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
  - dbctl

mcps:
  - name: database
    transport: http
    url: https://api.example.com/mcp
    headers:
      Authorization: Bearer ${DATABASE_API_TOKEN}

env:
  DATABASE_API_TOKEN:
    required: false

workspaces:
  api:
    required: true
    access: read-write

requirements:
  os: [linux, macos]

runtimes:
  local: {}
```

Spec 1 is the standard. Spec 0, with its single `runtime` field, is frozen legacy that engines still read. See [Requirements and runtimes](#requirements-and-runtimes).

The Workbench engine reads this file. The selected runner does not. The engine validates and resolves the package, prepares the runtime, verifies its declared requirements before model execution, and translates the canonical Workbench into the runner's native configuration.

## Reference CLI

This repository contains `workbench`, also available as `wb`: the TypeScript reference engine and command-line client for the standard.

The spec 0 and spec 1 manifests, the OpenCode and Pi adapters, and local, Docker, E2B, and Daytona runtimes for one-shot and detached execution are implemented, with interactive execution on local, Docker, and E2B. Daytona has no interactive terminal yet. Other runners and remote runtime providers are not yet supported by the reference engine. See [Stability](#stability) for what the 1.0 CLI promises.

### Install

Install on macOS or Linux:

```sh
curl -fsSL https://workbenches.dev/install.sh | sh
```

Release binaries are available for arm64 and x64. To inspect the installer before running it:

```sh
curl -fsSLO https://workbenches.dev/install.sh
less install.sh
sh install.sh
rm install.sh
```

The installer verifies the release's published SHA-256 checksum, installs `workbench` to `$XDG_BIN_HOME` when set, else `~/.local/bin`, and creates the `wb` alias. It never invokes `sudo` or edits shell startup files. Use `--version` to install a specific release and `--bin-dir` to choose another destination.

`latest`, the default, is the newest stable release by version among the 100 newest GitHub release records, matching `wb update` on a stable build. Pass `--version` to pin any version, prereleases included.

### Author a Workbench

Run the official creator from a repository root for a native, interactive authoring session:

```sh
wb create migrations
```

The creator inspects the target repository and authors the complete package in `.workbenches/`. It receives the exact `wb` CLI build that opened the authoring session instead of another globally installed version. If `migrations` already exists in the current repository, the same command opens it for editing instead. The engine resolves and verifies the official creator through the Workbench registry and keeps its cache separate from the user's saved Workbenches.

Finish an idle authoring session with `/quit` or `Ctrl+C`. The engine validates the candidate, checks its version and package scope, and runs `wb smoke` before closing the creator. A failed check leaves the creator open with the concrete error so it can repair the package. An active creator turn must be cancelled or allowed to finish before authoring can be completed.

Candidates that declare environment values, named workspaces, or host Docker access can be verified with the same `--env-file`, repeatable `--env`, repeatable `--workspace`, and `--allow-host-docker` options accepted by `smoke` and `run`. Their values are used only for the final smoke and are never written to the authoring record or improvement evidence. `--runtime <name>` chooses which declared runtime of the candidate the final smoke checks, and `--allow-unchecked-gpu` accepts a GPU requirement the runtime cannot verify.

Scaffold a package with `wb init`. `--runtimes` takes a comma-separated list and writes the `runtimes` map in that order. It defaults to `local`. The `docker`, `e2b`, and `daytona` runtimes need `--image`; `daytona` is written with `class: linux` and that image:

```sh
wb init migrations --runtimes local,docker --image ghcr.io/example/migrations:0.1.0
```

Edit a local source package through the same authoring environment:

```sh
wb create .#migrations
```

`create` never mutates an immutable saved snapshot. Pass a local repository path or selector so the creator changes the source package directly.

For deterministic scaffolding without a model run, use `init`:

```sh
wb init core
wb init migrations --runner opencode --model openai/gpt-5.6-terra
```

Agents can use that same command without opening the terminal client. Supply exactly one brief as text, a UTF-8 file, or explicit stdin:

```sh
wb create migrations --task "Create a focused migration review expert" --json
wb create .#migrations --task-file improvements.txt --detach --json
wb wait wb_... --timeout 120 --json
printf '%s\n' "Check failure cleanup more carefully" | \
  wb create --from wb_... --stdin --detach --json
```

Without `--detach`, headless authoring waits for execution and engine-owned verification, then prints one result. With `--detach`, it prints a correlated session/run/operation receipt while a separate supervisor verifies the package after the creator finishes. `wb wait` waits for that verification too. Its `authoring` result reports package selectors and paths, changed files, and the improvement evidence path when applicable. A completed creator turn alone is not authoring success: invalid packages, out-of-scope edits, missing version increments, and failed smoke checks produce a failed result and nonzero exit.

`--from` can infer improvements from stored session evidence without a brief. Other headless authoring calls require one. If the creator needs permission, `wait` reports the pending request with exit 2; answer it explicitly through `wb answer`, then wait again. Bare `wb create` keeps its interactive behavior. The creator remains a normal published Workbench, but running it directly does not provide the `create` command's scope and verification contract.

### Discover and save Workbenches

Local paths, GitHub URLs, and GitHub repository slugs are accepted:

```sh
wb list .
wb list /path/to/repository
wb list https://github.com/owner/repository
wb list owner/repository

wb validate owner/repository
wb smoke owner/repository
wb add publisher/core
wb add https://github.com/owner/repository --name core --ref main
wb add ./.workbenches/core --as project-local
```

Remote inspection uses the GitHub API and does not clone or create a temporary checkout. `add` saves remote package snapshots or registers a live absolute local package directory. Bare `publisher/name` means registry only, never GitHub. Use `--name` for a source package selector, `--ref` for a Git revision, and `--as` for an explicit alias. The default alias is the manifest name. Identical additions are idempotent; collisions never overwrite and changed remotes require `upgrade`.

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

`update` checks or replaces the installed Workbench CLI. `upgrade` refreshes one saved remote Workbench from its recorded source, or every saved remote when no alias is provided. An upgrade downloads and verifies the candidate package before it atomically repoints the saved alias. Existing snapshots remain unchanged if the upgrade fails.

### Run a task

Run a saved alias only. Local registrations read current package bytes for each new session; sessions retain their captured bytes for every resume. `--dir` and `--repo` select the workspace, not the package source. Pass a positional task or use `--task` for a one-shot run:

```sh
wb run project-core "Explain the storage architecture"
wb run project-core --task "Review this migration"
```

The default output is a colorized, terminal-safe Markdown stream normalized across runners. For integrations, `--json` emits the runner-neutral Workbench event protocol as NDJSON. `--final` emits only the final assistant response.

```sh
wb run project-core --task "Review this migration" --json
wb run project-core --task "Review this migration" --final
```

Bind manifest-declared environment values from a dotenv file or with repeatable per-run overrides:

```sh
wb smoke project-core --env-file .env.workbench
wb run project-core --task "Review this migration" --env-file .env.workbench
wb run project-core --task "Review this migration" \
  --env API_URL=https://api.example.com \
  --env API_TOKEN=secret
```

Explicit `--env` values take precedence over `--env-file`, which takes precedence over inherited process environment. Dotenv entries not declared by the Workbench are ignored; an undeclared explicit override is rejected as a likely typo, unless it is a provider key for an allowed route or the selected sandbox runtime's API key. Values are used only for that invocation and are not written to saved run metadata or normalized events. Prefer `--env-file` or inherited environment for secrets because command-line values may be retained in shell history.

### Work on a GitHub repository

Select a repository independently of the Workbench package or current directory:

```sh
wb run project-core --repo owner/project --task "Audit authentication"
wb run project-core --repo owner/project --ref main \
  --task "Add pagination and tests"
```

Repository access uses inherited `GH_TOKEN`, then `GITHUB_TOKEN`, or an existing `gh auth login`. No GitHub App, registry account, or hosted Workbench service is required. This authentication is separate from `wb connect`, which selects model provider connections. Private repositories require repository read access; PR creation also requires Contents and Pull requests write permissions. CI inspection requires Actions and Checks read permissions. Workflow changes may require additional GitHub permissions.

The engine resolves the selected ref to an exact commit and checks it out under the session's managed storage. It never uploads or synchronizes your current project. The current directory remains the session-discovery scope. Repository mode cannot be combined with `--dir`, named host workspace bindings, host Docker access, or `--dry-run`.

Workbench authors do not need to declare or install `git` or `gh`. For Docker and E2B repository runs, the engine builds a cached tooling layer on top of the Workbench image. On Daytona it installs `git` and `gh` in the sandbox (on Daytona, an image without `git` and `gh` needs a root user or passwordless `sudo`). The original image and package remain unchanged.

Repository runs pass `GH_TOKEN` into the runner and configure Git to use `gh` for HTTPS authentication. The engine resolves the authenticated GitHub account and configures commits with that account's GitHub no-reply identity, without exposing its private email. The agent can use ordinary `git` and `gh` commands to commit, push, open or update a PR, and inspect CI. There is no Workbench-specific GitHub tool or automatic PR publication when a turn ends. The token retains its actual GitHub permissions; repository mode is not a technical restriction to PR operations. Use a suitably scoped token. Docker and E2B do not mount your GitHub CLI configuration or SSH agent. A local run can still access credentials already available on the host; local execution is not a security sandbox.

`wait --json` includes repository provenance and any saved outcome. The TUI shows repository preparation separately from model work. From the home search, select any saved or published Workbench to choose its run target: the current directory, another local directory with path completion, or a GitHub repository. The repository choice asks for an optional base ref and uses your available GitHub credential. In the non-interactive CLI, the target remains the current directory unless `--dir` or `--repo` is passed.

Repository sessions keep the target, base branch, and GitHub authentication status visible above the conversation. If the agent records a confirmed PR URL as a `pull_request` outcome link, `/pr`, `/checks`, `/logs` or Ctrl+G can inspect that PR without another model turn or sandbox launch. Refresh with `r`, toggle 30-second watching with `w`, open the PR with `o`, or select a job with arrows and press Enter for its logs (`v` opens the job on GitHub). CI is an observed snapshot, not a live guarantee. Watching stops when the panel closes. The panel also offers `d` to inspect the saved diff. Outcome dialogs offer the same diff view; diff and CI log display are bounded to 128 KiB and indicate truncation.

Resume retains the managed checkout and runner Git state. The agent decides when and whether to push, open a PR, update it, or take any other GitHub action allowed by the credential. Workbench never does those actions automatically.

The initial checkout is shallow. Submodules are preserved but not initialized, and Git LFS pointer files are not automatically downloaded. Branches, tags, and commits are accepted as the starting ref; the credential's actual permissions determine which later GitHub operations work. Requested attachments continue to use the normal returned-results contract; project edits remain workspace changes.

### Connect model and runtime providers

The Workbench author selects the runner, model, allowed provider routes, and native runner configuration. Those choices cannot be overridden when the Workbench runs. Connect a runner once for each runtime where you use it. The default flow is independent of saved Workbenches and starts with the execution boundary:

```sh
wb connect
# Model provider → runtime → harness → provider → authentication method → credential
# Or E2B or Daytona runtime → masked API-key prompt
wb run project-core --task "Review this migration"
```

The model-provider path saves the preferred route for that runner and runtime, puts the provider credential into the store that runtime reads, and then checks it. It ends with `Ready: <Provider> for <Runner> in <runtime>`, or with exactly what is missing and the one command that fixes it, exiting 3. The default belongs to the runner and runtime, not a Workbench, and compatible Workbenches reuse it. Each runtime reads a different store:

| Runtime | Credential store | How `wb connect` fills it | How it is checked |
| --- | --- | --- | --- |
| `local` | The runner's own sign-in on this machine | It does not; sign in with the runner (`opencode auth login`) or set the provider variable | The runner lists the provider, or the provider variable is set |
| `docker` | A per-runner named volume mounted at `/workbench-credentials` | A short-lived helper container from the Workbench image, with no network and a read-only root, receives the file on standard input | The same inspection `wb smoke` runs, inside the container |
| `e2b` | `~/.workbench/runtime-credentials/e2b/<runner>/`, synced into each sandbox | Written on the host, files `0600` in `0700` directories | The entry exists on the host; no sandbox is created, so the first run confirms it |
| `daytona` | None; Daytona runs read provider variables only | It does not; set the provider variable or pass `--env-file` | The provider variable is set |

Readiness respects the chosen method: a provider variable holds an API key, so it counts as ready for an API-key or native method (it takes precedence for a run) but never for a subscription. The default is saved only once the route is ready; a connect that exits 3 or is cancelled leaves the previous default in place, and `--remove` drops the default when it pointed at the removed provider. Flags that would have no effect, such as `--yes` with a subscription method or on `local` and `daytona`, are rejected before anything is read or written. A piped key must be the bare value: one trailing newline is removed, and whitespace or a `NAME=` prefix is rejected. The credential comes from, in order: a key piped with `--stdin`; an API key your local runner already has for that provider, which the terminal offers to copy (`Use your local OpenRouter API key in Docker? [Y/n]`) and automation copies only with `--yes`; a fresh `opencode auth login` against a private temporary data home for subscription and sign-in methods; or a masked API-key prompt. A subscription sign-in is never copied from your own login, because providers rotate its refresh token and a copy could sign out the original. Only the selected provider's entry is written, merged into the store beside existing entries. Credential values are never printed, logged, passed in argv, or placed in a child process environment.

```sh
wb connect launch-video --runtime docker
printf '%s' "$OPENROUTER_API_KEY" | wb connect --runtime e2b --harness opencode --provider openrouter --stdin
wb connect --runtime e2b --harness opencode --provider openrouter --yes
wb connect --runtime e2b --harness opencode --provider openrouter --remove
```

`--remove` with `--provider` deletes that provider's entry from that runtime's store and keeps the others. Docker writes and checks go through a Workbench image, so Docker needs a Workbench reference. Pi API keys use Pi's documented `auth.json` format. Pi has no command-line sign-in, so a Pi subscription cannot be connected for another runtime; use an API-key method there. Inherited provider variables and `--env-file` still take effect for a run, so a key passed with `--env-file` works for one run without connecting. Pi is the exception to that precedence: as Pi documents, an entry in its `auth.json` wins over the provider variable.

The E2B runtime-provider path saves its host-only API key once, without starting a sandbox or incurring E2B usage:

```sh
wb connect --runtime e2b
wb connect --runtime e2b --status
```

The terminal prompt masks the key. For automation, pipe it explicitly with `wb connect --runtime e2b --stdin`; there is no key-valued command-line flag that could enter shell history. Remove the saved key with `wb connect --runtime e2b --remove`. The key is stored in `~/.workbench/runtime.secrets.json` with mode `0600`, separately from model credentials. An inherited `E2B_API_KEY` overrides the saved key for one process.

Daytona works the same way and keeps its own key in the same file:

```sh
wb connect --runtime daytona
wb connect --runtime daytona --status
wb connect --runtime daytona --stdin
wb connect --runtime daytona --remove
```

An inherited `DAYTONA_API_KEY` overrides the saved Daytona key for one process. Set `DAYTONA_API_URL` to use a Daytona API endpoint other than the public one. The key is never printed, is never passed to the sandbox, and is not accepted as a command-line value. Saving it creates no sandbox and incurs no Daytona usage.

Passing a Workbench reference narrows the provider choices to routes allowed by that package and checks readiness with that Workbench's runner and runtime. `--runtime` selects one of its declared runtimes, and without it `wb connect <ref>` uses the first declared runtime. So `wb smoke`, `wb view`, and run preflight always name the runtime in their connect hint, such as `wb connect launch-video --runtime docker`.

`wb connect` records which compatible provider and authentication method should be preferred for that runner and runtime. A single run can select a different configured or authenticated connection without changing the default:

```sh
wb run project-core --connection openrouter --task "Review this migration"
```

An override must match one of the provider routes allowed by the Workbench. Resolution order is the explicit `--connection` override, the runner/runtime default, then the first allowed authenticated route in manifest order. Connection defaults, including the selected authentication method, are stored in `~/.workbench/connections.json`. No login command is injected into a Workbench conversation, and no Workbench package or model is modified by selecting a default.

If the selected OpenCode credential is missing, the first foreground or TUI run starts the real execution runtime, asks OpenCode for the configured browser or headless authorization flow, displays its URL and instructions, waits for completion, and then continues that same run. Detached execution refuses to start an invisible first-time login and directs the user to run interactively once. First-run Pi login and API-key entry during a run are not implemented; connect the key with `wb connect` or pass it with `--env-file`.

The provider menu is the intersection of providers serving catalog models and the selected harness version's capability map; model availability alone never implies that a harness supports a provider. Versioned harness maps may be delivered with the verified model metadata, with an engine-bundled map for the pinned harness version as the offline and compatibility fallback. Runtime-specific constraints, such as browser versus headless authentication, remain enforced by the engine.

Local Workbenches use the runner's normal local credential store. Docker keeps each runner's native credentials in a private named volume. E2B keeps each runner's native credentials beneath the private Workbench data directory, copies that store only into fresh E2B sandboxes using that runner, and synchronizes changes back during orderly cleanup. The E2B control key and native provider credentials are separate: `E2B_API_KEY` stays on the host, while the runner's provider credential must exist inside the sandbox so the runner can authenticate. Credentials are never written to the Workbench package, workspace, run records, normalized events, or artifacts.

Environment-backed provider routes remain supported through inherited environment, `--env-file`, or `--env`. The CLI checks whether an allowed route is ready but does not interpret or rewrite provider tokens. Because some runners keep all provider logins in one native file, an E2B sandbox receives the native store for that runner rather than a parsed provider-specific subset. Treat the sandbox provider and Workbench image as part of the credential trust boundary.

Pi is distributed separately by the Pi project and must be installed in the selected runtime:

```sh
npm install -g @earendil-works/pi-coding-agent
```

Bind additional repositories or directories only when the manifest declares them:

```sh
wb run project-core --dir ./app --workspace api=../api \
  --workspace schemas=../schemas --task "Review the cross-repository change"
```

Required bindings fail before runner launch. Inside a local run, the resolved paths are exposed as `WORKBENCH_WORKSPACE_API` and `WORKBENCH_WORKSPACE_SCHEMAS`. Docker and E2B use the same names with deterministic paths such as `/workspaces/api`. Docker enforces read-only declarations at the mount boundary. E2B stages isolated copies and returns declared read-write changes as pending outcomes for explicit acceptance. Local access declarations are preflight checks, not an operating-system sandbox.

Use `--dry-run` to inspect the translated runner invocation without executing it. An interactive terminal shows a concise summary; `--json` or piped output returns the complete translation:

```sh
wb run project-core --task "Review this migration" --dry-run
```

### Requirements and runtimes

A `spec: 1` Workbench declares what its environment must satisfy with `requirements` (optional) and the providers it supports with `runtimes` (required). Spec 0 is frozen legacy and keeps its single `runtime` with top-level `image` and `docker`; spec 1 rejects those three fields, and spec 0 rejects `requirements` and `runtimes`. The engine reads both specs and treats a spec 0 `runtime` as a one-entry `runtimes` map internally. `wb init` writes spec 1.

```yaml
spec: 1
requirements:
  os: [linux]
  arch: [x64, arm64]
  cpu: 4
  memory_gb: 8
  gpu: false

runtimes:
  local: {}
  docker:
    image: ghcr.io/example/project-workbench:0.4.0
  e2b:
    image: ghcr.io/example/project-workbench:0.4.0
```

The providers are `local`, `docker`, `e2b`, and `daytona`. `daytona` requires a `class` of `linux`, `windows`, `gpu`, or `macos`. `image` is optional in the schema, but the reference engine cannot prepare a daytona entry without a published `image`. Only the `linux` class runs today. The sandbox is created from the daytona entry's own image; there is no fallback to the docker entry's image.

`run`, `smoke`, `build`, and `create` accept `--runtime <name>`. Without it the first declared runtime is used. Naming a runtime the Workbench does not declare fails and lists the declared ones. A resumed session keeps the runtime it started on.

```sh
wb view project-core
wb smoke project-core --runtime docker
wb run project-core --runtime e2b --task "Review this migration"
```

`wb view` lists every declared runtime and the requirements. Requirements are checked against the selected runtime before anything is prepared or launched:

- Local compares OS, architecture, CPU count, and total memory with the host. A GPU requirement cannot be verified locally and is refused unless you pass `--allow-unchecked-gpu` to `run`, `smoke`, or `create`.
- Docker and E2B need `linux` in `os` or no `os` constraint, and refuse a GPU requirement. Docker also needs the host architecture in `arch` and applies `cpu` and `memory_gb` as container limits. E2B does not enforce `arch`, `cpu`, `memory_gb`, or `disk_gb` in this engine, and `smoke` reports them as unchecked.
- Daytona needs its class to match `os`: `linux` needs `linux`, `macos` needs `macos`, `windows` needs `windows`, and `gpu` needs `linux` with `gpu: true`. The engine runs only the `linux` class and refuses `gpu: true`. It applies `cpu`, `memory_gb`, and `disk_gb` as the sandbox's resources, and `smoke` reports `arch` as unchecked.

### Run in Docker

A Docker Workbench can name a published OCI image or a Workbench-local Dockerfile:

```yaml
runtimes:
  docker:
    image:
      build: ./Dockerfile.workbench
      context: .
```

`run` automatically pulls or builds the declared image. Use `build` to prepare it explicitly, then `smoke` to verify the runner, declared tools, authorizations, instructions, and skills inside the container. `smoke` makes no model request:

```sh
wb build project-core
wb smoke project-core
wb run project-core --task "Review this migration"
```

Publish a locally built image to the Workbench OCI registry after signing in. Images are published under the connected organization, the default one unless `--org <slug>` is given:

```sh
wb login --org example
docker build -t project-core-local .
wb image push project-core-local \
  --org example \
  --as project-core \
  --tag 0.4.0
```

`image push` exports the local image, skips blobs already present in the registry, uploads missing blobs in bounded chunks, and publishes the original OCI manifest under `images.workbenches.dev/example/project-core:0.4.0`. The source image can have any valid local name. Progress is written to stderr. On success a terminal shows `Pushed image · <ref>`, and piped output is `pushed<TAB><ref>`. Use `--client` to select an OCI-compatible client that supports the Docker `image save` interface.

Standard OCI clients can authenticate explicitly too. `wb image login` takes `--org <slug>` to choose the connected organization and `--client <executable>` to choose the OCI client (default `docker`):

```sh
wb image login
docker tag project-core-local \
  images.workbenches.dev/example/project-core:0.4.0
docker push images.workbenches.dev/example/project-core:0.4.0
```

Direct client pushes are subject to the registry edge's per-request body limit. Use `wb image push` for images with large layers because it controls the upload chunk size. Standard Docker pulls work for images published through either path.

The Workbench can then declare the published image:

```yaml
runtimes:
  docker:
    image: images.workbenches.dev/example/project-core:0.4.0
```

Publishing requires a Workbench registry account with access to the selected publisher. Use a versioned tag for a published Workbench and avoid changing the image behind that tag.

Published tags are pulled and execution uses the resolved repository digest. Local builds use a content-addressed cache and a staged build context that excludes common credential stores and secret-bearing files. The target workspace is mounted read-write and the Workbench package is read-only. Named workspaces are mounted beneath `/workspaces/<name>` with their declared read-only or read-write access. Generated runner state is isolated in a writable, ephemeral mount because some runners update their own configuration at launch. The container root filesystem is read-only and `/tmp` is a writable temporary filesystem. The engine does not impose a CPU, memory, or temporary-filesystem size limit in execution protocol 0 beyond the declared `requirements`.

The reference binaries currently support macOS and Linux. On platforms that expose a numeric host user and group, containers run under that identity so workspace writes retain host ownership. Docker Desktop still mediates bind mounts through its virtual machine, so filesystem performance and permission details can differ from native Linux. Images must tolerate a read-only root and write caches beneath the provided temporary `HOME`.

Interactive Docker sessions keep the runner inside the container. Pi uses its native stdin RPC transport. OpenCode's native HTTP service listens inside the container and is published only to a dynamically assigned host loopback port. Native session files live in the Workbench session's private host directory and are mounted read-write so a later container can resume the same native context.

If the Workbench itself must use the host Docker engine, it must declare that high-risk requirement:

```yaml
runtimes:
  docker:
    image: ghcr.io/example/project-workbench:0.4.0
    docker:
      engine:
        mode: host
```

The declaration is not authorization. Every smoke or run requires an explicit grant:

```sh
wb smoke project-core --allow-host-docker
wb run project-core --allow-host-docker --task "Start the local stack"
```

Host Docker access is effectively administrative access to the Docker host and can escape the Workbench container's isolation. The image must contain the Docker CLI; preflight verifies both the CLI and daemon before model execution. Host-engine runs preserve host workspace paths inside the Workbench container so nested Docker and Compose bind mounts resolve correctly. Other Docker engine modes and non-Unix contexts are rejected rather than silently substituted.

### Run in E2B

An E2B Workbench uses the same image declaration as Docker and requires an E2B API key on the host. Connect once, then run normally:

```yaml
runtimes:
  e2b:
    image:
      build: ./Dockerfile.workbench
      context: .
```

```sh
wb connect --runtime e2b
wb build project-core
wb smoke project-core
wb run project-core --task "Review this migration"
```

`wb smoke` makes no model request, but on E2B it creates a real sandbox to check the runner and tools, which is billable E2B usage.

The image can be a public OCI reference or a Workbench-local Dockerfile. The reference engine builds and caches an E2B template for that image, then creates a fresh sandbox for each execution. Use versioned image tags or digests because an existing template identity is reused. Images must include the selected runner, every declared tool, `git`, and GNU `tar` with `--null` support.

Before launch, the engine snapshots only the declared runtime assets. The primary workspace is staged at `/workspace`, named workspaces at `/workspaces/<name>`, and the Workbench package at `/workbench`. Gitignored workspace files, repository metadata, common credential stores, dependency trees, and common secret-bearing files such as `.env` are excluded. Read-only assets are copied into the sandbox and are never synchronized back. A separately staged asset nested beneath a writable directory is excluded from that parent snapshot. Remote edits, additions, modes, and deletions are collected against the original baseline as durable pending changesets, never automatically applied to the host. Read-write single-file assets are rejected.

Input and output transfers each have a 512 MiB safety limit, enforced against uncompressed content. The saved E2B key, or an overriding `E2B_API_KEY`, is used only by the host control plane and is never sent to the sandbox. The sandbox receives manifest-declared environment values for allowed model routes and the private native credential store for its selected runner. Connecting E2B saves the key but performs no E2B work; the separate model-provider connection path does not require the key. If a configured OpenCode credential is missing, the first real foreground or TUI run performs the headless ChatGPT authorization inside the sandbox that was created for that run, then continues the run after authorization succeeds.

E2B runner credentials live beneath `~/.workbench/runtime-credentials/e2b/<runner>`, with private directory permissions. They are staged separately from packages and workspaces, then synchronized back before the disposable sandbox is destroyed. Existing local credentials are not modified if staging or startup fails. A host process crash before cleanup can lose a newly completed remote login.

Normal completion collects outcomes before destroying the sandbox. Failure and cancellation collect partial outcomes when possible. If collection fails, the engine retains a private recovery checkpoint and pauses the original sandbox when possible. The 60-minute provider timeout pauses a crash survivor without preserving its memory. `wb clean` can find managed E2B sandboxes in the same scoped Workbench data store and removes only those whose run is terminal, or whose run is missing and whose sandbox is paused, and only when `--apply` is passed. A running sandbox with no matching local run is protected because it may belong to another host using the same scoped store. Prepared E2B templates are cached and are outside the `wb clean` contract.

Pending recovery checkpoints protect their run history and original sandbox from ordinary cleanup. Use `wb outcome <run-id> --recover` to collect partial work from that sandbox, or `--discard-recovery` to explicitly abandon it. These actions require the host's E2B key but create no new sandbox or model work.

The provider does not automatically retry template builds, sandbox creation, command starts, transfers, or native-state synchronization because an ambiguous remote outcome could duplicate billable work or replay a mutation. Cleanup is still attempted after failure. Terminal run events include E2B duration, CPU and memory shape, and a clearly marked infrastructure cost estimate when sandbox metadata is available. This stays separate from model tokens and model cost in `usage.updated`.

E2B is copy-based rather than mount-based. A resumed Workbench session runs in a fresh sandbox after its native session state and runner credential store are copied in. Outcome recovery is separate from conversation resume and requires the original checkpoint and provider filesystem to survive. Already-collected outcomes can be inspected, exported, and explicitly applied without a live sandbox or E2B key.

### Run in Daytona

A Daytona Workbench declares the `linux` class and a published image on its daytona entry:

```yaml
runtimes:
  daytona:
    class: linux
    image: ghcr.io/example/project-workbench:0.4.0
```

```sh
wb connect --runtime daytona
wb smoke project-core --runtime daytona
wb run project-core --runtime daytona --task "Review this migration"
```

`wb smoke` makes no model request, but on Daytona it creates a real sandbox to check the runner and tools, which is billable Daytona usage.

The engine creates a fresh Daytona sandbox from the image for each execution and deletes it at cleanup. It never falls back to another runtime entry's image. Daytona builds or pulls the image, so a Workbench-local Dockerfile build is refused; publish the image instead. The image must include the selected runner, every declared tool, `git`, and GNU `tar` with `--null` support. For repository runs the engine installs `git` and `gh` in the sandbox when they are missing (on Daytona, an image without `git` and `gh` needs a root user or passwordless `sudo`).

Staging, exclusions, pending outcomes, and the default 512 MiB transfer limits match E2B: `/workspace`, `/workspaces/<name>`, and `/workbench` hold isolated copies, and remote changes return as pending outcomes that only `wb outcome <id> --apply` applies. `cpu`, `memory_gb`, and `disk_gb` requirements become the sandbox's resources. The sandbox has a 60 minute lifetime: the engine sets Daytona's wall-clock TTL, which destroys the sandbox that long after creation in any state, even if the CLI process dies. It carries the labels `dev.workbenches.managed`, `dev.workbenches.run`, and `dev.workbenches.scope`.

Daytona currently has no interactive terminal, no pause or recovery, and no cost estimate. Model credentials come from the environment or `--env-file`, because there is no native credential store for interactive login. See the [Daytona provider contract](EXECUTION.md#reference-daytona-provider) for the full list of limits.

### Returned results

Each durable execution collects changesets, artifacts, and links into an immutable outcome before disposable runtime cleanup. Local and Docker changes are already present in mounted host directories. E2B and Daytona changes remain pending until you accept them explicitly:

```sh
wb outcome wb_...
wb outcome wbo_... --json
wb outcome wbo_... --export ./review-bundle
wb outcome wbo_... --apply
```

Apply checks the producing run's workspace bindings and original fingerprints before changing any file. Conflicts leave host files untouched. Export creates a self-contained bundle and refuses an existing destination. Neither action requires another model turn, harness login, or runtime key.

A Workbench can write reports, screenshots, images, or other files beneath `WORKBENCH_OUTPUT_DIR` with its harness's existing tools. An optional top-level `outcome.json` adds summary, artifact metadata, and HTTP/HTTPS links. Original artifact bytes are preserved without image resizing or transcoding. The CLI and TUI link to local files rather than rendering images inline; `/outcome` inspects results from chat. A PR link is returned data, not permission for the engine to publish a branch or open a PR automatically.

The result store enforces per-file, per-outcome, and aggregate storage limits before copying bytes. Quota failures do not silently remove retained outcomes. See [OUTCOMES.md](OUTCOMES.md) for the versioned contract, outbox JSON, receipt states, recovery limits, and explicit cleanup behavior.

### Sessions and background work

```sh
wb run project-core --task "Perform the migration" --detach
# wb_...

wb attach wb_...
wb attach              # latest session
wb attach wb_... --json
wb ps                  # active and resumable sessions
wb ps --all            # all session history
wb kill wb_...
wb resume wb_...       # open or attach the terminal client
wb resume wb_... "Review the latest change"
wb resume wb_... --task "Run the checks" --detach
wb resume wb_... --allow-host-docker # reauthorize a declared host engine
wb clean                            # preview terminal history older than 30 days
wb clean --older-than 7d --apply
```

Every execution belongs to one stable Workbench session. The first run shares its `wb_...` ID with the session; later resumes create internal runs while the session ID stays fixed. Detachment only controls whether the current terminal is watching the active run. A session can also have a user-defined display name. Names make interactive surfaces easier to scan, but the stable ID remains the only automation and resume key.

Attaching observes or replays the latest run without taking control or starting model work. Resuming without a task opens the terminal client. If the latest run is active, the terminal attaches to that exact runner process. If it is closed, Workbench starts a new internal run from the runner's saved native context.

Resuming with a task sends one non-interactive continuation through the same session. It joins an active run's follow-up queue or starts a linked internal run when the previous one is closed. `--detach` returns the stable session ID while that continuation runs in the background. Killing cooperatively terminates the active run without deleting the session or its resumable context.

Headless callers can supervise the same engine without keeping a client attached:

```sh
wb run project-core --task "Review the migration" --detach --json
wb wait wb_... --timeout 120 --json
wb send wb_... "Check the rollback" --json
wb send wb_... "Focus on cleanup" --steer --json
wb send wb_... --task-file followup.txt --queue --json
wb answer wb_... request_id allow --json
```

Detached `run` and `resume` with `--json` return one launch receipt, not an event stream. `send` returns a receipt containing session/run/input IDs and an `after_sequence` cursor. Ordinary sends reject an active turn instead of silently queuing it. `--steer` requires an active execution; `--queue` explicitly requests a FIFO follow-up. Sending to a closed resumable session starts a fresh run from its saved native context. `--task-file` and `--stdin` are explicit alternatives to text, not implicit fallbacks.

Waiting with a session ID selects its latest run. A linked run ID selects that exact execution. The session and its first run share an ID, so use `--run` to explicitly pin any run, including the first. Sequence cursors belong to a single run; use the receipt's `run_id` with `--run --after` when observing a submitted input, even if the session is continued again:

```sh
wb wait wb_... --run --after 42 --timeout 120 --json
```

`wait` prints one snapshot with state, sequence, final response and usage, outcome ID, and pending permission/question/authentication requests. It returns the first completed turn after the cursor, even if queued work starts immediately. `turn_completed` means that turn replied, not that execution or runtime cleanup finished. Repeat with `--after` set to the returned `sequence` to observe the next boundary or final `completed` result. Without a cursor, observation starts at the beginning of that run. Headless authoring waits for execution and package verification instead of returning intermediate creator turns. See [Exit codes](#exit-codes). A timeout or interrupted wait never cancels the run. Waiting does not attach a controlling client, start authentication, or keep a runtime alive.

`answer` resolves only a currently reported request ID. `allow` grants a permission once; `deny` rejects it. Multiple questions accept JSON string arrays, such as `[["First option"],["Second option"]]`. Use `--response-file`, `--stdin`, or `--reject` when appropriate. Authentication requests expose the runner's URL and instructions, never a credential-submission channel. `ps --json` includes `state`, `needs_input`, and pending requests. Native runner capabilities still apply: these commands do not invent permissions or questions for a harness that does not support them.

Run and session data is never removed by `wb clean` until `--apply` is passed. The default policy selects terminal, non-resumable sessions and obsolete run history older than 30 days. Active runs are never eligible. Native resumable context and its latest run are protected unless `--include-sessions` is also passed. Repository sessions also retain all earlier attempt outcomes needed for cumulative delivery until the session is removed. To explicitly clear all terminal history, including resumable context, use `wb clean --older-than 0s --include-sessions --apply`. `--json` returns the same preview or result as a machine-readable report, including byte counts and protected resources.

Durable Docker runner containers and E2B sandboxes carry Workbench ownership metadata scoped to the current data directory. Normal exits destroy them. `wb clean` detects scoped resources whose run is terminal. It also detects Docker containers whose run is missing and paused E2B sandboxes whose run is missing. Removal still requires `--apply`. It does not remove images, build caches, E2B templates, runner credential volumes, or unrelated runtime resources.

### Interactive client

Running `wb run <name>` without a task opens the terminal client. `wb` and `workbench` show command help.

```sh
wb run project-core
```

The OpenCode interactive adapter currently supports multi-turn context, streaming, image input, cancellation, tool events, explicit permission decisions, native questions, and native mid-turn steering in local, Docker, and E2B runtimes. The Pi adapter supports multi-turn context, streaming, image input, steering at Pi's next legal model boundary, follow-up input, cancellation, and tool events. Pi does not provide native question or permission request protocols, or native MCP transport.

Questions use one runner-neutral contract for choices, free-form answers, and multi-select prompts when the selected runner exposes a native question protocol. The terminal client pauses on a normalized question and returns the response through that native protocol. Question prompts are part of the normalized event stream. The raw answer control message remains transient and is not written as event data. A runner can still reference the answer in later assistant output. OpenCode can submit a batch of prompts and multi-select choices.

While a response is active, submitting another message steers the current turn. The message stays visibly queued until the runner confirms delivery. `Ctrl+C` cancels an active turn without closing the session. For image-capable runners, drag a PNG, JPEG, GIF, or WebP file into the composer, or paste its local path. Attachment bytes remain transient and are not copied into normalized events. Image generation and normalized image output are not implemented yet.

Type `/` or press `Ctrl+K` to browse local terminal commands. The initial command set covers Workbench, runtime, model, capability, session, and staged attachment details; attachment and transcript clearing; turn cancellation; themes; and clean exit. Commands are handled by Workbench and are never sent to the runner as prompts. `/theme` includes the Workbench default, Flexoki, GitHub, Catppuccin, and Night Owl themes. The adapted themes are attributed in `NOTICE`.

Use `/rename <name>` to give the current session a durable display name. The name appears in `/resume`, the active chat header, and `wb ps` without changing the Workbench package, native runner session, or stable `wb_...` ID. When the terminal client exits a native resumable session, it restores the terminal and prints the stable ID with a copyable `wb resume <id>` command. It does not print a resume handoff for a failed start or a runner without native resume support.

Use `/improve [feedback]` from an idle local Workbench session to open the official creator with bounded, normalized evidence from that session. Feedback is optional. With plain `/improve`, the creator diagnoses improvements from the conversation, tool activity, and run outcome, and you can steer it normally in the creator session. The creator edits the source package, not the immutable package already loaded by the active run. Run evidence is treated as untrusted data, and the authoring record captures the creator version and digest, source session, package digests, and changed files. The same flow is available outside the terminal client:

```sh
wb create --from wb_... \
  --feedback "The migration path missed our rollback convention"
```

Changes apply only to future runs. Every session resumes from the package bytes it captured at start, regardless of later source edits.

Session-capable runs use one background session worker whether they begin in the terminal client, foreground CLI output, or detached mode. Normalized events survive a client disconnect. Another terminal client can take control of the same live runner, while `wb attach` can observe it without taking control. Exiting the terminal client detaches it; an active turn and queued follow-ups continue, then the unattended worker closes while its native context remains resumable. User prompts, permission decisions, and question answers are transient control messages, not durable run history.

Supported sessions can be reopened with `wb resume <session-or-run-id>` or from the TUI's `/resume` browser. The browser is scoped to the active workspace. On a bare invocation that is the current working directory; a directory selected in the TUI, an explicit `--dir`, or a resumed session uses its recorded workspace. An active session is reattached instead of duplicated. A closed session creates a new durable run linked to the same stable session. Workbench keeps a small private session index and a disposable transcript presentation cache. The selected runner remains the source of truth for model context: OpenCode resumes from its session database and Pi resumes from its session file. Docker mounts native state into each new container. E2B copies native state into each new sandbox and synchronizes it back on orderly cleanup. A session remains locked to its original Workbench version, runner, model, runtime, workspace, and workspace bindings. Docker credentials remain in the runner's private named volume. E2B runner credentials persist in private runtime storage independently of native session state. A Workbench that declares host Docker access must be explicitly reauthorized with `--allow-host-docker` for each resumed run.

### Registry organizations

`wb login` runs a browser approval that connects exactly one organization and stores a key for it in `~/.workbench/credentials.json` (mode 0600). Every account has a personal organization by default. The CLI holds keys for several organizations per registry URL, with one default:

```sh
wb login                 # first login becomes the default
wb login --org example   # connect example and make it the default
wb org list              # held organizations, default and expiry
wb org use example       # change the default
wb whoami                # default organization, user, scopes, key expiry
wb logout --org example  # revoke that key and forget it
```

`--org` on `login` must match the organization approved in the browser, or nothing is stored. `wb push`, `wb publish`, `wb unpublish`, and `wb image push` use the default organization, or the one named with `--org <slug>`. `wb logout` without a flag signs out of the default; removing the last key deletes the credential file. `--publisher` was removed and now fails with a pointer to `--org`. A credential file from an older CLI is ignored: run `wb login` once.

### Internal workbenches, push, publish, unpublish

Every organization workbench is internal by default: members and organization keys see it, nobody else does. Anyone else receives a plain 404. Publishing is the single explicit act that makes a stored version public, and it always goes through review.

```sh
wb push [source] [--org <slug>] [--as <name>]
wb publish <org/name | source> [--org <slug>] [--version <semver>]
wb unpublish <org/name> [--org <slug>]
```

`wb push` uploads the package as a new immutable version. `source` is a local package reference (`.#name`, `/path#name`, default `.`) or a saved alias. The workbench is created as internal when missing. `--as` sets the registry name instead of the manifest name. Each push needs a manifest version greater than the latest stored one, and a public workbench takes new versions only through `wb publish`; the registry rejects both cases with a conflict and the CLI prints its message unchanged. Output is `Pushed acme/ios-expert@1.2.0 (internal)`; the machine record is `push`, `org/slug`, `version`, `digest`.

`wb publish` submits a stored version for public review. With `org/name` it resolves the workbench with the organization's key and submits its latest stored version. `--version` is accepted only when it names that latest version, because the registry exposes no version lookup yet. With a local source it submits the package directly for review, without storing an internal version first; this is how a public workbench takes a new version, because the registry refuses `wb push` to a public workbench. It prints the submission id, status, and dashboard URL. A pending submission is not public.

`wb unpublish` resolves `org/name` and flips a public workbench back to internal immediately. `--org`, when given, must match the organization in the reference. `--private` was removed: internal is the default, and publish never means internal.

Registry reads attach a held key automatically. For `publisher/name`, the key of the organization whose slug matches `publisher` is used; otherwise the default organization's key; otherwise the request is anonymous. There is no CLI search command. Expired keys are never sent, and keys go only to the registry, never to GitHub. A 404 for a publisher you hold no key for suggests `wb login --org <publisher>`. Saved snapshots record their visibility, shown as `internal` by `wb list --saved` (a trailing column in machine output) and `wb view`; `origin.visibility` in `wb view --json` keeps the wire value `private`. `wb upgrade` reuses the same key rule.

## Source and authorization boundaries

Remote `list`, `validate`, `view`, and `smoke` operations are read-only. Public GitHub repositories require no credentials. Private repositories can use `GITHUB_TOKEN` or `GH_TOKEN`; inaccessible private repositories and missing repositories are reported without pretending GitHub distinguishes them.

Environment values never belong in `workbench.yml`. A manifest declares their names and whether they are required; the person or host starting the run provides the values through inherited environment, `--env-file`, or `--env`. Dry runs, saved package metadata, and normalized events do not expose those values.

For the `local` runtime, declared tools must exist on the host. For the `docker` or `e2b` runtime, declared tools and the runner must exist inside the resolved image; host installations do not satisfy the requirement. Only manifest-declared environment values, credential variables for the selected model provider, and the selected runner's private native credential store are bound into the execution environment. `E2B_API_KEY` remains host-only. Secret values do not appear in Docker command arguments or durable Workbench metadata. Preflight failure stops execution before model tokens are spent.

## Stability

Workbench 1.0 promises a scoped stable surface. Within 1.x these do not change incompatibly:

- the spec 1 manifest
- the `wb run`, `wb resume`, and `wb attach` `--json` event stream (`protocol: 0`)
- the `wb wait --json` result and the `wb send --json`, `wb answer --json`, and detached `wb run --json` and `wb resume --json` receipt shapes
- `wb smoke --json`
- the documented exit codes below
- `install.sh` and `wb update`

Everything else may change in a minor version: human-readable output, piped tab-separated output, and other flags and commands. Parse `--json`, never the human renderer.

The run event protocol keeps `protocol: 0` and its schema at `schemas/events/v0`. It is versioned separately from the manifest spec number, and changing it would break existing clients. Within `protocol: 0`, minor versions may add new event types and new optional data fields; existing types and fields keep their meaning. Clients must ignore event types and fields they do not recognize. Spec 0 manifests stay readable by every 1.x engine.

### Anonymous counts

The CLI reports anonymous save and run counts only for registry Workbenches whose publisher organization is one you do not hold a login for, meaning the CLI stores no organization key for that publisher at that registry's API URL. Saves and runs of your own organizations' packages, local paths, GitHub sources, and private versions are never reported. A report carries the immutable version ID, the kind (`save` or `run`), the CLI version, and a timestamp, and no execution content.

Before the first report, the CLI prints once: "Workbench reports anonymous save and run counts for registry Workbenches published by other organizations. Set DO_NOT_TRACK=1 to disable." The only opt-out is the `DO_NOT_TRACK` environment variable set to any non-empty value other than `0`. It suppresses every report and the notice.

### JSON contracts

These are the exact fields of the stable `--json` results. Additive fields may appear in minor versions; existing fields keep their meaning.

**`wb wait --json`** prints one object:

- `session_id`, `run_id`, `state`, `sequence`, `final`, `usage`, `usage_total`, and `pending_requests` are always present.
- `outcome_id`, `error`, `interrupted`, `repository`, `delivery`, `run_state`, and `authoring` are present only when they apply.
- `state` is one of `starting`, `running`, `idle`, `turn_completed`, `completed`, `failed`, `cancelled`, `needs_input`, or `timeout`.
- Each `pending_requests` entry is `{id, kind, sequence, details}`, where `kind` is `permission`, `question`, or `authentication`.
- `usage` is the delta since `--after` (0 by default) and `usage_total` is the run total. Both carry a `kind` of `delta` or `total`, and the token counts and `cost_usd` the runner reported.

**`wb send --json` and `wb answer --json`** print `{session_id, run_id, input_id, after_sequence, receipt?}` on success. `receipt` is `{version: 1, id, kind, outcome, resolved_at, disposition?, error?}`. A failure prints `{error: {code, message}}`, or `{receipt, error}` when the run rejected the input.

**Detached `wb run --json` and `wb resume --json`** print `{session_id, run_id, input_id, after_sequence}`. A resume may also include `receipt`.

**`wb smoke --json`** prints one NDJSON line per package: `{status, workbench, version, runtime, runner?, tools, authentication?, requirements?, workspaces, docker_engine?, warnings, error?}`.

- `status` is `ready`, `needs-auth`, or `failed`.
- `authentication` is `{ready, model, provider?, route?, authenticated_providers, connect_command?}`.
- `requirements` is `{checked, applied, unchecked}`.
- `error` is `{code, message}`.

A source that cannot be resolved prints `error: <message>` on stderr with no JSON line. `error.code` is `authentication_required` or `smoke_failed`.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success. For `wait`: idle, `turn_completed`, or `completed` |
| 1 | Failure |
| 2 | `wait` only: the run needs input |
| 3 | No authenticated model route or runtime credential. Any command can return it, including `run`, `resume`, `attach`, `send`, `smoke`, `build`, `create`, `connect`, and `outcome --recover`. `wait` reports such a run as failed (1). |
| 124 | `wait` only: timeout. The run is unchanged |
| 130 | Cancelled or interrupted |

## Specification and documentation

- [SPEC.md](../SPEC.md) defines the Workbench package: spec 1 is the standard and spec 0 is frozen legacy.
- [EXECUTION.md](EXECUTION.md) defines the execution protocol (`protocol: 0`).
- [OUTCOMES.md](OUTCOMES.md) defines portable run results and explicit apply, export, and recovery behavior.
- [SOURCES.md](SOURCES.md) documents reference-engine source and workspace behavior.
- [RELEASING.md](RELEASING.md) documents the versioned binary release process.
- [`schemas/`](../schemas) contains the normative JSON Schemas.

The specification and schemas are the interoperability contract. The CLI is a reference implementation, not the only permitted host.

## Development

The reference CLI uses strict TypeScript, Citty, and Bun. From a clean checkout:

```sh
bun install --frozen-lockfile
bun run check
bun run test:coverage
bun run test:docker
bun run test:docker:sessions
bun run test:e2b
bun run test:e2b:sessions
bun run test:daytona
bun run test:outcomes:harnesses
bun run test:outcomes:browser
bun run build
```

`test:docker` requires a running Docker daemon and network access to pull its pinned fixture image. It exercises the real container boundary; the default test suite uses deterministic provider doubles and does not require Docker. `test:docker:sessions` additionally runs real multi-turn and native-resume probes for OpenCode and Pi. It requires previously connected runner credentials and makes model-provider requests.

`test:e2b` requires `E2B_API_KEY`, builds a real E2B template, exercises remote streaming, PTY input, pending workspace outcomes, original-sandbox result recovery, cross-sandbox credential persistence, and sandbox destruction. `test:e2b:sessions` additionally starts OpenCode in two fresh sandboxes and verifies native session resume. It requires a supported model-provider key and makes model-provider requests.

`test:daytona` runs only when `DAYTONA_API_KEY` is set. It creates a sandbox from `debian:bookworm-slim`, runs a command, transfers a file in both directions, follows a background command, requests a preview URL, deletes the sandbox, and confirms by listing the run's label that nothing is left. It uses Daytona usage and is skipped unless both `DAYTONA_E2E=1` and the key are set.

`test:outcomes:harnesses` exercises OpenCode and Pi through the public CLI on Local, Docker, and E2B. It requires `OPENROUTER_API_KEY`, a running Docker daemon, and `E2B_API_KEY`. It makes real model-provider requests and verifies tool-created changes in primary and named workspaces, exact binary artifact bytes, link metadata, outcome publication before completion, keyless inspection and export, explicit E2B application, and native context resume. Set `WORKBENCH_OUTCOME_RUNTIMES=local`, `docker`, or `e2b` to run a subset. Docker fixtures build native-runner images by default; existing images containing the corresponding runner may be reused through `WORKBENCH_OUTCOME_DOCKER_OPENCODE_IMAGE` and `WORKBENCH_OUTCOME_DOCKER_PI_IMAGE`. `WORKBENCH_OUTCOME_CLI` may point at an isolated compiled binary to run the same checks against release packaging. These overrides are test-only.

`bun run check` runs type checking, Biome, and the unit and integration suite. The compiled `dist/workbench` binary is self-contained and does not require Bun on the target machine. Distribution builds include the repository license and notice.

Both `workbench` and `wb` are package binary names. Commits use Conventional Commits and are checked by the repository's `commit-msg` hook and CI.

### Embedding engine modules

The reference engine is also a set of modules a host can import. The package `exports` map names them by subpath, and the root export is unchanged:

| Subpath | Contents |
| --- | --- |
| `./manifest`, `./requirements`, `./runtimes/selection`, `./types` | Manifest parsing, requirement checks, runtime selection, and shared types |
| `./events` | The normalized run event protocol |
| `./models` | Model routing over a catalog snapshot, with `ModelRouter.configureOpenCode` for a chosen provider route |
| `./outcomes` | Outcome contracts and validation, the `OutcomeSink` interface, `DeclaredOutput`, and `MemoryOutcomeSink` |
| `./outcomes/disk` | The disk outcome store, with quotas and leases, and applying changes to a workspace |
| `./runners/opencode/runner` | `OpenCodeRunner` and `PreparedOpenCodeRunner` |
| `./runners/opencode/skills`, `./runners/context` | `OpenCodeSkillStaging`, which stages skills and native config, and `RunnerContextStaging`, which stages context files |
| `./runners/opencode/*` | The OpenCode adapter, session driver, server client, event translation, and invocation builder |
| `./runners/opencode/progress` | `OpenCodeProgress`, the value a session's `progress()` returns and `restoreProgress` takes |
| `./runners/files`, `./runners/files/disk`, `./runners/files/memory` | The `RunnerFiles` interface and its disk and in-memory implementations |
| `./runtimes`, `./runtimes/contracts` | The runtime registry and the provider contract |
| `./runtimes/daytona` | The Daytona provider, its client interfaces, and `DaytonaApi`, a `fetch`-based client |
| `./runtimes/e2b`, `./runtimes/e2b/contracts` | The E2B provider with its client interface |
| `./runtimes/remote/disk` | `DiskTransfer`, the `RemoteTransfer` that stages through temporary files, for any remote provider |
| `./runtimes/staging` | The `AssetSource` and `RemoteTransfer` interfaces, `TransferRules`, `MemoryAssetSource`, `MemoryTransfer`, and byte-array tar and diff helpers |
| `./runtimes/assets`, `./runtimes/assets/disk` | The `AssetSource` interface and `DiskAssetSource` |

Storage and credentials are injected, and the portable modules import none. A host builds `OpenCodeSkillStaging` and `RunnerContextStaging` over its `RunnerFiles` and passes the staging to `OpenCodeRunner` as `skills`, with the model catalog snapshot as `catalog`. The E2B provider reads package and workspace files through an `AssetSource` (`assets`) and takes engine-owned native state from a second one (`local`). It stages and collects through temporary files itself and takes no transfer dependency. The Daytona provider takes everything it touches through its constructor: a `RemoteTransfer` (`transfer`) that packs files and collects changes, an `AssetSource` (`assets`), a `keys` object that answers `key('daytona', environment)`, a `connector` whose `open(key, apiUrl)` returns the `DaytonaClient` for a request's key, and a `clock` that reads the time and waits between retries. `RuntimeRegistry` supplies the system clock. `DaytonaConnector` is the reference connector, built over the `fetch` a host supplies; a host with its own client passes a connector that returns it. `MemoryTransfer` and `DiskTransfer` implement `RemoteTransfer` over the `AssetSource` and `TransferRules` the host constructs them with. Collected content goes to an `OutcomeSink` the caller passes to `collectOutcome`. The CLI passes the disk for all of these. A host passes stores of its own, or the in-memory ones.

Every subpath in the `exports` map is portable except the root and the disk-backed ones: `./outcomes/disk`, `./runners/files/disk`, `./runtimes/assets/disk`, `./runtimes/remote/disk`, `./runtimes/e2b`, and `./runtimes`. A test bundles each portable subpath with `Bun.build` and fails if the output imports `fs`, `os`, `zlib`, `stream`, `child_process`, or any built-in module outside this list, with or without the `node:` prefix. A host must provide `node:path`, `node:crypto`, `node:util`, `node:buffer`, and `node:events`. Today the portable subpaths import only `node:path` and `node:util`, and the rest of what they need is global: web `crypto`, `fetch`, and the Compression Streams API. `./runtimes/daytona` also imports `node:crypto`. The test checks imports in the bundle. It does not run the bundles in another runtime. It also checks that each disk-backed subpath does import a filesystem, process, or compression module, so the list stays accurate. The disk implementations live in those separate subpaths that the CLI wires in, and a portable module never imports one, statically or dynamically.

#### In-memory transfer

`MemoryTransfer` packs each asset into a gzip tar in memory and reads the changes a run made as tar entries, so nothing touches a disk. The changeset matches the disk transfer's entries, statistics, and base digest for the same tree. Its review diff is rendered in TypeScript without `git`: it reads like `git diff`, omits `index` lines, and reports a binary change as "Binary files differ" rather than a patch. Symbolic link modes are not compared, since they carry no meaning. Runner-owned native state, such as a session database, is the host's to keep, so `MemoryTransfer` does not copy it out, and it does not stage native credential storage.

#### Reconnecting after a restart

A remote sandbox outlives the process that created it. Read `sandboxId` from the runtime after `preflight`, and keep it with the native session id and the runner server's password. After a restart, `adopt` binds a new runtime to the running sandbox without uploading anything:

```ts
const runtime = await provider.adopt(request, sandboxId);
await runtime.preflight();
```

`request` must describe the same assets as the original, and the files they name must be unchanged, because the runtime reads them again to record what was staged and recovers each workspace's Git baseline from the sandbox. `preflight` fails when the sandbox does not exist or is not running, and never deletes a sandbox it did not create. `launchService` then attaches to the runner server still listening in the sandbox and leaves it running, or starts one if nothing is listening. Start the session with the same password and the original native session id so it resumes the native session. `cleanup` deletes the sandbox, as for a prepared runtime.

Only Daytona has `adopt`. E2B keeps its own outcome-recovery state and template lifecycle, so reconnecting there is not offered yet. The CLI does not call `adopt`: `wb attach` observes stored events and does not reconnect to a live sandbox.

A session that lost its event stream, or restarted, calls `resumeTurn`:

```ts
await session.resumeTurn(); // the OpenCode session driver
```

It subscribes to events again and reads the session's transcript, so text, tool activity, and usage produced while disconnected are emitted and in order, then it follows the turn until it completes. It covers the turn's steering inputs and their answers. A prompt that is still waiting settles normally. A call made while another is running returns that call's promise, and closing the session ends a running catch-up with an error. The event protocol is unchanged.

Dedupe state lives in the session. `session.progress()` returns an `OpenCodeProgress`, importable from `./runners/opencode/progress`, as plain JSON: the session and the turn it belongs to, the characters emitted per native text part, and the tool calls and usage steps reported. A host saves it as the turn runs, and calls `restoreProgress(saved)` on the session started after a restart, before `resumeTurn()`, so only what the host has not seen is emitted. `restoreProgress` rejects progress saved for another session or another turn. Without it a new session replays the whole turn.

The host must keep the latest value it received, whole, and must not edit, merge, or trim it: a missing id makes the session emit that tool call or usage step again, and a larger count skips text the host never saw. Delivery is exactly once only if the host stores the progress atomically with the events it stored. A value older than the events stored makes the session emit some of them again; one newer skips events the host never stored. Text is counted after the host's `emit` resolves, so an event whose `emit` failed is sent again. Text counts are UTF-16 code units, the unit of a JavaScript string length. A transcript that rewrites text already emitted, rather than extending it, is not sent again: only text past the count is emitted. A catch-up that fails leaves the session failed so a later one can retry, and what it already emitted is not emitted again.

#### Model routing without globals

`ModelRouter` and the runners take the catalog snapshot through their constructors and read nothing else. `ModelRouter.configureOpenCode` builds the OpenCode runner configuration for a chosen provider route, the same one `--connection <provider>` resolves, from the router's snapshot, the manifest's `model` block, and the names of the environment variables the host can supply. The CLI composes its registries from `ActiveModelCatalog.activate(snapshot)`, which sets a process-wide snapshot. The `./models` subpath exports that class as `ActiveModelCatalog`. `ModelCatalog` is the CLI's cached subclass and is exported from the package root only. The Docker, E2B, and Daytona providers, `ConnectionInspector`, and workbench inspection read that snapshot, so a host that uses them activates one first. The catalog cache on disk stays in the CLI.

## Project policies

- Use [GitHub Issues](https://github.com/pompeii-labs/workbenches/issues) for reproducible bugs and focused feature proposals.
- Use [GitHub Discussions](https://github.com/pompeii-labs/workbenches/discussions) for authoring questions and open-ended design discussion.
- Read [CONTRIBUTING.md](../CONTRIBUTING.md) before submitting a change.
- Report vulnerabilities privately according to [SECURITY.md](../SECURITY.md).
- Project decisions and maintainership are described in [GOVERNANCE.md](../GOVERNANCE.md) and [MAINTAINERS.md](../MAINTAINERS.md).
- Participation is governed by [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md).

## License

The source code, schemas, conformance fixtures, specification, and documentation in this repository are licensed under the [Apache License 2.0](../LICENSE) unless a file states otherwise. Workbench packages published by other projects are independent works and remain subject to the licenses chosen by their publishers.
