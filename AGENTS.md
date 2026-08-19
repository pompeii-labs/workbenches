# Workbench Agent Guide

These rules apply to the entire repository.

## Product definition

Workbench is an open standard for packaging the expertise, runner, model,
skills, tools, integrations, runtime, and authorization requirements needed for
an AI to perform a class of work.

A Workbench is not an agent, workflow, DAG, planner, or user interface. The
reference CLI may provide execution and interaction surfaces, but those are
implementations around the portable package rather than part of its identity.

The Workbench engine reads and validates `workbench.yml`. A runner must never be
asked to interpret the manifest itself.

## Sources of truth

- `SPEC.md` and `schemas/` define the draft package contract.
- `docs/EXECUTION.md` and the event schemas define the portable execution
  boundary.
- `docs/` describes reference-engine behavior that is not normative.
- Tests are evidence for the implementation, not a substitute for the
  specification.

Keep normative requirements separate from implementation status. A reference
engine limitation must not be described as a restriction of the open standard.

## Compatibility

The integer `spec` field selects a parser. Released parsers are immutable.
Changes to an existing parser may reject previously invalid input more
precisely, but must not reinterpret a valid published package. Add a new parser
and schema version for incompatible format changes.

Runner-native payloads are not the portable API. Adapters translate known
semantics into versioned Workbench events and must not leak reasoning text,
credentials, provider metadata, or arbitrary tool results into normalized
events.

## Runtime and security boundaries

- Perform deterministic preflight inside the selected runtime before launching
  a runner or spending model tokens.
- Treat declared environment variables as references. Never write their values
  into manifests, generated configuration, logs, dry-run output, saved package
  metadata, or events.
- Remote inspection is read-only and must not clone or create temporary
  repository checkouts. Saving package content requires an explicit operation.
- Keep source repositories, saved Workbench packages, target workspaces, and
  runtime state as separate concepts.
- Reject unsupported runtimes, transports, and runner behavior explicitly.

## Code conventions

- Use strict TypeScript and preserve the existing ESM module boundaries.
- Keep runner-specific transport and event parsing inside runner adapters.
- Keep CLI commands thin; put reusable behavior in source modules.
- Pass environment, process, network, time, and storage dependencies through
  explicit boundaries when deterministic tests need control over them.
- Prefer small domain types and explicit errors over loosely shaped objects or
  silent fallbacks.
- Avoid comments that restate the code. Document invariants and non-obvious
  safety decisions where they are enforced.
- Split a module when it begins to own more than one lifecycle or protocol
  concern; line count alone is not a reason to churn cohesive code.

## Public repository hygiene

- Do not commit private tracker references, internal plans, launch notes,
  competitive research, screenshots, credentials, machine-specific paths, or
  local Workbench labs.
- Do not leave unfinished-work markers or filler language in production code or
  public documentation. Track unfinished work outside the repository and
  describe only current limitations that users need to know.
- Do not publish exact test counts, benchmark numbers, compatibility claims, or
  runtime support unless they are reproducible and currently verified.
- Keep examples obviously synthetic. Verbatim license and legal templates may
  retain the canonical text supplied by their authors.
- Do not add a roadmap, changelog, RFC process, or governance ceremony before
  the corresponding public process exists.

## Verification

Use the narrowest relevant tests while iterating, then run the complete local
gate before requesting review:

```sh
bun run check
bun run test:coverage
bun run build
bun audit
```

Confirm distribution builds contain `LICENSE` and `NOTICE`. Distinguish clearly
between code implemented, automated tests passing, and behavior exercised
against a real runner. Never call a runner or runtime integration verified from
fixtures alone.

Commits use Conventional Commits. Do not rewrite history, change repository
visibility, add a remote, publish a package, or push a release without explicit
maintainer approval.
