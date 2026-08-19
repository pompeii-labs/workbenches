# Workbench

Workbench is an open format and reference engine for repository-owned execution
recipes. A Workbench packages the expertise and environment needed to work on a
class of problems, then names the runner that should execute it.

This repository is an early experiment. It is not yet a stable specification or
a working general-purpose runtime.

## Current experiment

The first vertical slice supports:

- `runner: opencode`
- `runtime: local`
- A selected model
- A native OpenCode instruction file
- Portable, on-demand `SKILL.md` skills
- Optional authenticated remote MCP servers
- Required local CLI tools and environment variables

Run a Workbench with:

```sh
bun run src/cli.ts run /path/to/repo/.workbenches/name \
  --task "Describe or perform the work"
```

Inspect the translated OpenCode launch without executing it:

```sh
bun run src/cli.ts run /path/to/repo/.workbenches/name \
  --task "Describe or perform the work" \
  --dry-run
```

The Workbench engine reads `workbench.yml`. OpenCode does not. The engine
resolves the manifest and supplies instructions through OpenCode's native
configuration while sending the task separately as the user message. Declared
skills are staged for native OpenCode discovery, and remote MCP environment
references are translated without exposing their values in generated config.

See [SPEC.md](SPEC.md) for the current format sketch.
