# Command reference

Run `wb <command> --help` for the authoritative flags of your installed version. Bare `wb` prints help. Errors are `error: <message>` on stderr, or a red `✗ <message>` in a terminal.

## Discover and save

| Command | What it does |
| --- | --- |
| `wb list [SOURCE]` | With no source, saved aliases. With a local path, GitHub URL, or `owner/repo`, the packages under its `.workbenches/`. |
| `wb add <SOURCE> [--as ALIAS] [--name PKG] [--ref REF] [-f]` | Save a registry `org/name`, a GitHub URL, or a local path. Remote packages are frozen snapshots; local paths stay live: every new run reads the current files, so edits need no re-add. `-f` replaces a saved package that changed. |
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
| `wb run <ALIAS> [PROMPT]` | Requires a task through the positional prompt, `--task`, `--task-file`, or `--stdin`. `--final`, `--json`, or `--detach` choose the output. `--dir` sets the workspace; `--repo owner/name [--ref]` works on an isolated GitHub checkout; `--workspace NAME=PATH` binds named workspaces; `--env-file`, `--env NAME=value`, `--connection`, `--runtime`, `--project`, `--allow-host-docker`, `--allow-unchecked-gpu` (only after the person confirms the host has the GPU discovery missed). Unknown options are rejected. |
| `wb project create <NAME> [--json]` | Create a local project. Works the same with or without `wb login`. |
| `wb project list [--json]` | Projects with task counts. `--project <name-or-slug>` on `run` must name one of them. |
| `wb ps [--all] [--json]` | Active and resumable sessions, with `needs_input` and pending requests. |
| `wb status [--line\|--json]` | Live progress of every active run on the machine and runs that ended in the last 10 minutes: plan bar from the agent's todo list, current todo, elapsed time, cost, and pending input first. `--line` prints one line for a status bar such as Claude Code's `statusLine`. |
| `wb wait <SESSION\|RUN> [--run] [--after SEQ] [--timeout SECONDS] [--json]` | Read-only. Returns at the next turn boundary, terminal state, or input request. |
| `wb send <SESSION> [TEXT\|--task-file F\|--stdin] [--steer\|--queue] [--json]` | Send to an idle session, steer the active turn, or queue a follow-up. Uses the inherited environment for credentials. |
| `wb resume <SESSION> [PROMPT\|--task T\|--task-file F\|--stdin] [--detach] [--json\|--final] [--env-file] [--env] [--connection]` | Continue a resumable session with new input. Use `wb send` for agent-driven session control. |
| `wb answer <SESSION> <REQUEST> [RESPONSE\|--response-file F\|--stdin\|--reject] [--json]` | Answer one pending permission or question. |
| `wb attach [SESSION] [--json\|--final]` | Replay and follow the latest run. Read-only. |
| `wb kill <SESSION>` | Cancel the active run. |
| `wb outcome <RUN\|OUTCOME> [--json] [--apply] [--export DIR] [--workspace DIR]` | Inspect a run's durable result, apply pending changes, or export a bundle. `--recover` collects partial work from a failed E2B run's sandbox without new model work; `--discard-recovery` abandons it. |
| `wb clean [--older-than 30d] [--include-sessions] [--apply]` | Preview, then remove old run data. |
| `wb mcp` | Serve the Workbench tools (`search`, `view`, `run`, `wait`, `send`, `answer`, `cancel`, `runs`, `sessions`, `push`, `projects`, `create_project`, `tasks`) to an MCP client over stdio. |
| `wb studio [--image REF] [--port 9292] [--api-port 9293] [--no-open] [--json]` | Start the local dashboard in Docker, or open the running one. Pulls the pinned image when missing. `wb studio status` and `wb studio stop` take `--json`. |

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
| `wb connect [WORKBENCH] [--runtime] [--harness] [--provider] [--method] [--stdin\|--remove]` | Save the default provider and sign-in method for a runner and runtime, fill that runtime's credential store, and check it. `--stdin` reads an API key (a terminal gets a hidden prompt instead), `--remove` deletes the provider's entry. Exits 3 when not ready. |
| `wb connect --runtime e2b\|daytona [--stdin\|--status\|--remove]` | Save, check, or remove a sandbox provider key. |
| `wb connect --worker <WORKER> <RUNNER> [--provider] [--method]` | Sign the calling member in to a runner on a workbenches.dev worker, from any machine with `wb login`. Relays the runner's own sign-in, or a hidden API-key prompt, to the worker; needs a person at the terminal. |
| `wb update [--check]` | Update the CLI binary. |

## Workers (workbenches.dev)

| Command | What it does |
| --- | --- |
| `wb worker start [--name NAME] [--org SLUG] [--runtimes docker,local] [--slots N]` | Register this machine on first use (needs `wb login`), then install and start the background service. `--runtimes` only narrows what the machine can run; both flags are remembered. |
| `wb worker status [--json]` | Online or offline and since when, organization, busy slots, and one line per active run. |
| `wb worker logs [-f]` | The lifecycle log: names, ids, states, short task excerpts, never credentials or task output. |
| `wb worker stop [--now]` | Wait for active runs (`--now` cancels them), then stop the service until the next `start`. |
| `wb worker remove [--now]` | Stop, remove the service, and revoke the worker's key. Safe to rerun when the API was unreachable. |

A worker's state lives in `$WORKBENCH_HOME/worker`: its key (`worker.json`, owner-only), its own engine sessions, and one directory per member under `members/`, which holds that member's runner sign-ins. Never open those files.

## Anonymous counts

The CLI reports anonymous save and run counts only for registry Workbenches published by an organization the person holds no login for. Own-organization packages, local paths, GitHub sources, and private versions are never reported. A one-time notice appears before the first report. The only opt-out is `DO_NOT_TRACK` set to any non-empty value other than `0`; it suppresses every report and the notice.

## Where state lives

`WORKBENCH_HOME`, default `~/.workbench`:

| Path | Contents |
| --- | --- |
| `catalog.json`, `packages/` | Saved aliases and package snapshots. |
| `wb.db`, `files/` | Sessions, runs, events, and projects (one SQLite database), and the runner state, checkouts, and live-run scratch they refer to. |
| `studio/` | The running Studio's owner-only state file and its one-time open-link pages. |
| `outcomes/`, `blobs/` | Durable results. |
| `connections.json` | `wb connect` defaults. No secrets. |
| `metadata/models/` | The cached model catalog, refreshed every 6 hours. |

Registry organization keys and runtime keys live in owner-only files in the same directory. Never open them: check them with `wb whoami` and `wb connect --runtime <name> --status`.

## Environment the CLI reads

- Provider keys named in the model catalog (see `connections.md`).
- `E2B_API_KEY`, `DAYTONA_API_KEY`, `DAYTONA_API_URL`.
- `GH_TOKEN`, `GITHUB_TOKEN` for private GitHub sources and `--repo` runs (falls back to `gh auth token`). A `GH_TOKEN` exported as an empty string means no token: the `gh auth token` fallback is skipped.
- `WORKBENCH_HOME`, `NO_COLOR`, `FORCE_COLOR`.
- `DO_NOT_TRACK` disables anonymous save and run counts.
