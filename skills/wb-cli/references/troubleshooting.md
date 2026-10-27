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
| `requires a GPU but none was found: <reason>. Pass --allow-unchecked-gpu to run on a GPU discovery cannot see.` | GPU discovery (`nvidia-smi` on Linux, `system_profiler` on macOS) found no GPU, for the reason given. Fix the driver or install `nvidia-smi`; pass the flag only after the person confirms the host has the GPU. |
| `requires a GPU but the Docker daemon has no NVIDIA container runtime` | Install the NVIDIA Container Toolkit and run `nvidia-ctk runtime configure --runtime=docker`, then restart Docker; ask the person first. On macOS use the local runtime instead. |
| `Host Docker engine access requires explicit --allow-host-docker authorization` | Only the person can grant this. Explain that it gives the run administrative access to their Docker daemon. |
| `Use a registry publisher/name, full HTTPS GitHub URL, or an explicit local path.` from `wb add` | A bare name is not a registry reference. Use `publisher/name`, a full HTTPS GitHub URL, or a path. |
| `Registry Workbench does not exist: org/name. Internal workbenches need a key for their organization` | Have the person run `wb login --org <org>`. |
| `Saved Workbench X has changed. Rerun with --force to replace it.` | Rerun `wb add` with `-f` after confirming the change is wanted. |
| `wb run requires a task` | Pass `--task`, `--task-file`, or `--stdin`. |
| `Session wb_... needs new input` | Use `wb send wb_... <task>` or pass `--task`, `--task-file`, or `--stdin` to `resume`. |
| `wb create requires an authoring brief` | Pass `--task`, `--task-file`, or `--stdin`, or use `--from`. |
| `No project "X". Did you mean "Y"?` | `--project` never creates a project. Use the suggested name, or have the person run `wb project create "X"`. |
| `A run started by an earlier version of Workbench is still active` | An old detached worker still owns its files. Wait for it or stop it; the message names the run file to remove if the process is gone. `wb mcp` runs refuse the same way. |
| `Docker isn't running. Start Docker and run wb studio again.` | Ask the person to start Docker, then rerun `wb studio`. |
| `Docker is using Windows containers` from `wb studio` | Docker Desktop must be switched to Linux containers. |
| `Studio image X does not match this version of wb` | The image was built for another version of `wb`. Drop `--image` to use the default image, or update `wb`. |

Credential errors are in `connections.md`.

## Workspace pitfalls

- Docker runs mount the workspace at `/workspace`. A git worktree does not work there: its `.git` file points at the parent repository, which is not mounted, so the run cannot commit or diff. Use a full clone (`git clone --local`) and fetch its branch back.
- Docker containers and the host fight over `node_modules` built for different platforms. Give a containerized run its own clone.
- `e2b` and `daytona` edits stay in an outcome until `wb outcome <id> --apply` writes them to your workspace.

## Cleanup

Runs that start servers can leave processes behind. After a session ends, check for orphaned dev servers before starting more. `wb clean` previews old run data; add `--apply` to delete it.
