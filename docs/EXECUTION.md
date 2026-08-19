# Execution protocol v0

**Status:** working draft

A Workbench run is a managed runner session with one initial task, zero or more
follow-up inputs, an ordered event stream, and one terminal result. It is not a
fire-and-forget child process.

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
Host: wb CLI, Pompeii, or another client
```

No runner is asked to interpret the Workbench manifest itself.

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

Adapters should translate events when the meaning is known and emit
`runner.event` for unrecognized runner-native data. Preserving native data lets
hosts add rich integrations without making the canonical protocol mirror every
harness-specific feature.

Exactly one of `run.completed`, `run.failed`, or `run.cancelled` terminates the
event stream. The `result` promise resolves to the matching status.

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

Presence-only tool checks are the current v0 behavior. Version and health
contracts remain to be specified.

## Current implementation boundary

The TypeScript `RunHandle`, event ordering, input, graceful close, cancellation,
and terminal-result invariants are implemented and unit tested. The existing
OpenCode process adapter still executes a single non-interactive `opencode run`
child and has not yet been migrated to the managed multi-turn contract. A full
interactive OpenCode adapter will use its headless server/session API rather than
pretending inherited stdin provides portable interactivity.

