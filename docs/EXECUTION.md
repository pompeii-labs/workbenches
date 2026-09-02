# Workbench execution protocol, draft 0

**Status:** pre-release working draft

A Workbench run has an ordered event stream, identity, and one terminal result.
It may contain one or more tasks as turns.

The Workbench engine, not the model or runner, reads `workbench.yml`. It resolves
the versioned manifest into a canonical representation, provisions the runtime,
performs preflight inside that runtime, and translates canonical inputs through
the selected runner adapter.

```text
Workbench package
      ↓ resolve
Canonical Workbench
      ↓ prepare and smoke
Runtime environment
      ↓ launch
Runner adapter
      ↕ events, input, close, cancellation
Host
```

No runner is asked to interpret the Workbench manifest itself.

## Runner adapter contract

Each registered runner adapter declares the native command it drives, the exact
native versions and interfaces it has been verified against, and an exhaustive
capability map. The initial capability catalog covers streamed assistant text,
tool events, file changes, usage, permissions, multiple turns, steering, image
input, image generation, cancellation, failures, and unknown native events.

Every capability has one of three outcomes:

- `supported` passes the portable behavior defined by the shared conformance
  suite.
- `degraded` is usable with a documented semantic limitation.
- `unsupported` is rejected or omitted deliberately, with a documented reason.

Adapters translate native runner behavior; they do not create runner features.
A capability can be `supported` only when the verified native interface exposes
the behavior being normalized. The engine does not inject tools, extensions, or
prompts to manufacture a missing capability. Publisher-supplied `runner_config`
remains native runner configuration and does not change the adapter declaration.

An adapter cannot be registered without a verified native version, a named
native interface, and an outcome for every capability. A declaration is
evidence about the listed native versions and interfaces only. It is not a
claim that untested future runner releases conform.

The shared runner conformance suite exercises streamed text, tool and file
lifecycle, usage, explicit permission decisions, multi-turn continuity,
steering, image input, cancellation, failures, and unknown native events through
the normalized session boundary. It also injects reasoning, credentials, shell
commands, tool output, image data, and arbitrary future payloads and asserts
that none cross that boundary. Unknown native events become a minimal
`runner.event` marker containing only their native type.

## Runtime provider contract

The engine resolves the manifest before selecting the provider named by
`runtime`. Every provider implements the same lifecycle:

```ts
interface RuntimeProvider {
    name: string;
    prepare(request: RuntimePrepareRequest): Promise<PreparedRuntime>;
}

interface RuntimePrepareRequest {
    workbench: ResolvedWorkbench;
    workspaceDirectory: string;
    environment: Record<string, string | undefined>;
    assets: Array<{
        path: string;
        access: "read-only" | "read-write";
        workspace?: string;
    }>;
}

interface PreparedRuntime {
    name: string;
    workbench: ResolvedWorkbench;
    workspaceDirectory: string;
    environment: Record<string, string | undefined>;
    workspaces: Array<{
        name: string;
        path: string;
        access: "read-only" | "read-write";
    }>;
    pathFor(hostPath: string): string;
    preflight(): Promise<PreflightResult>;
    launch(invocation: RunnerInvocation): SpawnedRunner;
    cancel(process: SpawnedRunner): void;
    cleanup(): Promise<void>;
}
```

`prepare` provisions or selects the environment, makes the workspace,
Workbench package, instructions, skills, named workspaces, and runner assets
available, binds the environment, and returns their runtime-visible locations.
The primary workspace is read-write; immutable package assets are read-only,
and each named workspace has its manifest-declared access. Generated runner
state can be a separate writable ephemeral asset. Local execution uses host
paths unchanged. Isolated providers mount or synchronize only the declared
assets and return remapped paths.

Preparation must be safe to repeat with the same inputs, including after an
interrupted attempt. `cleanup` must be safe to call more than once. A provider
must reject `launch` until its own preflight has succeeded. Cancellation targets
the provider-owned process or remote job; cleanup still runs afterward.

Failures are normalized at the `resolve`, `prepare`, `mount`, `bind`,
`preflight`, `launch`, `cancel`, or `cleanup` boundary and identify the selected
runtime without exposing bound environment values. Runtime-native logs and
identifiers are diagnostics, not additions to the portable Workbench event
protocol. Providers must pass the shared runtime contract suite before being
registered by the reference engine.

### Reference Docker provider

The reference Docker provider accepts either a published image reference or a
local build declared by `image`. Published tags are pulled and resolved to an
immutable repository digest before preflight or launch. An already-present
digest is reused. Local builds stage the declared context, exclude common
credential stores and secret-bearing files, hash the resulting files and
Dockerfile, and cache the image under that content identity. `wb run` prepares
automatically; `wb build` exposes preparation without preflight or runner
launch.

The provider mounts only runtime assets supplied by the engine. The primary
workspace is read-write, named workspaces are mounted at
`/workspaces/<name>` with their declared access, and the Workbench package is
read-only. Generated runner state is a separate writable, ephemeral asset because a runner may need
to update its own configuration during startup; it is discarded during runtime
cleanup. Containers run as the host user where the platform provides a numeric
user and group, with a read-only root filesystem and writable `/tmp` temporary
filesystem. Draft 0 does not impose implicit CPU, memory, or
temporary-filesystem capacity limits.

Preflight containers have networking disabled. A launched runner uses Docker's
bridge network because model providers and remote MCPs require outbound access.
The container receives the Workbench's declared environment, environment names
used by its allowed model providers, and engine-generated runner configuration.
Once a route is selected, provider environment values for routes that were not
selected are removed. Values are written to a mode-`0600` ephemeral Docker
environment file and removed after the container exits. Values do not appear in
Docker command arguments, and the host Docker client retains its own
environment.

Each supported runner uses a private named Docker volume for its native
credential store. `wb connect` runs the runner's own authentication flow in the
same image and volume that later runs use. The Workbench package is never given
ownership of the volume, and the engine does not read or upload the stored token
contents.

The reference binaries currently target macOS and Linux. Numeric host-user
mapping is applied only where the host runtime exposes it. Docker Desktop uses
virtualized bind mounts, so permission behavior and filesystem performance may
differ from native Linux. A Workbench image must support an arbitrary numeric
user, a read-only root filesystem, and writable state beneath the temporary
`HOME`. Draft 0 supports one-shot and detached Docker execution, not interactive
Docker sessions.

A manifest can request `docker.engine.mode: host`. The request is inert until
the caller supplies an explicit per-run authorization; the reference CLI uses
`--allow-host-docker`. The provider resolves the active Docker context only when
it is a local Unix socket, binds it at `/var/run/docker.sock`, passes its group
when needed, and sets `DOCKER_HOST` inside the container. It then verifies both
the in-image Docker CLI and an engine request during preflight. Socket paths and
credentials are not package inputs.

Access to a host Docker socket is equivalent to administrative access to that
Docker host and can escape the Workbench container's filesystem isolation. The
grant must never be inferred from `tools: [docker]`, inherited environment, or
socket presence. TCP contexts, isolated engines, and other modes are
unsupported in draft 0 and must fail explicitly.

Nested containers resolve bind-mount sources on the host daemon, not inside the
Workbench container. For that reason, a host-engine run maps its primary and
named workspaces to their resolved host paths and runs the adapter from the
path-preserved primary workspace. This is the documented exception to ordinary
Docker paths such as `/workspace` and `/workspaces/<name>`.

## Session and turn boundaries

A run may contain multiple turns. `turn.completed` means the runner completed
one response and may accept another input; it does not terminate the run.

The host decides how long the session lives:

- A one-shot client closes after the first completed turn.
- A streaming client renders events while waiting for that turn.
- An interactive client keeps the session open and sends additional inputs.
- A detached client transfers ownership of the same session to a background
  host and exits without cancelling it.

`close()` ends the session gracefully. `cancelTurn()` requests cancellation of
the active turn while preserving the host process when the native interface
allows it.

## Runner session

Every runner adapter exposes the same host-facing control surface:

```ts
interface RunnerPromptInput {
    text: string;
    images?: Array<{
        data: string;
        mimeType: string;
        name?: string;
    }>;
}

interface RunnerSession {
    id?: string;
    prompt(input: string | RunnerPromptInput): Promise<RunnerTurnResult>;
    steer?(input: string | RunnerPromptInput): Promise<void>;
    followUp?(input: string | RunnerPromptInput): Promise<void>;
    cancelTurn(): Promise<void>;
    close(): Promise<void>;
}
```

`steer()` changes an active turn through the runner's native steering operation
and must never silently become a later follow-up. The Workbench host owns a FIFO
follow-up queue so ordering does not depend on runner-specific behavior. Image
data is translated into the runner's native input but never copied into
normalized events. The manifest does not declare runner features. Adapter
declarations and runtime negotiation determine what is possible.

Input lifecycle events distinguish admission from consumption. `input.accepted`
means the host accepted the control request. `input.queued` means the input is
waiting inside the host or runner. `input.delivered` means it left that queue for
the runner's active execution path. An adapter can delay delivery until it sees
native evidence of consumption. OpenCode steering does this when the runner
creates the assistant message parented by that input. A client can therefore
keep steering visibly queued without adding it to the conversation early.

Clients control a stored run through `RunHandle`. A handle follows the durable
event stream, resolves the terminal result, sends idle-turn input, steers an
active turn, queues follow-up input, cancels a turn, answers permission requests,
and closes or cancels the run. The handle writes transient requests to a private
run-scoped control inbox. Persisted receipts and normalized input lifecycle events
contain request IDs and dispositions, never prompt or image contents.

## Canonical events

Events are ordered by a monotonically increasing `sequence` within one run and
carry execution protocol version `0`.

The initial catalog is deliberately small:

```text
run.started       run.ready
turn.started      turn.completed
output.text
tool.started      tool.completed
file.changed
input.requested   input.accepted
input.queued      input.delivered      input.rejected
usage.updated
run.completed     run.failed     run.cancelled
runner.event
```

Adapters should translate events when the meaning is known and emit a minimal
`runner.event` marker for unrecognized runner-native data. Portable Workbench
events do not copy arbitrary native payloads: those can contain reasoning
material, credentials, provider metadata, or complete tool results. A future
opt-in diagnostic stream can preserve native data behind a separate security
contract.

Exactly one of `run.completed`, `run.failed`, or `run.cancelled` terminates the
event stream. The `result` promise resolves to the matching status.

The normative v0 JSON Schema is
[`schemas/events/v0/workbench-event.schema.json`](../schemas/events/v0/workbench-event.schema.json).

## CLI output modes

One-shot execution is selected by a positional task or `--task`:

```sh
wb run lux-core "Explain this repository"
wb run lux-core --task "Explain this repository"
```

Manifest-declared environment bindings can come from the invoking process, a
dotenv file passed with `--env-file`, or repeatable `--env NAME=value`
arguments. Precedence is explicit override, then dotenv file, then inherited
environment. File entries outside the manifest are ignored, while undeclared
explicit overrides fail before runtime preparation. Bound values are
invocation-only state: they are never added to stored run requests, metadata,
or normalized events. Detached workers receive them through their private
process environment rather than the durable run store.

Named workspace bindings come from repeatable `--workspace NAME=PATH`
arguments. Paths are resolved and checked on the host before preparation. The
binding is durable run metadata for detached execution; the engine exposes only
the runtime-visible path as `WORKBENCH_WORKSPACE_<NAME>`. In the local runtime,
access is a checked requirement rather than an enforceable isolation boundary.
Container providers must enforce read-only bindings at the mount boundary.

The default renderer consumes canonical events and writes a human-readable live
log. `--json` writes one complete canonical event per line as NDJSON (newline-
delimited JSON). This is the portable integration boundary for hosts; it is not
the selected runner's native JSON. `--final` buffers
`output.text` events and writes only the final assistant response.

Human output uses a shared Workbench visual language for run identity, runtime
readiness, optional integrations, tool lifecycle, file changes, assistant text,
and terminal status. Assistant text renders the terminal-representable parts of
CommonMark and GitHub Flavored Markdown: distinct heading levels, emphasis,
strikethrough, nested and task lists, blockquotes, inline code, fenced code,
links, horizontal rules, and aligned tables. Completed Markdown blocks render
while later blocks are still streaming; an unfinished block is flushed at the
next tool or turn boundary.

The renderer never tries to imitate a browser. It strips terminal control
characters, turns raw HTML into text, and represents images by alt text without
fetching them. Browser-only behavior such as collapsible details and portable
rendering of images or typeset mathematics is unavailable. Syntax from
non-GFM extensions, including definition lists, footnotes, abbreviations, math,
and emoji shortcodes, is preserved as readable source text rather than claimed
as rendered output. The interactive TUI uses the same safety boundary. Active
turns use a synchronous, marker-free preview so frequent runner deltas do not
cause syntax-highlighting flicker; completed turns switch once to OpenTUI's
native rich Markdown layout.

Color is enabled automatically for an interactive stdout, can be forced with
`--color`, and is disabled by `NO_COLOR` or `--no-color`. Assistant text wraps
to the terminal width; fenced code preserves its content with hard wrapping for
overlong lines. Paths beneath the target workspace render relative to that
workspace. ANSI formatting never appears in JSON or final-only modes.

Stdout is reserved for the selected output contract. Human and final-mode errors
go to stderr. JSON mode represents failures as `run.failed` on stdout and also
uses a non-zero process exit code.

## Detached runs and attach

`wb run <ref> --task <task> --detach` creates a durable run, launches a
background worker, and prints only its `wb_...` ID. `wb attach <id>` replays its
persisted event stream and follows new events. Without an ID, `wb attach` selects
the most recently dispatched run in `WORKBENCH_HOME`.

Run metadata and `events.ndjson` live under
`$WORKBENCH_HOME/runs/<id>/` (normally the Workbench data directory). The initial
task is stored only until the worker consumes it, then removed. Direct foreground
runs use the same stored handle and event stream, so their history can also be
attached after completion.
Attach is read-only. `wb ps` lists active detached runs; `wb ps --all` includes
finished detached runs. `wb kill [id]` cooperatively cancels a detached run; without
an ID it selects the latest active detached run. The worker observes a private
cancellation request, terminates the runner child, emits `run.cancelled`, and
then marks the durable record cancelled.

## Preflight boundary

No runner launch or model request may occur until runtime preflight succeeds.
For local execution, checks run against the host environment. For Docker, E2B,
or any future remote runtime, checks run inside the provisioned environment.

Preflight verifies at least:

- The selected runner is installed.
- Every declared CLI tool resolves inside the runtime.
- Required environment bindings exist.
- Instructions and skills were staged successfully.
- Eligible MCP configuration can be translated without exposing secret values.

Draft 0 verifies tool presence only. An engine must not imply that presence also
proves version compatibility or operational health.
