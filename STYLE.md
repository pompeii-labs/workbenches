# Workbench engineering style

This document defines the architecture and implementation standards for the
Workbench reference engine. Code should make ownership and execution flow
obvious to a maintainer who did not write it.

## Architecture

Organize production code by product domain, not by implementation fragment.
The expected top-level structure is:

```text
src/
  workbench/
  runners/
  runtimes/
  models/
  connections/
  runs/
  registry/
  commands/
  tui/
```

Only executable and public entrypoints belong directly under `src/`. Do not add
new root modules for a feature that is owned by one of the domains above.

Each domain must expose a small, deliberate surface. Internal helpers stay in
their owning directory and must not be re-exported from the package root.
Cross-domain imports should depend on contracts or domain entrypoints rather
than another domain's private implementation.

## Ownership

Use classes for objects that own state, resources, policy, or a lifecycle. The
core ownership model is:

- `Workbench` owns a resolved package and its immutable configuration.
- `Runner` defines the harness contract. Concrete runners own translation,
  authentication, assets, event normalization, and sessions for one harness.
- `Runtime` defines the execution-environment contract. Concrete runtimes own
  preparation, process execution, isolation, and cleanup.
- `WorkbenchRun` owns one run lifecycle and normalized event stream.
- `ConnectionManager` owns local provider-route selection without owning
  credential values.
- `ModelCatalog` owns verified metadata retrieval and local caching.

Use pure functions for parsing, formatting, schema validation, and small
deterministic transformations. Keep them private unless another domain truly
requires them. Do not model a stateful workflow as a chain of exported utility
functions.

## Files and names

Name a module after the object or concept it owns. Avoid root-level fragment
names such as `thing-auth.ts`, `thing-assets.ts`, and `thing-process.ts` when
those pieces belong to a concrete class or domain directory.

Production files should remain below 500 lines. A file approaching that size
should be split by owned responsibility before more behavior is added. A
production file may not exceed 700 lines. Generated files and declarative
schemas are the only exceptions and must live outside handwritten source.

Use PascalCase for classes and types, camelCase for functions and values, and
kebab-case for filenames. Prefer precise product language over generic names
such as `manager`, `helper`, or `utils` unless the named class genuinely owns
that responsibility.

## Commands

Command modules translate CLI arguments into a domain operation and render its
result. They do not own runner, runtime, registry, or persistence behavior.

Human output, machine-readable output, prompting, cancellation, and errors must
use shared CLI interaction contracts. A command must retain a non-interactive
path when it can be used by automation.

## Public API

`src/index.ts` is the only package public API. Export contracts and stable
product objects deliberately. Do not wildcard-export implementation modules.
The CLI may import private domains directly, but outside consumers should not
need to understand the engine's internal file layout.

Compatibility is defined by the Workbench specification, documented CLI
behavior, and normalized event protocol. Internal source paths are not public
contracts.

## Metadata

The OSS engine consumes versioned metadata published by workbenches.dev. It
verifies immutable artifacts and caches them under the Workbench home.

Catalog generation, upstream synchronization, publication, and scheduled
refresh belong to workbenches.dev. Do not bundle generated provider catalogs,
catalog locks, or cloud publication scripts in the engine repository.

## Credentials and security

Workbench packages declare credential requirements by environment-variable
name. They never contain credential values.

Runner credentials remain owned by the runner or an explicitly mounted
credential store. Workbench may select a compatible route and prepare a secure
mount, but it must not copy credentials into a package, saved snapshot, log,
event, or task.

Host control-plane processes receive only the environment they require. Runtime
credentials must not leak into Docker clients, image builders, credential
helpers, or unrelated child processes.

Security policies need named ownership and focused tests. Do not hide a policy
as an unexplained constant inside a parser or a large runtime module.

## Testing

Tests mirror production domains. Every concrete runner and runtime must satisfy
its shared contract suite in addition to focused unit tests.

A build proves compilation. Unit tests prove isolated behavior. Integration
tests prove boundaries. Only an end-to-end run proves the product path. Report
those levels separately.

Structural refactors must preserve behavioral coverage. Move tests with their
domain, add architecture checks for rules that can be enforced mechanically,
and run the full suite before a branch is presented for review.

## Repository hygiene

Public code, comments, documentation, commits, branches, and pull requests must
not mention internal planning systems, ticket identifiers, codenames, private
infrastructure, or temporary local workflows.

Do not use em dashes in product copy or documentation. Do not commit drafts,
local fixtures, generated build output, credentials, or secret-bearing files.
