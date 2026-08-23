---
name: workbench-authoring
description: Design, author, review, and repair portable Workbench packages. Use when deciding which expert Workbenches a repository should publish; creating or editing `.workbenches/*/workbench.yml`, instructions, skills, tool requirements, MCP bindings, runtimes, or images; validating and smoking a package; or reviewing a Workbench for focus, portability, safety, and spec compliance.
---

# Workbench authoring

Create packages that give an AI maintainer-authored expertise and deterministic
execution requirements without turning the package into an agent framework.

## Load the standard

Read [references/spec.md](references/spec.md) before designing or reviewing a
package. Consult
[references/workbench.schema.json](references/workbench.schema.json) when exact
fields or constraints matter. These files are packaged copies of the normative
draft-0 sources so saved and remote Workbenches remain self-contained.

## Inspect before designing

1. Read the target repository's agent guidance and primary documentation.
2. Inspect its package manifests, CLI entry points, runtime configuration,
   integration code, and representative tests.
3. Identify expertise maintainers repeatedly need to explain, tools that must be
   present, optional authenticated integrations, and environment assumptions.
4. State the proposed Workbench boundary before writing files.

Do not read `.env`, credential stores, private keys, or generated secret-bearing
configuration. Record environment variable names only. When reviewing a package
that already contains a credential-like value, cite its location and redact the
value instead of repeating it.

## Choose the package boundary

Prefer one focused Workbench when the same instructions, skills, tools, model,
and runtime support the tasks. Split packages only when at least one of those
contracts differs materially.

Good boundaries describe expertise, such as `core`, `migrations`, `security`, or
`release`. Avoid packages that merely rename generic roles such as `coder`,
`reviewer`, or `planner` without repository-specific knowledge.

Keep orchestration outside the package. Do not encode task graphs, schedules,
human approval stages, retries, or interface behavior in Workbench instructions.

## Scaffold and author

Create a package from the repository root:

```sh
wb init <name>
```

For another target directory:

```sh
wb init <name> --dir /path/to/repository
```

Then refine the generated files.

### Manifest

- Keep `spec` on the newest version the installed engine supports; never guess a
  future version.
- Use semantic versioning for the package `version`. Increment it when published
  package behavior changes.
- Choose `runner` and `model` from evidence relevant to the Workbench's real
  tasks. Do not claim a model is optimal, available, or appropriate without
  repeatable evidence. When evidence is absent, preserve an existing valid
  choice or retain the scaffold default and report that it remains unevaluated;
  do not invent a replacement.
- Keep `instructions` and every skill inside the package so it can be saved as a
  self-contained snapshot.
- Declare exact executable names in `tools`. Presence is preflighted; version
  compatibility is not currently implied.
- Declare environment names at root under `env`. Never store values.
- Use `mcps` only for remote HTTP MCP servers. Reference declared environment
  variables from headers as `${NAME}`.
- Mark an environment binding optional only when the Workbench remains useful
  without it. An MCP depending on an unset optional binding is disabled.
- Select `runtime: local` only when host execution is intentional. Use an image
  only with a runtime provider that supports it.

### Instructions

Write stable domain guidance that should shape every run. Establish the
Workbench's scope, authoritative repository sources, important invariants,
safety boundaries, and expected verification. Do not repeat the manifest or
teach the runner how to parse it.

Avoid vague instructions such as “be helpful” or “follow best practices.” Name
the repository-specific conventions and failure modes that change execution.

### Skills

Use a skill for focused procedures or reference material that should load only
when relevant. Give each skill a lowercase hyphenated directory and matching
`name` in YAML frontmatter. Put all trigger conditions in the frontmatter
`description`; keep the body imperative and concise.

Place detailed schemas or documentation in one-level-deep `references/` files
and link to them directly from `SKILL.md`. Do not create auxiliary READMEs,
changelogs, or duplicated quick-reference files inside a skill.

### Docker images

Use a package-local Dockerfile when consumers should build the environment from
source. Use a published OCI image when the environment should be prepared once
and reused consistently. In either case, ensure the image contains the declared
runner and tools and supports the runtime constraints described by the standard.

To publish a locally built image to the Workbench registry:

```sh
wb login
docker build -t <local-image> <context>
wb image push <local-image> \
  --publisher <publisher> \
  --as <image-name> \
  --tag <version>
```

The command exports the local image, reuses blobs already stored by the
registry, uploads missing blobs in bounded chunks, and publishes the original
OCI manifest. The resulting manifest reference is:

```yaml
runtime: docker
image: images.workbenches.dev/<publisher>/<image-name>:<version>
```

Use `wb image login` when a standard OCI client needs explicit registry
credentials. Direct client pushes are subject to the registry edge's
per-request body limit, so use `wb image push` for images with large layers.
Use a versioned tag rather than `latest` for a published Workbench, and do not
overwrite an image tag already referenced by a released package. Run `wb
build`, `wb smoke`, and a representative task against the published reference
before describing it as verified.

## Verify truthfully

Run the narrow checks first:

```sh
wb validate /path/to/repository#<name>
wb view /path/to/repository#<name>
wb smoke /path/to/repository#<name>
```

Interpret them precisely:

- `validate` proves the package parses and its local files satisfy the schema.
- `view` confirms the resolved contract and authorization bindings without
  revealing values.
- `smoke` proves the declared runner and tools are available in the selected
  runtime without making a model request.
- A successful smoke does not prove the instructions, skills, model, or
  integration behavior are effective.

Exercise realistic tasks before recommending publication. Distinguish a file
change, passing validation, passing smoke, and an end-to-end successful run.

## Review an existing Workbench

Report findings in priority order and cite concrete package files. Check:

- Is the expertise boundary specific and useful?
- Are instructions based on maintainer knowledge rather than generic advice?
- Does the package avoid workflows and product behavior?
- Are instructions, skills, and image paths portable?
- Are tools, MCPs, environment bindings, runtime, and image minimal and honest?
- Are secrets absent from the package and output?
- Does each optional integration degrade cleanly?
- Does the selected model have task-relevant evidence behind it?
- Do `validate`, `view`, and `smoke` agree with the claims?
- Has the package been exercised on representative work rather than fixtures
  alone?

When repairing a package, preserve its intended expertise boundary unless the
user authorizes a redesign. Never hide unsupported behavior behind a fallback.
