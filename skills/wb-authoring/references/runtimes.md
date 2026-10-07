# Runtimes, requirements, and images

Write the newest spec your installed `wb` supports: `wb init` scaffolds it and `wb validate` rejects anything else.

## Declaring runtimes

```yaml
runtimes:
  docker:
    image:
      build: ./Dockerfile
      context: .
  e2b:
    image: images.workbenches.dev/acme/game-tools:1.4.0
  daytona:
    class: linux
    image: images.workbenches.dev/acme/game-tools:1.4.0
  local: {}

requirements:
  os: [linux]
  cpu: 4
  memory_gb: 8
```

- The first entry is the default. Consumers pick another with `--runtime`.
- `local: {}` runs on the host: the runner and every tool must be installed there, and `local` takes no image. Declare it only when host execution is intended.
- `docker` and `e2b` require `image`: a published reference, or `{build: <package-relative Dockerfile>, context: <dir>}` to build from the package.
- `daytona` requires `class` (only `linux` runs today). `image` is optional in the schema, but the reference engine cannot prepare a daytona entry without a published `image`. It cannot build a local Dockerfile and does not fall back to the docker image. Pi Workbenches cannot run on Daytona yet.
- `requirements` (all optional): `os` (`linux`, `macos`, `windows`), `arch` (`x64`, `arm64`), `cpu`, `memory_gb`, `disk_gb`, `gpu`. Declare only what the work truly depends on. `local` compares them with the host; `docker` turns cpu and memory into container limits; `daytona` sizes the sandbox from them. `gpu: true` is refused everywhere except `local` with `--allow-unchecked-gpu`.
- `docker: {engine: {mode: host}}` under the docker runtime asks for the host's Docker daemon. Consumers must pass `--allow-host-docker` on every run. Use it only when the work must run containers itself.

## What happens at run time

| Runtime | Workspace | Edits | Notes |
| --- | --- | --- | --- |
| `local` | The host directory | Written in place | Host tools and credentials. |
| `docker` | Mounted at `/workspace` (rw); package at `/workbench` (ro); named workspaces at `/workspaces/<name>` | Written in place | Read-only root, `/tmp` tmpfs, `HOME=/tmp/workbench-home`, host uid and gid. Preflight has no network. |
| `e2b` | Staged in the sandbox | Pending outcome until `wb outcome --apply` | Fresh sandbox per run, 60 minute limit, 512 MiB transfer each way. Template built from the image and cached by tag. |
| `daytona` | Staged in the sandbox | Pending outcome until `wb outcome --apply` | Published image only, 60 minute limit, model keys from env only. |

## The image contract

Every image used by `docker`, `e2b`, or `daytona` must:

1. **Contain the runner** at a pinned version: `npm install -g opencode-ai@<version>`, `npm install -g @earendil-works/pi-coding-agent@<version>`, or `npm install -g @anthropic-ai/claude-code@<version>`. Nothing can be installed at run time.
2. **Contain every tool the manifest declares** in `tools`, on `PATH`.
3. **Contain `git` and GNU `tar`** (with `--null` support) for `e2b` and `daytona`, which stage files with them. `--repo` runs also use `git` and `gh`.
4. **Run as any numeric user.** The engine runs as the host's uid. Never rely on `USER`, a home directory, or files owned by root being writable.
5. **Tolerate a read-only root filesystem.** Install everything under `/usr/local`, `/opt`, or other system paths at build time, world-readable (`chmod -R a+rX`). Writable state lives only under the engine's temporary `HOME` and `/tmp`. Point caches (npm, pip, browsers) at `HOME` or bake them into the image.
6. **Expect `/tmp` and `HOME` to be non-executable** in Docker: binaries must come from the image, not be downloaded and run at run time.
7. **Pin every version**, including test tooling that must match the image. A caret range (`@playwright/test@^1.60`) re-resolves to a newer release than the browsers baked into the image and breaks every test.
8. **Say why each dependency exists**, in a comment above it, and state the contract in the Dockerfile header so the next author does not break it.

A minimal OpenCode image:

```dockerfile
# Runtime image for <name>. Runs as any numeric user with a read-only root:
# everything installs at build time, world-readable; state lives under HOME.
FROM node:22-bookworm-slim

ARG OPENCODE_VERSION=<pinned version>

# git and GNU tar: e2b and daytona stage the workspace with them.
# ca-certificates and curl: HTTPS from the runner and tools.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git tar ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# The runner.
RUN npm install -g opencode-ai@${OPENCODE_VERSION} \
    && chmod -R a+rX "$(npm root -g)"

# The tools this Workbench declares, pinned.
# RUN ...

WORKDIR /workspace
```

Start from a base that already carries heavy dependencies when the work needs them (a browser automation image for UI work, a language toolchain image), and add the runner and tools on top.

For Claude Code, replace the OpenCode runner block with a pinned install:

```dockerfile
ARG CLAUDE_CODE_VERSION=2.1.292

# The runner. Keep this at or above Workbench's minimum supported version.
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}
```

## Building and publishing images

- `image: {build: ./Dockerfile}` lets `docker` consumers build from the package. `wb build <alias>` builds and caches it ahead of time.
- `daytona` needs a published image. `e2b` can build from the package's Dockerfile, but a published image avoids a template build on each new tag, and `docker` consumers benefit from one instead of building locally. Publish it with the wb-publishing skill (`wb image push`) and reference it with a versioned tag, never `latest`. Never overwrite a tag a released version references.
- Smoke every declared runtime. Smoke on `e2b` and `daytona` creates a billable sandbox.

## Workspaces and git

- A git worktree does not work in `docker`: its `.git` file points at the parent repository, which is not mounted. Tell users to give containerized runs a full clone.
- If the work commits, say in the instructions to commit at every working step, so a crash costs minutes, not hours.
