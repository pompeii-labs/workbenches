# Portable run outcomes, draft 1

**Status:** pre-release working draft

A run produces a conversation and, when applicable, a durable outcome. The
conversation is not a substitute for returned files or workspace changes. An
outcome describes collected changesets, artifacts, and links independently of
the harness, model provider, and execution runtime.

This contract does not require a hosted Workbench account, GitHub application,
central result service, or token proxy. The reference engine stores outcomes in
the caller's private local data directory. Remote execution still requires the
caller's runtime credentials and any provider credentials required by the
selected harness.

## Runtime behavior

| Runtime | Workspace execution | Initial application receipt |
| --- | --- | --- |
| Local | Runs against host directories | `present` |
| Docker | Runs against mounted host directories | `present` |
| E2B | Runs against selected copies in a fresh sandbox | `pending` |

Local and Docker preserve their existing in-place editing behavior. Their
outcomes record the run's changes; the engine does not undo those edits when a
run fails or when its client disconnects. E2B never silently applies collected
workspace edits to the host. Returning remote results and accepting them are
separate operations.

Every normal durable execution receives an engine-owned outbox directory through
`WORKBENCH_OUTPUT_DIR`. The provider maps that directory into its runtime. A
harness can use its existing file-writing tools to return a report, screenshot,
image, archive, or other file there. No tool is injected to manufacture a
harness capability such as image generation.

### Agent-facing execution context

The engine injects a shared `<workbench_context>` protocol through native harness
system instructions, before the package's instructions. It briefly defines a
Workbench and explains outbox files, the optional declaration, and result
delivery without adding a persona, promotional language, tools, or permissions.
Package identity includes the declared name and version, not an inferred author.

Users request results in ordinary language; they do not need to know or mention
the outbox. The protocol directs harnesses to return requested reports,
documents, images, screenshots, datasets, archives, exports, and downloadable
files automatically. Sending an existing authorized file returns a copy of its
original bytes. Revisions return new artifacts without changing earlier copies.
Project source, configuration, tests, and project assets stay in the appropriate
workspace unless an attachment or export is also requested. Conversational
answers do not require an attachment. Requested result links and actual PR or
preview links from authorized operations are recorded automatically in the
declaration, not only mentioned in chat. A claimed attachment or pasted file
content is not a substitute for creating the finished file. These are
agent-facing routing rules; collection validates actual returned files, not a
claim in the agent's reply,
and the engine does not guess that arbitrary workspace files are deliverables.

A trailing `<workbench_runtime>` block supplies the actual primary and named
workspace paths, each binding's access, the resolved outbox and declaration
paths, and whether workspace edits are already present on the host or pending
explicit application.
Only these selected execution facts enter the block, never a dump of environment
variables or credential values. Values are escaped as XML data. Native harness
instructions and provider caching remain under the harness's control; the engine
keeps its stable protocol and package text ahead of changing execution paths.

OpenCode receives a staged instruction file through its native `instructions`
configuration. Pi receives staged `APPEND_SYSTEM.md` instructions. At harness
launch, the engine assembles the stable prefix and the current runtime block,
without a separate model request or a context-discovery tool call. This is not a
user chat message. A new execution attempt, including resume, refreshes the
runtime block and explicitly marks earlier outbox paths as obsolete. The engine
supplies the current instructions; this does not guarantee model compliance.

OpenCode's native external-directory permission allows only the engine-owned
outbox for result delivery. If OpenCode still requests that directory permission,
the adapter replies once only when every requested scope is inside the current
outbox and the request belongs to the current native session. Parent directories,
mixed or ambiguous scopes, and separate edit or shell approvals remain under
host control. The context itself does not grant authorization.

For Local, each execution attempt uses `~/.workbench/runs/<run-id>/outbox`
alongside its existing run metadata and logs (beneath the configured engine home
when overridden). The private per-run directory keeps concurrent runs separate.
Docker and E2B expose `/outbox` inside their runtime, where the container or
sandbox provides the execution's filesystem namespace. No path is relative to
the Workbench package or assumed to be the user's current directory. The agent
receives the exact path in both the runtime block and `WORKBENCH_OUTPUT_DIR`.

After collection, retained artifacts live in private content-addressed local
outcome storage. The staging Local outbox is removed during normal cleanup,
without deleting its sibling run metadata or logs; it is not the durable result
location. `wb outcome` and export use the retained copies. Resume receives a
new outbox under its new run ID, seeded with independent working copies of the
latest retained revision of each file in that session. Empty attempts do not
erase the session's deliverable library, and empty final collection does not
hide an attempt's last successful file snapshot. Restored bytes come from verified blobs,
not editable preview copies, and retain their outbox-relative directory structure.
Other sessions' artifacts and uncollected staging files are never imported. Old
declarations, links and summaries are not replayed as newly produced work, and
an unchanged restored outbox does not generate a new live card on every turn.
Removing a working file does not remove earlier retained artifacts from the
session library. Uncollected staging files left by a crashed
worker remain with that run until its run storage is explicitly cleaned.

## Outbox declaration

Every regular file beneath the outbox is collected as an artifact, except the
reserved top-level `outcome.json` declaration. A declaration is optional and
may attach names, descriptions, media types, a summary, and links:

```json
{
  "version": 1,
  "summary": "Prepared a report and implementation changes for review",
  "artifacts": [
    {
      "path": "reports/findings.html",
      "name": "Findings.html",
      "description": "The collected research report",
      "media_type": "text/html"
    }
  ],
  "links": [
    {
      "label": "Implementation PR",
      "uri": "https://github.com/example/project/pull/42",
      "kind": "pull_request"
    }
  ]
}
```

Artifact paths are outbox-relative, unique, non-escaping file paths. A declared
artifact must exist. Undeclared regular files are still collected. Names affect
presentation, not the source path or content. Symlinks, special files, invalid
JSON, invalid metadata, and missing declared files fail collection visibly.
The declaration has a 1 MiB size limit.

Link kinds are `pull_request`, `preview`, or `external`; the kind is optional.
Links must use HTTP or HTTPS. Recording a PR link does not create a PR, verify
its contents, or grant Git credentials. Publishing, pushing branches, and opening
PRs remain explicit operations of an authorized harness or host.

The machine-readable declaration schema is
[outbox.schema.json](../schemas/outcomes/v1/outbox.schema.json).

## Durable manifest

The engine validates and commits immutable version-1 `RunOutcome` manifests for
completed-turn snapshots and the execution attempt's final collection, with
these fields:

| Field | Meaning |
| --- | --- |
| `version` | Outcome contract version, currently `1` |
| `id` | Stable engine-generated `wbo_...` outcome identity |
| `run_id` | The producing execution attempt's `wb_...` identity |
| `created_at` | Collection timestamp in ISO 8601 format |
| `completeness` | `complete` or `partial` |
| `turn_index` | Optional positive turn index for an outbox-only live snapshot |
| `summary` | Optional producer-provided summary |
| `changesets` | Collected changes grouped by logical writable workspace |
| `artifacts` | Named files with content descriptors |
| `links` | Named HTTP/HTTPS links |
| `warnings` | Structured codes and human-readable collection limitations |

Outcome identities belong to execution attempts. An ongoing session can return
multiple turn snapshots and a separate final outcome. Unchanged outbox contents
do not require a new snapshot for every turn. Resuming a session can produce
more outcomes. A failed or cancelled execution can return a partial outcome;
the terminal run status remains authoritative for
whether the requested work succeeded. `complete` describes an orderly completed
collection, not a guarantee that the agent's work is correct.

File contents are stored by SHA-256 digest. Each content descriptor contains
`digest`, `media_type`, and `size_bytes`. Bytes are verified when captured and
read. The engine does not resize images, transcode files, or substitute a
preview for the original artifact. A 1024-by-1024 generated image remains that
exact file when opened or exported.

New artifact descriptors include `path`, the original outbox-relative path,
independent of their display `name`. Opening a returned file materializes its
snapshot's entire file tree together under `outcomes/<outcome-id>/files/`, so
HTML reports resolve sibling SVGs, stylesheets and nested assets. Export keeps
the same layout under `artifacts/`. Earlier manifests without `path` use their
safe filename as a compatibility fallback; custom legacy display names cannot
recover a source path that was never recorded. No file bytes are rewritten to
repair relative links. Escaping, duplicate, case-colliding and file/directory
conflicting artifact paths fail validation.

The manifest schema is
[workbench-outcome.schema.json](../schemas/outcomes/v1/workbench-outcome.schema.json).

### Changesets

A changeset has its own ID, a logical `workspace` (`primary` or a named binding),
the original `base.snapshot_digest`, optional `base.git_revision`, ordered
`entries`, file-count `stats`, and an optional content-addressed review diff.

Entries describe `add`, `modify`, or `delete` operations. Existing paths have a
`before` fingerprint: kind, permission mode, and either file digest and size or
a relative symlink target. Added and modified paths have an `after` state with
the original file's content descriptor and mode, or a safe relative symlink.
Deletion entries have no `after` state.

The baseline is the selected workspace state before execution, including
preexisting dirty files. Changes are not inferred solely from harness text or
native `file.changed` events. Read-only bindings, private runner state,
credentials, and excluded inputs do not become writable workspace changesets.
Selection omits repository metadata, dependency trees, common credential paths,
and secret-bearing filenames. Git workspaces use tracked and unignored paths;
the non-Git fallback walks the directory with the same protected-path filter.
This is path-based protection, not a content classifier: do not place secrets in
ordinary source or output files and assume the engine will detect them.

File renames are represented as add and delete operations. Stats count changed
files, not added or removed lines. The entry data and stored after-content are
the apply authority; the review diff is for inspection, not a shell command or
the source of apply instructions. Empty directories are not versioned results.

## Application receipts and explicit actions

An application receipt is separate mutable metadata. Inspecting, opening, or
exporting a result must not change its receipt or immutable manifest.

- `pending`: isolated results have not been accepted into a host workspace.
- `present`: execution already edited the host workspace through Local or Docker.
- `applied`: the caller explicitly applied a pending changeset successfully.

Receipts contain `version`, `outcome_id`, `state`, and `updated_at`; `applied`
also requires `applied_at`. The schema is
[application.schema.json](../schemas/outcomes/v1/application.schema.json).

```sh
wb outcome wb_...
wb outcome wbo_... --json
wb outcome wbo_... --export ./review-bundle
wb outcome wbo_... --apply
wb outcome wbo_... --apply --workspace ./another-checkout
```

Inspect, export, and apply use locally collected bytes and require no E2B key,
live sandbox, harness login, or model request. Applying resolves the original
run's workspace bindings; `--workspace` overrides only the primary workspace.
Named changesets require their recorded named bindings. Export can be used to
move a self-contained result bundle without applying it.

Before apply, the engine validates every target path and expected fingerprint
across all involved workspaces. Conflicts reject the entire operation before
any path is installed. Escaping paths, symlink parents, and escaping symlink
targets are rejected. Apply rechecks paths during installation, serializes
applications of the same outcome, and recognizes paths already matching the
after-state. A retry must not overwrite subsequent unrelated host edits.

Controlled installation or receipt-write failures roll back installed paths.
If another writer prevents safe rollback, the engine reports that failure and
retains recovery backups rather than overwriting concurrent edits. This is not
an OS-wide multi-file transaction: an abrupt host crash can interrupt apply.
The per-path before/after checks allow review and a safe retry; preserved recovery
files are diagnostics, not an automatic restoration of arbitrary host state.

Export writes `outcome.json`, artifact files, and a directory for each changeset
containing its after-files and optional `changes.diff`. Deletions remain in the
manifest. The destination must not already exist. Neither export nor inspect
executes returned HTML, links, scripts, or binaries.

The engine prepares the bundle before exclusively claiming its destination;
another export or caller creating that destination makes the export fail without
replacing it. Publishing the prepared files is not a directory-wide transaction.
An interrupted publication may leave a partial bundle at the requested path; the
error identifies that path, and the original durable outcome remains available.

## Collection, cleanup, and recovery

Interactive sessions also snapshot finished outbox files and links after each
completed, non-cancelled turn. These immutable results are available while the
session is still open, without ending the sandbox or collecting workspace diffs.
Unchanged results do not produce repeated notifications. Revising an attachment
produces a new snapshot; earlier links still open the earlier bytes. Producers
must finish writing before ending a turn, using atomic rename for background
writers. Collection is not a filesystem transaction across concurrent writers.

Turn snapshots have a positive `turn_index`, `partial` completeness (execution
is ongoing), no changesets, and a `present` receipt. Their files are already
retained locally, including results from Docker and E2B. They do not apply or
overwrite any host workspace. The TUI shows command-clickable file and web links
on each snapshot card. `/outcome` opens the latest result without model work.

The final outcome collects workspace changes and the current outbox after
execution stops. The engine commits validated metadata and content before
publishing `outcome.available` and destroying disposable runtime resources.
The event contains the outcome ID, optional `turn_index`, completeness, initial receipt
state, and counts of changesets, artifacts, links, and warnings, plus an optional
summary. Artifact bytes and arbitrary tool results do not enter the event log.

Garbage collection also reclaims recognized engine-owned temporary writes left
by dead processes. It does not remove a live writer's temporaries or unrelated
files with unknown names. Retained outcomes and their referenced content remain
protected, and reclaimed temporary bytes repair the storage quota accounting.
Replaying or attaching to a run does not recollect outcomes or spend model tokens.

A collection failure must not be disguised as an empty successful outcome.
A failed turn snapshot emits `outcome.failed` with its turn index and error,
but leaves the session available for correction and another turn. A turn
snapshot never finalizes an E2B recovery record; recovery requires a final
outcome that includes workspace changes. Run retention accounts for and removes
all snapshots together with the final outcome.
For E2B, the engine retains a private checkpoint linking the run to its original
managed sandbox and selected input baseline. Failed collection pauses that
sandbox when possible. Ordinary history cleanup protects its run and sandbox
until the caller explicitly recovers or discards the pending work.

```sh
E2B_API_KEY=... wb outcome wb_... --recover
wb outcome wb_... --json
wb outcome wb_... --apply
# Or explicitly abandon the uncollected remote work:
E2B_API_KEY=... wb outcome wb_... --discard-recovery
```

Recovery reconnects only to the original scoped sandbox. It does not create a
fresh sandbox, upload a new workspace, log into a harness, or send a model task.
Recovered outcomes are partial and carry a recovery warning. Recovery must be
reviewed separately before apply or export. An active owner blocks recovery or
discard. Once collection is durable, the engine destroys the original sandbox
and removes its checkpoint. A failure to destroy it retains cleanup information.
Discard explicitly releases uncollected work without changing host files.

Recovery depends on the checkpoint and original provider-side filesystem still
existing. It is not a guarantee against provider expiration, provider data loss,
or a host crash before the checkpoint was written. Resume uses saved native
conversation context in a fresh runtime; it is not outcome recovery. Private
native conversation and credential transfers remain separate from result
collection.

## Storage and presentation

The reference engine stores manifests and receipts beneath
`$WORKBENCH_HOME/outcomes/<outcome-id>/`, with shared content beneath
`$WORKBENCH_HOME/blobs/`. Directories are private (`0700`) and result files use
`0600`; materialized artifact copies are separate from shared content so editing
an opened file cannot corrupt another retained outcome.

Default result limits are 256 MiB per content blob, 512 MiB of unique content per
outcome, 16 MiB per outcome manifest, and 5 GiB of aggregate engine-owned result
storage. Admission checks reserve capacity before writes under the same lease
used by capture and garbage collection. Shared bytes are charged once;
materialized artifact copies, manifests, and receipts also count. A quota failure
does not silently evict previously retained outcomes. Inspect `wb clean` before
explicitly removing history.

Workspace baselines and E2B uncompressed input/output transfers have their own
512 MiB safety limits. The result quota is not a whole-disk budget: it excludes
the agent's workspace, native harness history, private recovery baselines,
provider caches, and caller-selected exports. Runtime and model costs remain
separate from outcome storage accounting.

History cleanup removes outcomes belonging to selected terminal runs and then
reclaims shared blobs only when no retained outcome references them. Active
captures and pending recovery checkpoints are protected. Cleanup does not claim
reclaimed bytes for shared content still needed by another outcome.

The human CLI and TUI show outcome identity, receipt state, completeness,
changeset counts, warnings, and follow-up inspect/apply/export commands. Artifact
names link to local original-byte files; PR and preview links retain their
declared type and label. The TUI's `/outcome` dialog inspects collected results.
It does not render images inline or automatically apply or publish work.

An outcome is a portable data contract, not permission to execute the returned
content. Treat a package, its runtime image, and its generated outputs according
to the trust and authorization boundaries of the task.

## Verification

`bun run test` runs the ordinary regression suite without cloud execution or
model requests. Live integration tests are deliberately opt-in:

```sh
bun run test:outcomes:harnesses
bun run test:outcomes:browser
```

The harness suite uses real OpenCode and Pi on Local, Docker and E2B. It requires
the native local harnesses, Docker, `OPENROUTER_API_KEY` and `E2B_API_KEY`.
The default live fixture model is `anthropic/claude-sonnet-4-5` through OpenRouter;
`WORKBENCH_OUTCOME_MODEL` can select another model supported by the fixture catalog.
`WORKBENCH_OUTCOME_RUNTIMES=local,docker` selects a subset. Tests use private
fixture homes and remove only their own processes and scoped sandboxes. They
cover live result revisions, engine instructions, natural-language file delivery,
source-preserving revision after resume, original-byte export and explicit
workspace application. The CLI driver rejects unrelated external-directory
permission requests through the public run handle. Each task must still finish
and return the expected files; a rejected permission is not successful delivery.
Repeated requests, other approvals and questions fail the unattended check;
the driver never grants broader filesystem access.

The browser check executes generated fixture HTML only, in an isolated headless
browser profile. It verifies SVG image dimensions and computed CSS after
opening original, revised and exported bundles. It uses Google Chrome's default
macOS installation; set `WORKBENCH_OUTCOME_BROWSER_BINARY` to a Chrome or Chromium
executable elsewhere. It does not access the user's browser session or accounts.
