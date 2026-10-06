# Manifest, runtimes, and verification

## Scaffold

From the repository root:

```sh
wb init <name>
wb init <name> --dir /path/to/repository
```

The scaffold is a placeholder. Replace every generated line.

## Manifest rules

- Write the newest spec your installed `wb` supports: `wb init` scaffolds it and `wb validate` rejects anything else. Never guess a future version.
- Use semantic versioning for `version`. Increment it whenever package content changes, so each content identity has a distinct version.
- Choose `runner` and `model` from trial evidence on this Workbench's real tasks. Record the evidence (tasks, attempts, worked count, cost per working result) in the report. When there is none yet, keep the existing valid choice and say plainly that it is unevaluated.
- Lock the runner and model policy. Use ordered model `routes` only for providers that serve the same model. Consumers connect credentials with `wb connect`; they do not override the package's runner, model, routes, or native configuration.
- Put runner-native configuration inside the package and declare it with `runner_config`. Use it to enforce what the instructions promise: deny sub-agent delegation, scope file permissions, deny secret files. Never package credential files or literal secrets.
- Keep `instructions` and every skill inside the package so it can be saved as a self-contained snapshot.
- Declare exact executable names in `tools`. A tool must already be on the runtime's PATH: installed on the host for `local`, or installed in the image for `docker`, `e2b`, and `daytona`. A gate or helper script that ships inside the package is not on PATH. Keep it under a skill's `scripts/` and invoke it by the path in gates.md, and declare it in `tools` only when the image installs it on PATH. Presence is preflighted before a model request is made. Version compatibility is not.
- Declare environment names at the root under `env`. Never store values. Mark a binding optional only when the Workbench stays useful without it.
- Use `mcps` only for remote HTTP MCP servers. Reference declared environment variables from headers as `${NAME}`. An MCP that depends on an unset optional binding is disabled for that run.
- Declare `runtimes` as a map of the providers the Workbench supports, first entry as the default. Declare `local: {}` only when host execution is intentional. Give `docker` and `e2b` an `image`. Give `daytona` a `class` (`linux` is the only one that runs today) and a published `image` (optional in the schema, required to run). Never write `runtime`, a top-level `image`, or a top-level `docker`; the current spec rejects them. Details in `runtimes.md`.
- Declare `requirements` (`os`, `arch`, `cpu`, `memory_gb`, `disk_gb`, `gpu`) only for constraints the work truly depends on.

## Skills

A skill is a directory with a lowercase hyphenated name and a `SKILL.md` whose YAML frontmatter has a matching `name` and a `description`. Put every trigger condition in the description; the body is imperative. Place detailed material in one-level-deep `references/` files linked from `SKILL.md`, and scripts and templates in `scripts/` and `templates/` or `assets/`. Do not add READMEs or changelogs inside a skill.

## Images

Use a package-local Dockerfile when `docker` consumers should build the environment from source. Use a published OCI image when it should be prepared once and reused, and always for `daytona`. The full image contract and a minimal Dockerfile are in `runtimes.md`.

To publish a locally built image to the Workbench registry:

```sh
wb login
docker build -t <local-image> <context>
wb image push <local-image> --org <org> --as <image-name> --tag <version>
```

The resulting reference:

```yaml
runtimes:
  docker:
    image: images.workbenches.dev/<org>/<image-name>:<version>
  daytona:
    class: linux
    image: images.workbenches.dev/<org>/<image-name>:<version>
```

Use a versioned tag, never `latest`, and never overwrite a tag a released package references. Use `wb image login --org <org>` when a standard OCI client needs registry credentials. The wb-publishing skill covers the whole flow.

## What each check proves

A package must sit beneath a `.workbenches/` directory (`.workbenches/<name>/workbench.yml`). The engine refuses any other location, for every command. From the repository root:

```sh
wb validate .#<name>
wb view .#<name>
wb smoke .#<name>
wb run <alias> --dry-run --task "..."
```

From elsewhere, use `/path/to/repository#<name>` or the path `/path/to/repository/.workbenches/<name>`. After `wb add ./.workbenches/<name> --as <alias>`, the alias is live: new runs read the current files, so edits need no re-add.

- `validate`: the package parses and its local files satisfy the schema.
- `view`: the resolved contract and authorization bindings, without values.
- `smoke`: the runner and every declared tool exist in the selected runtime. No model request is made.
- `run --dry-run`: the request resolves, preflights, and translates without launching the runner.

None of these says anything about whether the package produces good work. Only trials on real tasks do. Keep the four results distinct when you report: a file change, passing validation, passing smoke, and an end-to-end successful run.

## Boundaries the standard enforces

A Workbench prepares execution. Task graphs, schedules, approval stages, retries, and product interface behavior belong to whatever orchestrates it, not to the package. One package per coherent class of work; split only when the instructions, skills, tools, model, or runtime differ materially.
