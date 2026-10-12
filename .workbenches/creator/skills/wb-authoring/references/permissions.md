# Runner permissions

A headless run that hits a permission prompt stops and waits. To the person supervising it, that looks exactly like slow work. The package's `runner_config` decides which prompts happen, so get it right before anyone runs the Workbench detached.

For OpenCode, ship `opencode.json` in the package and declare it:

```yaml
runner_config: ./runner/opencode.json
```

## What to allow

- **Reading and skills.** Allow `read`, `skill`, `list`, and `grep` so the runner can load the package's own skills and references.
- **The package and tool paths.** The package is mounted outside the working tree (`/workbench` in Docker), and image tools live under `/opt` or `/usr/local`. Every path the work touches outside the workspace needs an `external_directory` allow: the package, tool directories, browser profiles, scratch directories under `/tmp`.
- **Shell.** Allow the commands the work runs. A broad allow with explicit denies for destructive commands is the shape that works in practice.

## What to deny

- Secret files: `*.env` and `*.env.*` (allow `*.env.example`).
- Destructive commands specific to the domain, for example deleting cloud apps or volumes.
- `task`, when the work must stay in one context and the runner should not spawn its own sub-agents.

## Example

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "read": {
      "*": "allow",
      "*.env": "deny",
      "*.env.*": "deny",
      "*.env.example": "allow"
    },
    "skill": "allow",
    "external_directory": {
      "/workbench/**": "allow",
      "/opt/acme-tools/**": "allow",
      "/tmp/**": "allow"
    },
    "bash": {
      "*": "allow",
      "flyctl apps destroy*": "deny",
      "flyctl volumes destroy*": "deny"
    },
    "task": "deny"
  }
}
```

For Claude Code, ship a JSON file with Claude Code permission rules and an optional turn limit, and declare it the same way (`runner_config: ./runner/claude-code.json`). Only `permissions.allow`, `permissions.deny`, and `max_turns` are accepted; any other field fails validation. Declared MCPs, the outbox, and named workspaces are granted by the engine, so do not list them.

```json
{
  "permissions": {
    "allow": ["Read", "Glob", "Grep", "Skill", "Read(//opt/acme-tools/**)", "Bash(npm test:*)", "Bash(git diff:*)"],
    "deny": ["Read(./.env)", "Read(./.env.*)", "Bash(flyctl apps destroy:*)"]
  },
  "max_turns": 200
}
```

Check the runner's documentation for the version you pin; permission keys and rule syntax are the runner's, not the Workbench standard's.

## Test it

Run one tiny real task with `--detach`, then `wb wait`. Do not approve any prompt. If it stops on `needs_input`, read the pending request and add the missing allow. Repeat until a representative task finishes with no prompts. Never ship a config that relies on the consumer approving everything.
