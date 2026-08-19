# Workbench execution protocol, draft 0

**Status:** pre-release working draft

A Workbench run has an ordered event stream, identity, and one terminal result.
It may contain one or more tasks as turns.

The Workbench engine—not the model or runner—reads `workbench.yml`. It resolves
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
    }>;
}

interface PreparedRuntime {
    name: string;
    workbench: ResolvedWorkbench;
    workspaceDirectory: string;
    environment: Record<string, string | undefined>;
    pathFor(hostPath: string): string;
    preflight(): Promise<PreflightResult>;
    launch(invocation: RunnerInvocation): SpawnedRunner;
    cancel(process: SpawnedRunner): void;
    cleanup(): Promise<void>;
}
```

`prepare` provisions or selects the environment, makes the workspace,
Workbench package, instructions, skills, and runner assets available, binds the
environment, and returns their runtime-visible locations. The host workspace is
read-write; immutable package and generated runner assets are read-only unless
the request explicitly says otherwise. Local execution uses the host paths
unchanged. Isolated providers mount or synchronize the declared assets and
return remapped paths.

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

## Session and turn boundaries

A run may contain multiple turns. `turn.completed` means the runner completed
one response and may accept another input; it does not terminate the run.

The host decides how long the session lives:

- A one-shot client closes after the first completed turn.
- A streaming client renders events while waiting for that turn.
- An interactive client keeps the session open and sends additional inputs.
- A detached client transfers ownership of the same session to a background
  host and exits without cancelling it.

`close()` ends the session gracefully. `cancel()` requests immediate termination.
Both eventually produce exactly one terminal event and result.

## Run handle

Every runner adapter exposes the same host-facing control surface:

```ts
interface RunHandle {
    runId: string;
    events: AsyncIterable<WorkbenchEvent>;
    send(input: string): Promise<void>;
    close(): Promise<void>;
    cancel(reason?: string): Promise<void>;
    result: Promise<RunResult>;
}
```

`send()` may deliver immediately or queue until the runner's next legal input
boundary. The manifest does not declare runner features. Adapter behavior and
runtime negotiation determine what is possible.

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
input.requested
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
runs use the same store, so their history can also be attached after completion.
Attach is read-only. `wb kill [id]` cooperatively cancels a detached run; without
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
