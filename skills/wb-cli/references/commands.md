# Command reference

Run `wb <command> --help` for the authoritative flags of your installed version. Bare `wb` prints help. Errors are `error: <message>` on stderr, or a red `✗ <message>` in a terminal.

## Discover and save

| Command | What it does |
| --- | --- |
| `wb list [SOURCE]` | With no source, saved aliases. With a local path, GitHub URL, or `owner/repo`, the packages under its `.workbenches/`. |
| `wb add <SOURCE> [--as ALIAS] [--name PKG] [--ref REF] [-f]` | Save a registry `org/name`, a GitHub URL, or a local path. Remote packages are frozen snapshots; local paths stay live for new sessions. `-f` replaces a saved package that changed. |
| `wb view <WORKBENCH> [--json]` | Resolved configuration, provenance, model routes and readiness, runtimes, requirements. |
| `wb remove <ALIAS>` | Forget an alias. |
| `wb upgrade [ALIAS]` | Refresh saved remote snapshots from their sources. |

Sources: `.#name` and `/path#name` select one package in a repo, `org/name` is the registry, `https://github.com/o/r` is GitHub (use `--name` when the repo publishes several).

## Verify

| Command | What it does |
| --- | --- |
| `wb validate [SOURCE]` (alias `v`) | Parse the manifest and check package files against the schema. |
| `wb smoke [SOURCE] [--runtime R] [--json]` | Prepare the runtime and check runner, tools, and auth. No model request. Billable sandbox on `e2b` and `daytona`. |
| `wb build <WORKBENCH> [--runtime R] [--json]` | Build or pull and cache the image for `docker` or `e2b`. |
| `wb run <ALIAS> --task "..." --dry-run` | Resolve, preflight, and translate without launching. Needs a task. |

## Run and supervise

| Command | What it does |
| --- | --- |
| `wb run <ALIAS> [PROMPT]` | No task opens the interactive terminal. `--task`, `--task-file`, or `--stdin` runs one task. `--final`, `--json`, or `--detach` choose the output. `--dir` sets the workspace; `--repo owner/name [--ref]` works on an isolated GitHub checkout; `--workspace NAME=PATH` binds named workspaces; `--env-file`, `--env NAME=value`, `--connection`, `--runtime`, `--allow-host-docker`. Unknown options are rejected. |
| `wb ps [--all] [--json]` | Active and resumable sessions, with `needs_input` and pending requests. |
| `wb wait <SESSION\|RUN> [--run] [--after SEQ] [--timeout SECONDS] [--json]` | Read-only. Returns at the next turn boundary, terminal state, or input request. |
| `wb send <SESSION> [TEXT\|--task-file F\|--stdin] [--steer\|--queue] [--json]` | Send to an idle session, steer the active turn, or queue a follow-up. Uses the inherited environment for credentials. |
| `wb resume <SESSION> [PROMPT\|--task T] [--detach] [--json\|--final] [--env-file] [--env] [--connection]` | Continue a resumable session. No task opens the interactive terminal. |
| `wb answer <SESSION> <REQUEST> [RESPONSE\|--response-file F\|--stdin\|--reject] [--json]` | Answer one pending permission or question. |
| `wb attach [SESSION] [--json\|--final]` | Replay and follow the latest run. Read-only. |
| `wb kill <SESSION>` | Cancel the active run. |
| `wb outcome <RUN\|OUTCOME> [--json] [--apply] [--export DIR] [--workspace DIR]` | Inspect a run's durable result, apply pending changes, or export a bundle. |
| `wb clean [--older-than 30d] [--include-sessions] [--apply]` | Preview, then remove old run data. |

## Author

| Command | What it does |
| --- | --- |
| `wb init <NAME> [--dir] [--runner] [--model] [--runtimes local,docker,e2b,daytona] [--image]` | Scaffold `.workbenches/<NAME>` as spec 1. |
| `wb create [TARGET] [--task\|--task-file\|--stdin] [--from SESSION] [--feedback] [--detach] [--json]` | Run the official creator. Spends a model run. |

## Registry

| Command | What it does |
| --- | --- |
| `wb login [--org SLUG] [--no-browser]` | Browser sign-in that connects one organization. |
| `wb whoami` | Default organization, user, scopes, key expiry. |
| `wb org list`, `wb org use <SLUG>` | Held organizations; set the default. |
| `wb logout [--org SLUG]` | Revoke and forget a key. |
| `wb push [SOURCE] [--org] [--as NAME]` | Store a new immutable internal version. |
| `wb publish <SOURCE> [--org] [--version]` | Submit for public review. A local source is submitted directly, with no internal version stored first. |
| `wb unpublish <org/name>` | Make a public Workbench internal again. |
| `wb image push <IMAGE> --as NAME [--org] [--tag TAG] [--client docker]` | Publish a local OCI image to `images.workbenches.dev/<org>/<name>:<tag>`. |
| `wb image login [--org] [--client docker]` | Log a Docker-compatible client into the registry. |

## Connections and settings

| Command | What it does |
| --- | --- |
| `wb connect [WORKBENCH] [--runtime] [--harness] [--provider] [--method] [--stdin\|--yes\|--remove]` | Save the default provider and sign-in method for a runner and runtime, fill that runtime's credential store, and check it. `--stdin` reads an API key, `--yes` copies an API key your local runner already has, `--remove` deletes the provider's entry. Exits 3 when not ready. |
| `wb connect --runtime e2b\|daytona [--stdin\|--status\|--remove]` | Save, check, or remove a sandbox provider key. |
| `wb update [--check]` | Update the CLI binary. |

## Anonymous counts

The CLI reports anonymous save and run counts only for registry Workbenches published by an organization the person holds no login for. Own-organization packages, local paths, GitHub sources, and private versions are never reported. A one-time notice appears before the first report. The only opt-out is `DO_NOT_TRACK` set to any non-empty value other than `0`; it suppresses every report and the notice.

## Where state lives

`WORKBENCH_HOME`, default `~/.workbench`:

| Path | Contents |
| --- | --- |
| `catalog.json`, `packages/` | Saved aliases and package snapshots. |
| `sessions/`, `runs/`, `outcomes/` | Sessions, runs, and durable results. |
| `connections.json` | `wb connect` defaults. No secrets. |
| `credentials.json` | Registry organization keys (mode 0600). |
| `runtime.secrets.json` | E2B and Daytona keys (mode 0600). |
| `metadata/models/` | The cached model catalog, refreshed every 6 hours. |

## Environment the CLI reads

- Provider keys named in the model catalog (see `connections.md`).
- `E2B_API_KEY`, `DAYTONA_API_KEY`, `DAYTONA_API_URL`.
- `GH_TOKEN`, `GITHUB_TOKEN` for private GitHub sources and `--repo` runs (falls back to `gh auth token`).
- `WORKBENCH_HOME`, `NO_COLOR`, `FORCE_COLOR`.
- `DO_NOT_TRACK` disables anonymous save and run counts.
