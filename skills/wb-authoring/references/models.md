# Models and provider routes

Write the newest spec your installed `wb` supports: `wb init` scaffolds it and `wb validate` rejects anything else.

## Choosing the model

`model.id` is provider-neutral: `lab/model`, for example `anthropic/claude-opus-5-5` or `openai/gpt-5.6-terra`. It must exist in the model catalog; `wb init --model <id>` rejects unknown ids, and `wb view` shows the resolved routes.

Pick the model from trial evidence on this Workbench's real tasks (see `trials.md`). Until there is evidence, keep the existing choice and report it as unevaluated. Cost matters: report cost per working result, not per run.

## Routes: leave them out by default

```yaml
model:
  id: anthropic/claude-opus-5-5
```

With no `routes`, every provider that serves the model is allowed, the lab's own provider first. A consumer with an Anthropic key, an OpenRouter key, or a Vercel AI Gateway key can all run it. This is the right default: consumers should never be stuck because they lack one particular provider's key.

Add `routes` only when a provider must be excluded or ordered, for example a provider whose serving of the model is known to break the work:

```yaml
model:
  id: anthropic/claude-opus-5-5
  routes:
    - provider: anthropic
    - provider: openrouter
```

Rules:

- Only listed providers are allowed, in this order.
- Each provider must serve the model. Duplicate providers are an error.
- `model` inside a route overrides the provider-native id, for providers that name it differently.
- A model the catalog does not know needs explicit route `model` ids and a packaged `runner_config` describing it to the runner.

## How consumers authenticate

The engine uses the first authenticated route: an explicit `--connection`, the consumer's `wb connect` default, then a route whose key is in the environment (for example `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`), then the runner's own credential store. Keys for other providers are removed from the run. The package never contains keys; it declares names only.

When writing the Workbench's description or README, name the providers it was trialed with, so consumers know which keys are proven.

## Runner choice

- `opencode`: the default. Supports remote MCP servers, permission config in `opencode.json`, and OpenCode's own sign-in flows (including a ChatGPT subscription for OpenAI models). OpenCode 1 (npm `opencode-ai`) is the supported release. OpenCode 2 (npm `@opencode/cli`, 2.2.2 or newer) is experimental and still changes between releases, so pin it and run the Workbench again before moving the pin. What differs for an author on OpenCode 2: MCP servers in `runner_config` need `"codemode": false` (see `permissions.md`); questions arrive as forms, and only unconditional string and multiselect fields can be answered; the first prompt waits until every configured MCP server has connected, failed, or asked for sign-in; on `local` it keeps sessions and sign-ins in the consumer's own OpenCode database, so a local session resumes only on that machine; and the `--dry-run` translation still shows OpenCode 1's `opencode run` arguments. On OpenCode 2.2.3 or newer, an `anthropic` route can also run on a Claude subscription through its Claude Agent provider: the consumer picks `claude-subscription` in `wb connect` (or `--connection claude-agent`), Claude Code must be installed and signed in where the run happens, and the run uses the manifest's exact model id. It works on `local` and `docker`, not on `e2b` or `daytona`.
- `pi`: supports remote HTTP MCP servers through Pi's built-in MCP support; a Workbench declaring `mcps` needs Pi 0.99 or newer. Workbench stages `mcp.json` in its private agent directory with `exposure: "direct"`, keeping header environment references unexpanded. Native extension dialogs provide questions; Pi has no permission protocol and runs tools without approval. Needs a directory `runner_config`, and first-run sign-in inside a run is not available; give consumers env keys.
- `claude-code`: the same `lab/model` ids and catalog as every runner, routed through Anthropic, OpenRouter, or Vercel AI Gateway. Supports remote MCP servers, mid-turn steering, and a JSON-file `runner_config` (see `permissions.md`). A Claude subscription works on `local` (the consumer's own Claude Code login) and on `docker`, `e2b`, and `daytona` through the consumer's own `CLAUDE_CODE_OAUTH_TOKEN`, which comes from their environment and is never stored.
