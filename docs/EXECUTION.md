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
tool events, file changes, usage, permissions, questions, multiple turns,
steering, image input, image generation, native session resume, cancellation,
failures, and unknown native events.

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
lifecycle, usage, explicit permission decisions, questions, multi-turn
continuity, steering, image input, cancellation, failures, and unknown native
events through the normalized session boundary. It also injects reasoning, credentials, shell
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
    outcome?: { directory: string; home?: string };
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
    infrastructure?(): Promise<{
        provider: string;
        duration_ms: number;
        maximum_duration_ms?: number;
        resources?: { cpu_count?: number; memory_mb?: number };
        cost:
            | {
                  kind: "estimated";
                  currency: "USD";
                  amount_usd: number;
                  source: string;
              }
            | { kind: "unavailable"; currency: "USD" };
    } | undefined>;
    collectOutcome?(store: OutcomeStore): Promise<RuntimeOutcomeCollection | undefined>;
    finalizeOutcome?(): Promise<void>;
    cleanup(): Promise<void>;
}
```

`prepare` provisions or selects the environment, makes the workspace,
Workbench package, instructions, skills, named workspaces, and runner assets
available, binds the environment, and returns their runtime-visible locations.
The primary workspace is read-write; immutable package assets are read-only,
and each named workspace has its manifest-declared access. Generated runner
state can be a separate writable ephemeral asset. Local execution uses host
paths unchanged. Isolated providers mount or copy only the declared
assets and return remapped paths.

Preparation must be safe to repeat with the same inputs, including after an
interrupted attempt. `cleanup` must be safe to call more than once. A provider
must reject `launch` until its own preflight has succeeded. Cancellation targets
the provider-owned process or remote job; cleanup still runs afterward.
Durable executions supply an engine-owned outbox directory in `outcome`.
Providers expose its runtime path as `WORKBENCH_OUTPUT_DIR` and implement
`collectOutcome` to return changesets, artifacts, links, warnings, and their
initial application state. The engine commits this collection to `OutcomeStore`
before publishing `outcome.available` and ending the run. `finalizeOutcome` lets
a provider release its private recovery checkpoint after that durable commit.
Collection errors must not become successful empty results. Cleanup still runs;
E2B preserves an original-sandbox recovery checkpoint rather than destroying
uncollected work. The separate [outcomes contract](OUTCOMES.md) defines these
data structures, explicit apply/export behavior, limits, and recovery semantics.

Failures are normalized at the `resolve`, `prepare`, `mount`, `bind`,
`preflight`, `launch`, `cancel`, `collect`, or `cleanup` boundary and identify the selected
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

Long-lived runner containers use random engine-owned names and carry managed,
run ID, and opaque data-scope labels. The scope is a one-way digest of the
Workbench data directory, not the host path. This lets cleanup identify only
containers created for the same local store. Preflight and other short-lived
containers are not labeled because they execute synchronously under `--rm`.

Each supported runner uses a private named Docker volume for its native
credential store. `wb connect` only selects runtime, harness, provider, and
authentication method; it does not start Docker or ask for credentials. The
selected default can be reused by any compatible Docker Workbench using that
runner. When an OpenCode credential is missing, the first foreground or TUI run
performs its headless authentication flow inside the actual Workbench container
and then continues that run. Detached execution requires a previously
authenticated credential.
Provider choices are filtered through the selected harness version's capability
map after model-route metadata is loaded. The map also records native provider
aliases, so a catalog provider is never presented merely because it serves a
model and runner-specific names remain explicit. Verified metadata can supply
versioned maps; the engine retains the map matching its pinned harness as a safe
fallback.
First-run Pi authentication and interactive API-key entry are not yet supported
by the in-run flow. Workbench packages are never given ownership of the volume,
and the engine does not read or upload the stored token contents.

Interactive runners remain inside the selected Docker runtime. Pi uses its
native stdin RPC transport, so the container is launched with piped input.
OpenCode starts its native HTTP service on a fixed container port. Docker
publishes that port only to a dynamically assigned host loopback port, and the
adapter connects through the resolved loopback URL. The service is never bound
to an external host interface.

The reference binaries currently target macOS and Linux. Numeric host-user
mapping is applied only where the host runtime exposes it. Docker Desktop uses
virtualized bind mounts, so permission behavior and filesystem performance may
differ from native Linux. A Workbench image must support an arbitrary numeric
user, a read-only root filesystem, and writable state beneath the temporary
`HOME`. Draft 0 supports one-shot, detached, and interactive Docker execution for
OpenCode and Pi.

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

### Reference E2B provider

The reference E2B provider accepts the same published OCI image or
Workbench-local Dockerfile declaration as Docker. It builds and caches an E2B
template, then creates a fresh secure sandbox for an execution. `E2B_API_KEY` is
required by the host control plane but is excluded from the runtime environment.
The sandbox receives manifest-declared environment values for allowed model
routes and a separately staged native credential store for the selected runner.

`wb connect` selects E2B before the harness, provider, and authentication method
and persists that non-secret preference locally. It creates no sandbox, does
not require `E2B_API_KEY`, and incurs no E2B usage. When a configured OpenCode
credential is missing, the first real foreground or TUI run creates its normal
sandbox, exposes the headless authorization URL and code through normalized run
events, waits for completion, and then creates the native session in that same
sandbox. The resulting credential files are synchronized to private, runtime-
and runner-scoped storage beneath the Workbench data directory before the
sandbox is destroyed. Any compatible E2B Workbench using that runner can copy
the store into a fresh sandbox. The store is never included in the package,
workspace, run record, normalized event stream, or artifact output.

The engine treats native credential files as opaque. Some runners keep several
provider logins in one file, so the E2B sandbox receives the native store for the
runner rather than a parsed subset for one provider. The E2B provider and
Workbench image are therefore part of the credential trust boundary. Existing
stored credentials remain unchanged when staging or startup fails. A host crash
before synchronization can lose credentials created during that remote login
attempt.

The provider copies only engine-declared runtime assets. The primary workspace
is staged at `/workspace`, named workspaces at `/workspaces/<name>`, the
Workbench package at `/workbench`, and other assets beneath `/runtime-assets`.
Workspace selection uses tracked and unignored Git files when possible, with a
filesystem walk as the non-repository fallback. Repository metadata, dependency
trees, common credential directories, and common secret-bearing files are
excluded. Symlinks that escape the copied root are rejected. Read-write files
are rejected because workspace collection operates on directory snapshots.
A separately staged asset nested beneath another asset is excluded from the
parent copy and its workspace changeset.

Read-only assets are isolated copies, have their write permission bits removed
as defense in depth, and are never copied back. This is not a claim that a
privileged process inside the sandbox cannot modify its private copy.
Read-write directories receive a synthetic Git baseline inside the sandbox.
After execution, the provider collects changed paths, modes, and deletions
against that baseline. It validates returned archives and commits original-byte
artifacts and pending workspace changesets locally. Collection never changes
host workspace files. An explicit `wb outcome <id> --apply` checks current host
fingerprints against the recorded baseline and refuses conflicts before changing
any file. Input and output each have a 512 MiB limit based on uncompressed file
content; result storage has additional limits defined in the outcomes contract.

The selected image must include the runner, declared tools, Git, and GNU tar
with `--null` support. The OpenCode service uses E2B's authenticated host mapping
for the sandbox port. Pi continues to use its piped stdin transport for normal
sessions. Native authentication uses an E2B PTY so interactive login menus,
terminal resize, and control input behave like a real terminal.

Normal completion collects and commits outcomes before destroying the sandbox.
Failure and cancellation collect partial outcomes when possible. Cleanup
terminates active commands, synchronizes private native state separately, and
removes local transfer files. Failed outcome collection retains a private
checkpoint and pauses the original sandbox when possible. A provider lease of 60
minutes pauses a process-orphaned sandbox without retaining memory. Managed
sandboxes carry the run ID and an opaque digest of the Workbench data directory.
`wb clean` can list only sandboxes for the current key and scope. It can destroy
only those whose run is terminal, or whose run is absent locally and whose
sandbox is paused. A running sandbox with an absent local run is protected
because another host may own it. A run with a pending outcome recovery checkpoint
protects its original sandbox and local history from ordinary cleanup until
explicit recovery or discard. Template cache entries are outside the cleanup contract.

The provider does not automatically retry template builds, sandbox creation,
command starts, transfers, or native-state synchronization. Those boundaries can have an
ambiguous remote outcome, so replaying them could duplicate billable work or
replay mutations. A failure is terminal for that run and cleanup is still
attempted. `wb outcome <run-id> --recover` explicitly collects partial work from
the original scoped sandbox without starting new model work. `--discard-recovery`
explicitly abandons it. Neither action implicitly applies host changes.

Foreground dispatch allows isolated Docker and E2B workers up to five minutes
to become ready so a legitimate image pull or sandbox cold start is not mistaken
for a failed worker. Local startup retains the short 15-second readiness bound.
An exited worker still fails immediately in either case.

E2B reports sandbox duration, configured CPU and memory, and a clearly marked
USD cost estimate on the terminal run event. The estimate uses the public E2B
per-second rates recorded by this engine version. It is infrastructure metadata,
not model usage, and never appears in `usage.updated`.

The draft E2B boundary differs from local and Docker execution in several
intentional ways. It copies selected files rather than mounting host paths,
keeps a private Workbench-managed copy of runner credentials, creates a fresh
sandbox when a linked session resumes, and requires explicit host acceptance of
returned workspace changes. Recovery requires the original checkpoint and
provider filesystem to survive. It is not a guarantee against provider data
loss or expiration, and outcome recovery is separate from native session resume.
Inspecting, applying, and exporting already-collected results requires no live
sandbox or runtime key.

## Session, run, and turn boundaries

A Workbench session is the stable user-facing identity for work with one locked
Workbench, runner, model, and workspace. A run is one execution attempt inside
that session. The first run and session share an ID; resuming creates a new
internal run while preserving the session ID. An optional user-defined name is
presentation metadata only. It never replaces the stable ID in automation,
provenance, control messages, or native runner mappings.

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
active turn, queues follow-up input, cancels a turn, answers permission requests
and questions, and closes or cancels the run. The handle writes transient
requests to a private run-scoped control inbox. Persisted receipts and normalized
input lifecycle events contain request IDs and dispositions, never prompt, image,
or raw question-answer contents. Runner output can still reference an answer
after receiving it.

## Resumable interactive sessions

The CLI exposes the same stored control protocol through `send`, `wait`, and
`answer`. `send` is idle-only unless the caller explicitly selects active-turn
steering or a queued follow-up. A closed resumable session can start a linked
execution through an ordinary send. Accepted receipts expose correlation IDs
and an event cursor, not proof that the runner has consumed queued input.

`wait` is a read-only observer. It returns one snapshot at a fresh idle boundary,
terminal execution, or pending native input request. A cursor skips earlier
idle boundaries; terminal state and currently pending requests remain visible.
Unattended runs wait for terminal cleanup instead of returning at an intermediate
turn completion. Terminal snapshots drain the durable event tail before
reporting final response, latest-turn usage, and outcome. Waiting does not attach
an audience, restart an execution, or initiate authentication. Timeouts and
interruptions stop observation only. `answer` validates a pending request's
offered scope and submits the existing transient control message. Raw decisions
and answers are not retained in receipts or normalized request-resolution events.

Native continuation refreshes current attempt facts alongside the first resumed
input without changing the stored user task. OpenCode uses a synthetic text part;
Pi RPC carries the runtime reminder in its message because it has no equivalent
part type. Stable package instructions remain in native system context; no
credential values are included in either channel.

Every execution has one stable Workbench session ID. Runners with native session
support use the same background session engine for foreground commands, detached
commands, and the terminal client in local, Docker, and E2B runtimes. The first
execution owns the stable ID. A later continuation either joins its active run
or creates a new internal run linked to the same session after the previous run
closes. The session index records only the locked Workbench identity, runner,
model, runtime, workspace bindings, native session identifier, and latest run.
Native runner state remains authoritative and is stored under the session's
private native-state directory. Docker mounts that directory read-write into
each new container for native resume. E2B copies it into each fresh sandbox and
synchronizes it back during orderly cleanup. Runner credentials use a separate
runtime- and runner-scoped store so authentication persists across unrelated
sessions without becoming conversation state. Neither provider reconstructs
context from the normalized event stream.

`wb resume <session-or-run-id>` opens the exact Workbench package and workspace
recorded by the session. It attaches to an active run or starts a linked run from
saved native context. Adding a task performs the same continuation without
opening the terminal client; `--detach` leaves it in the background. The TUI
exposes the same operation through an active-workspace-scoped `/resume` browser.
On a bare invocation the active workspace is the current working directory; an
explicit `--dir` or resumed session preserves its recorded workspace. A resume
is rejected if the package no longer matches the recorded Workbench name,
version, runner, model, or workspace, or if the original runner never reached a
resumable state. A Workbench that declares host Docker engine access requires a
new explicit `--allow-host-docker` authorization on resume.

`/rename <name>` updates the session's durable display metadata. Named sessions
use that label in `/resume`, the active chat header, and `wb ps`, while still
retaining the stable ID for control. After the alternate screen has closed, the
terminal client prints a resume handoff only when the session reached native
resumable state. Failed starts and runners without native resume support do not
receive a misleading resume command.

`wb attach` is observation only. It follows the latest normalized event stream
without keeping the runner alive or becoming a controlling client. Exiting the
terminal client detaches that client rather than cancelling work. If a turn is
active, it and all accepted follow-ups finish before the unattended worker
closes. The stable session and native runner context remain available afterward.

The TUI rebuilds visual history from retained normalized events across the stable
session's runs, including delivered user messages, assistant replies, tool
activity, and returned results. Its local transcript cache is disposable and is
used as a fallback when no run logs remain. Missing, incompatible, or truncated
cache contents do not replace retained event history. Historical startup failures
without conversation content stay in their run logs rather than appearing as a
current chat error; failures during actual work remain labeled in the history.
Neither the cache nor event replay is sent to the model. OpenCode or Pi native
session state remains the resume boundary.

## Interactive terminal client

Running `wb run <ref>` without a task opens a runner-neutral terminal session.
The composer supports multiple lines, persistent local prompt history, command
discovery with `/` or `Ctrl+K`, queued steering, turn cancellation, and supported
image attachments. Follow-up input remains beside the composer as queued until
the normalized input lifecycle confirms delivery.

For a runner with native image input, dragging a supported image file into the
composer, or pasting its local path, attaches it to the next message. The
terminal-provided path is replaced by an attachment marker and is never sent as
prompt text.

Slash commands inspect or control the Workbench client. They are never passed to
the runner as model input. Commands expose Workbench, runtime, locked model,
native runner capability, recent session details, and images staged for the next
message; select a persisted theme; clear staged attachments or the local
transcript; cancel the active turn; or close the session. A
command backed by an unsupported native capability is hidden or explains why it
is unavailable. Workbench does not inject replacement tools into a runner to
make unsupported capabilities appear present.

The built-in terminal themes are adapted from OpenCode under the repository's
MIT attribution. Theme choice is local CLI state under `WORKBENCH_HOME`; it does
not modify a Workbench package or affect execution.

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
question.requested    question.answered    question.rejected
usage.updated
outcome.available
run.completed     run.failed     run.cancelled
runner.event
```

Adapters should translate events when the meaning is known and emit a minimal
`runner.event` marker for unrecognized runner-native data. Portable Workbench
events do not copy arbitrary native payloads: those can contain reasoning
material, credentials, provider metadata, or complete tool results. A future
opt-in diagnostic stream can preserve native data behind a separate security
contract.

Tool lifecycle events include a stable call ID and native tool name. Adapters
may also provide a safe display title, target, short description, duration, and
normalized failure. These fields let clients show concrete activity such as a
file read or search without persisting arbitrary commands, file contents, or
tool output in the portable event log.

Exactly one of `run.completed`, `run.failed`, or `run.cancelled` terminates the
event stream. The `result` promise resolves to the matching status.

`outcome.available` refers to a locally committed immutable result. It includes
`outcome_id`, `completeness`, `application_state`, counts of `changesets`,
`artifacts`, `links`, and `warnings`, and an optional `summary`. It carries no
artifact bytes or raw tool result. A terminal execution may have a partial
outcome without being successful. See [OUTCOMES.md](OUTCOMES.md).

Remote runtimes may attach an `infrastructure` object to that terminal event.
It contains provider duration, maximum lease, resource shape, and an estimated
or unavailable USD cost. Model tokens and provider-reported model cost remain
exclusive to `usage.updated`; clients must not combine the two fields silently.

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

## Background runs and session attachment

`wb run <ref> --task <task> --detach` creates a durable session and run, launches
a background worker, and prints only the stable `wb_...` session ID. `wb attach
<id>` resolves the session's latest run, replays its persisted event stream, and
follows new events. Without an ID, `wb attach` selects the most recent session in
`WORKBENCH_HOME`.

Run metadata and `events.ndjson` live under
`$WORKBENCH_HOME/runs/<id>/` (normally the Workbench data directory). The initial
task is stored only until the worker consumes it, then removed. Direct foreground
runs use the same stored handle and event stream, so their history can also be
attached after completion.

Attach is read-only and never starts model work. `wb ps` lists active sessions
and completed sessions with resumable native context; `wb ps --all` also includes
terminal one-shot history. `wb kill [id]` cooperatively cancels the active run in
a session; without an ID it selects the latest active session. The worker observes
a private cancellation request, terminates the runner child, emits
`run.cancelled`, and then marks the durable run cancelled. Session metadata and
native resumable context remain available.

## Retention and cleanup

`wb clean` previews deletion and never removes data unless `--apply` is passed.
Its default cutoff is 30 days and can be changed with durations such as `12h`,
`7d`, or `4w`. `--json` emits one versioned report with the policy, eligible
resources, protected resources, reconciled runs, byte counts, and applied
result. Previewing may repair stale nonterminal metadata as described below.

The default policy may select:

- A terminal session that never reached native resumable state.
- A terminal run that has no session record.
- An old historical run that is not the latest run of its session.
- A managed Docker container whose scoped run is terminal or no longer exists.
- A managed E2B sandbox whose scoped run is terminal or no longer exists.

Active runs are never eligible. A session with native resumable state protects
its session directory and latest run even after the cutoff. Removing that state
requires both `--include-sessions` and `--apply`. Images, build caches, E2B
templates, saved Workbench packages, runner credential volumes, and unrelated
Docker containers or E2B sandboxes are outside this cleanup contract.

Before cleanup, nonterminal records are reconciled against their worker process.
A missing worker produces one `run.failed` event and one terminal metadata
transition. Reconciliation is serialized per run so concurrent `ps`, `attach`,
or cleanup processes cannot create duplicate terminal events. Cleanup then
rechecks every candidate under the session lease before deletion. A resource
that became active or became the latest session run is left in place.

Pending E2B outcome recovery protects its original run, session history, and
sandbox until explicit recovery or discard. Selected terminal runs carry their
outcomes into deletion. Shared result blobs are reclaimed only after their final
retained reference is removed, and active captures prevent unsafe collection.
The result store enforces bounded admission before writes rather than silently
evicting old outcomes to make room. See [OUTCOMES.md](OUTCOMES.md) for storage limits.

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
