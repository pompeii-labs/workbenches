---
name: wb-cli
description: Install, set up, and troubleshoot the Workbench CLI (`wb`). Use when `wb` is missing or outdated, when a Workbench run fails preflight (no authenticated route, missing runner or tool, missing E2B or Daytona key, image problems), when choosing or connecting model providers and runtimes, or when you need the exact command, flag, output format, or exit code for `wb`.
license: Apache-2.0
---

# wb CLI

`wb` (also installed as `workbench`) is the reference engine for Workbenches: versioned packages of instructions, model, runner, skills, tools, and runtime that do one class of expert work. You drive it; the person you work for owns the credentials and pays for runs.

## Install and update

```sh
wb --version
```

If that fails, ask the person before installing it. macOS and Linux on arm64 or x64; no Windows. Download the official installer, read it, then run it:

```sh
curl -fsSL https://workbenches.dev/install.sh -o wb-install.sh
sh wb-install.sh
```

The installer verifies a SHA-256 checksum, writes `workbench` and a `wb` symlink to `$XDG_BIN_HOME` when set, else `~/.local/bin` (override with `sh wb-install.sh --bin-dir DIR` or `WORKBENCH_INSTALL_DIR`), never uses `sudo`, and never edits shell startup files. `~/.local/bin` is often not on `PATH`. For the current shell run `export PATH="$HOME/.local/bin:$PATH"`. To make it permanent, tell the person to add that line to their shell profile (`~/.zshrc` or `~/.bashrc`) instead of editing it yourself.

The default installs the newest stable release; `--version` pins any version, prereleases included.

The CLI reports anonymous save and run counts, but only for registry Workbenches published by an organization the person holds no login for. Own organization packages, local paths, GitHub sources, and private versions are never reported. A one-time notice appears before the first report, and `DO_NOT_TRACK=1` disables reporting.

`wb update --check` reports a newer release; `wb update` replaces the binary in place. `wb upgrade` is different: it refreshes saved Workbench packages, not the CLI.

## The runner must exist

`wb` does not ship a model harness. Every Workbench names a runner, and the runner must be installed where the run happens: on the host for the `local` runtime, inside the image for `docker`, `e2b`, and `daytona`.

- `opencode`: as root, `npm install -g opencode-ai`. As a non-root user that fails on the global prefix; use `npm install -g --prefix ~/.local opencode-ai`, which installs to `~/.local/bin`.
- `pi`: `npm install -g @earendil-works/pi-coding-agent` (as non-root, add `--prefix ~/.local`).
- `claude-code`: `npm install -g @anthropic-ai/claude-code`. As a non-root user, use `npm install -g --prefix ~/.local @anthropic-ai/claude-code`.

`wb` finds the runner by looking up its name on `PATH`, so a non-root install must put `~/.local/bin` on `PATH`, as above.

Missing runner on the host: `Runner CLI is unavailable: opencode. Install opencode and rerun this command.` (`claude` for Claude Code). Missing tool: `Required CLI tool is unavailable: <tool>`.

## First run, safely

```sh
wb list owner/repository          # packages a repo publishes under .workbenches/
wb add owner/name --as expert     # save a registry Workbench (org/name)
wb view expert                    # runner, model routes, runtimes, auth readiness
wb smoke expert                   # prepare runtime, check runner, tools, auth
wb run expert --task "..." --final
```

`run` accepts only a saved alias. Save registry packages as `org/name` (a bare name is not a registry reference), GitHub packages with `wb add https://github.com/o/r --name <pkg> [--ref <ref>]`, and local packages by path. Internal registry packages need `wb login --org <org>` first.

`smoke` makes no model request. On `local` and `docker` it is free. **On `e2b` and `daytona` it creates a real, billable sandbox.** `run`, `resume`, `send`, and `create` spend model tokens, and sandbox time on cloud runtimes. Say what a command will spend before running it on the person's behalf.

## Model credentials

A manifest names a model (`lab/model`) and optionally ordered provider `routes`. With no `routes`, every provider in the model catalog that serves the model is allowed, the lab's own provider first. A run uses the first route that is authenticated, in this order:

1. `--connection <provider>` on `run` or `resume`, if authenticated.
2. The default saved by `wb connect` for this runner and runtime, if authenticated.
3. The first route in manifest order with a key in the environment.
4. The runner's own credential store (OpenCode `opencode auth`, Pi's config), for `local`, `docker`, and `e2b`. Daytona has no credential store: env only.

Keys come from the environment of the `wb` process, plus `--env-file FILE` and `--env NAME=value`. Each provider has fixed variable names, for example `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY` or `GOOGLE_API_KEY`, `XAI_API_KEY`, `MISTRAL_API_KEY`, and `AI_GATEWAY_API_KEY` (Vercel). After a route is chosen, other providers' keys are stripped from the run. `wb view <alias>` shows each route and which one is ready.

Every runner uses the same model catalog, route ordering, connection precedence, and inspection contracts. `wb connect` lists only the provider and subscription methods available for the selected runner and runtime.

There is no single required provider. If a run asks for a key the person does not have, check `wb view` for the other routes; an OpenAI or Anthropic key is often enough where an example used OpenRouter. Details and every error text are in [references/connections.md](references/connections.md).

`wb connect <alias> --runtime <runtime>` saves the default route for that runner and runtime, puts the provider credential into the store that runtime reads, and checks it. It ends with `Ready: <Provider> for <Runner> in <runtime>` (`Saved:` when the first run confirms a remote store), or exits 3 naming what is missing and the one command that fixes it. Run it with the `--runtime` from the smoke or run hint. Unattended, the only way to give a key is standard input (`--stdin`); hidden key prompts and subscription sign-ins need a person at a terminal. `wb connect` never reads or copies the person's own runner sign-in. For a one-off run, `--env-file` works without connecting. Details are in [references/connections.md](references/connections.md).

Never print, `cat`, or echo a key or an env file to check for it. Check by variable name only, for example `test -n "$OPENAI_API_KEY" && echo set`.

## Runtimes

A Workbench declares the runtimes it supports; the first is the default. Choose another with `--runtime` on `run`, `smoke`, `build`, and `create`. A resumed session keeps its runtime.

| Runtime | Needs |
| --- | --- |
| `local` | The runner and tools on the host. Edits land in the working tree. |
| `docker` | A Docker-compatible CLI and daemon. The image holds runner and tools. Edits land in the mounted workspace. |
| `e2b` | `E2B_API_KEY`, or `wb connect --runtime e2b` once (masked prompt or `--stdin`). Edits come back as a pending outcome. |
| `daytona` | `DAYTONA_API_KEY`, or `wb connect --runtime daytona`. Only the `linux` class runs today. Published images only. OpenCode and Claude Code are supported; Pi is not. Edits come back as a pending outcome. |

The environment variable always wins over a saved runtime key. Runtime keys never enter the sandbox. `wb connect --runtime <name> --status` checks one.

A Workbench that declares host Docker access needs `--allow-host-docker` on every `run`, `smoke`, `resume`, and `create`. That grants effective administrative access to the host's Docker daemon. Only the person can authorize it; never add the flag on your own initiative.

## Output and exit codes

For scripts and agents:

- `run`, `resume`, `attach`: `--final` prints only the final answer; `--json` streams NDJSON events (`protocol: 0`). They cannot be combined.
- `run --detach` prints a session id, or a JSON receipt with `--json`.
- `wait`, `send`, `answer`, `ps`, `view`, `build`, `outcome`, `smoke` take `--json`.
- Piped output of other commands is tab separated and not a stable contract.

Exit codes: `0` success; `1` failure; `2` `wait` stopped on a pending input; `3` no authenticated model route or runtime credential (any command can return it, including `run`, `resume`, `attach`, `send`, `smoke`, `build`, `create`, `connect`, and `outcome --recover`; `wait` reports such a run as failed, 1); `124` `wait` timed out (the run continues); `130` cancelled or interrupted.

The full command reference, state locations, and environment variables are in [references/commands.md](references/commands.md). Every common failure with its fix is in [references/troubleshooting.md](references/troubleshooting.md).
