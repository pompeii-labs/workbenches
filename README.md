<p align="center">
  <img src="./assets/brand/workbench-mark-woodcut.png" alt="Workbench" width="220">
</p>

# Workbench

[![CI](https://github.com/pompeii-labs/workbenches/actions/workflows/ci.yml/badge.svg)](https://github.com/pompeii-labs/workbenches/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/pompeii-labs/workbenches?include_prereleases)](https://github.com/pompeii-labs/workbenches/releases)

**Package expert AI environments and run them anywhere.**

Models are generalists. Projects are not. Every time a general-purpose agent enters an unfamiliar codebase, it spends time and tokens rebuilding context the maintainers already have: architecture, conventions, tooling, and operating procedures.

Workbench packages that knowledge once, together with the skills, tools, runtime, harness, and model configuration needed to use it. Every compatible run starts prepared instead of paying the same knowledge ramp-up cost again.

A Workbench can run in your current directory, inside Docker, in an E2B sandbox, or against an isolated GitHub checkout. The package belongs to its author, the user brings their own model and runtime credentials, and core execution has no hosted Workbench dependency.

> Workbench is currently a public alpha implementing the draft-0 specification. Package and execution contracts may still change before 1.0.

## Quick start

### Install

Native binaries are available for macOS and Linux on arm64 and x64.

```sh
curl -fsSL https://workbenches.dev/install.sh | sh
```

The installer verifies the release checksum and creates `workbench` and `wb` commands in `~/.local/bin` by default. It does not invoke `sudo` or edit your shell startup files.

```sh
wb --version
wb update --check
```

### Connect a model provider

```sh
wb connect
```

Choose a runtime, harness, provider, and authentication method. This saves your preference without starting Docker, creating a cloud sandbox, or spending model tokens. If your harness needs an interactive login, the first foreground run will guide you through it.

Runtime credentials are configured separately. For example, save an E2B API key once with:

```sh
wb connect --runtime e2b
```

An inherited `E2B_API_KEY` still overrides the saved value for a single process.

### Inspect commands and launch a Workbench

```sh
wb
```

Search the registry, choose Add or Add and run, then choose where it should work: your current directory, another local directory, or an isolated GitHub checkout. Saved Workbenches offer Run.

You can also save and run a Workbench directly from the shell:

```sh
wb add publisher/core --as project-core
wb add https://github.com/owner/repository --name core --as project-core-git
wb add ./.workbenches/core --as project-core-local
wb run project-core "Explain this repository's architecture"
```

Use `--final` when you only want the final response or `--json` for normalized NDJSON events:

```sh
wb run project-core --task "Review this migration" --final
wb run project-core --task "Review this migration" --json
```

Remote additions are frozen until `wb upgrade`. Local additions are live: each
new run reads the registered absolute package directory. Every session captures
its own package bytes, so resumed sessions keep their original package even
after edits, upgrades, or removal. `run` accepts saved aliases only; `--dir` and
`--repo` select the work target, never the package source. `wb publish <alias>`
submits package bytes under `publisher/<manifest-name>` for registry review and
reports the returned status. `--as` only names a local alias when adding a
Workbench; it does not rename a registry publication.

## What is in a Workbench?

A Workbench is a small, versioned package owned by a project or expert:

```text
.workbenches/
  core/
    workbench.yml
    instructions.md
    skills/
```

Its manifest selects the harness, model policy, runtime, instructions, skills, tools, integrations, and environment requirements for the work:

```yaml
spec: 0
version: 0.1.0

name: core
description: Understand, review, and improve this project.

runner: opencode
model:
  id: openai/gpt-5.6-sol

instructions: ./instructions.md
runtime: local
```

The Workbench engine reads this manifest; the underlying harness does not. The engine validates the package, prepares the runtime, checks its requirements, and translates the portable configuration into the harness's native interface.

The format can package:

- maintainer-authored instructions
- a harness and model policy
- portable, on-demand skills
- required CLI tools
- remote MCP integrations
- environment variable requirements without secret values
- named workspaces for multi-repository work
- a local, Docker, or E2B runtime and image

Workbench is not a model, agent harness, task planner, or hosted orchestration service. It is the portable expert environment those systems can execute.

Read the [draft-0 specification](SPEC.md) for the complete manifest.

## Run against a GitHub repository

Any compatible Workbench can operate on an isolated checkout without touching your local project:

```sh
wb run project-core \
  --repo owner/project \
  --ref main \
  --task "Audit authentication and open a draft PR with any fixes"
```

Repository access uses `GH_TOKEN`, then `GITHUB_TOKEN`, or your existing `gh auth login`. Workbench resolves the exact starting commit and prepares the checkout in managed session storage; it does not upload or synchronize your current directory.

For Docker and E2B repository runs, the engine supplies `git` and `gh` even when the Workbench image does not. The agent uses the normal Git and GitHub CLI rather than a custom PR tool, and the engine does not silently publish work when a run ends.

## Use Workbenches as subagents

Long briefs do not need to be crammed into shell arguments. Start a detached run from a file, wait for a result, and continue the same native agent session when needed:

```sh
wb run project-core --task-file ./brief.md --detach --json
wb wait wb_... --timeout 120 --json

wb send wb_... --task-file ./followup.md --json
wb wait wb_... --run --after 42 --timeout 120 --json
```

Each command returns correlated session and run IDs. Sequence cursors belong to one run, so wait on the `run_id` and `after_sequence` returned by the command you just issued.

The repository includes a ready-to-use [Workbench subagents skill](docs/skills/workbench-subagents/SKILL.md) for coding agents that support skills. Install it globally to delegate through `wb` from any project:

```sh
npx skills add pompeii-labs/workbenches --skill workbench-subagents -g
```

## Create a Workbench

Run the official creator from the repository you want the expert to understand:

```sh
wb create core
```

The creator inspects the repository, writes `.workbenches/core/workbench.yml` and its supporting files, then validates and smoke-tests the package before finishing. Run the same command again to edit an existing local package.

For deterministic scaffolding without a model run:

```sh
wb init core
```

## Keep the results

Disposable runtimes can return three kinds of durable result:

- **changesets** for workspace edits with an explicit apply boundary
- **artifacts** for reports, screenshots, images, and other files
- **links** for external results such as pull requests

Agents use their ordinary filesystem tools to write requested deliverables to a run-specific outbox. Workbench collects those files before destroying the runtime:

```sh
wb outcome wbo_...
wb outcome wbo_... --export ./result
wb outcome wbo_... --apply
```

Local and Docker edits already live in mounted host directories. E2B changes remain pending until you explicitly apply them. Inspecting or exporting an outcome does not require another model turn or a live sandbox.

See [Returned results](docs/OUTCOMES.md) for the complete contract.

## Supported today

| Surface | Reference engine support |
| --- | --- |
| Harnesses | OpenCode and Pi |
| Runtimes | Local, Docker, and E2B |
| Interaction | Terminal UI, one-shot, detached, and resumable sessions |
| Inputs | Text and supported image attachments |
| Results | Changesets, artifacts, and links |
| Repository work | Isolated GitHub checkout with native `git` and `gh` |

OpenCode supports native permissions, questions, steering, and resume. Pi supports streaming, image input, steering at its next legal model boundary, follow-up input, cancellation, tool events, and resume. Workbench preserves the capabilities each harness actually exposes rather than inventing a common protocol they cannot honor.

## Runtime boundaries

### Local

Local Workbenches run directly on the host in the selected directory. Declared access is checked before launch, but local execution is not an operating-system sandbox.

### Docker

Docker Workbenches run in their declared image. The package is read-only, the workspace is mounted with its declared access, and runner credentials live in a private volume. Host Docker access requires a manifest declaration and an explicit `--allow-host-docker` grant on every run.

### E2B

E2B Workbenches use a reusable template built from the declared image and a fresh sandbox for each execution. Only declared assets are staged; secret-bearing files, dependency trees, and Git metadata are excluded from workspace upload. Remote changes return as pending outcomes instead of silently synchronizing back to the host.

The E2B control key remains on the host. Harness credentials are staged only for the selected harness and synchronized back during orderly cleanup. Treat the sandbox provider and image as part of the credential trust boundary.

## Command overview

```sh
wb                         # browse and launch
wb list                    # list saved Workbenches
wb view project-core       # inspect configuration and readiness
wb validate project-core   # validate a package
wb smoke project-core      # preflight without model work
wb run project-core        # open an interactive session
wb ps                      # list active and resumable sessions
wb resume wb_...           # reopen a session
wb outcome wbo_...         # inspect returned results
wb upgrade                 # update saved Workbench packages
wb update                  # update the CLI
```

Run `wb <command> --help` for command-specific options.

## Documentation

- [CLI and execution reference](docs/REFERENCE.md)
- [Workbench package specification](SPEC.md)
- [Execution protocol](docs/EXECUTION.md)
- [Outcome contract](docs/OUTCOMES.md)
- [Source and workspace behavior](docs/SOURCES.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

The specification and schemas are the interoperability contract. This repository contains the TypeScript reference engine, not the only permitted Workbench host.

## Development

```sh
bun install --frozen-lockfile
bun run check
bun run build
```

See the [complete reference](docs/REFERENCE.md#development) for Docker, E2B, real-harness, and release test suites.

## License

Workbench is licensed under the [Apache License 2.0](LICENSE).
