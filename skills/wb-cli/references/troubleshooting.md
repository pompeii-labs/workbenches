# Troubleshooting

Start every diagnosis with `wb view <alias>` and `wb smoke <alias>`. They show what the run will resolve and what is missing, without spending model tokens. Remember that `smoke` on `e2b` and `daytona` creates a billable sandbox.

## The run looks slow but nothing happens

A headless run is almost always waiting on a permission prompt. Check `wb ps --json` for `needs_input` and `pending_requests`, then inspect the request and answer it with `wb answer`. Repeated prompts for the same paths mean the Workbench's runner permissions are missing entries; report that to its author instead of approving everything.

## Setup failures

| Symptom | Cause and fix |
| --- | --- |
| `wb: command not found` after install | The bin directory is not on `PATH`. For this shell run `export PATH="$HOME/.local/bin:$PATH"`; tell the person to add that line (or the printed directory) to their shell profile. |
| `Runner CLI is unavailable: opencode` | Install the runner on the host for `local` (non-root install and `PATH` are in SKILL.md), or use a runtime whose image contains it. |
| `Required CLI tool is unavailable: X` | A tool the Workbench declares is missing on the host or in the image. Install it, or use another declared runtime. |
| `Docker CLI is unavailable on the host` | Install and start Docker, or use another runtime. |
| `Workbench X does not declare runtime: Y` | Pick one of the listed runtimes. |
| `GPU requirements are not checked on the local runtime. Pass --allow-unchecked-gpu to run anyway.` | Confirm with the person that the host has the GPU, then pass the flag. |
| `Host Docker engine access requires explicit --allow-host-docker authorization` | Only the person can grant this. Explain that it gives the run administrative access to their Docker daemon. |
| `Use a registry publisher/name, full HTTPS GitHub URL, or an explicit local path.` from `wb add` | A bare name is not a registry reference. Use `publisher/name`, a full HTTPS GitHub URL, or a path. |
| `Registry Workbench does not exist: org/name. Internal workbenches need a key for their organization` | Have the person run `wb login --org <org>`. |
| `Saved Workbench X has changed. Rerun with --force to replace it.` | Rerun `wb add` with `-f` after confirming the change is wanted. |
| `wb run requires a task` | Pass `--task`, `--task-file`, or `--stdin`. |
| `Session wb_... needs new input` | Use `wb send wb_... <task>` or pass `--task`, `--task-file`, or `--stdin` to `resume`. |
| `wb create requires an authoring brief` | Pass `--task`, `--task-file`, or `--stdin`, or use `--from`. |

Credential errors are in `connections.md`.

## Workspace pitfalls

- Docker runs mount the workspace at `/workspace`. A git worktree does not work there: its `.git` file points at the parent repository, which is not mounted, so the run cannot commit or diff. Use a full clone (`git clone --local`) and fetch its branch back.
- Docker containers and the host fight over `node_modules` built for different platforms. Give a containerized run its own clone.
- `e2b` and `daytona` edits stay in an outcome until `wb outcome <id> --apply` writes them to your workspace.

## Cleanup

Runs that start servers can leave processes behind. After a session ends, check for orphaned dev servers before starting more. `wb clean` previews old run data; add `--apply` to delete it.
