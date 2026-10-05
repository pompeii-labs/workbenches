# Models and provider routes

## Choosing the model

`model.id` is provider-neutral: `lab/model`, for example
`anthropic/claude-opus-5-5` or `openai/gpt-5.6-terra`. It must exist in the
model catalog; `wb init --model <id>` rejects unknown ids, and `wb view` shows
the resolved routes.

Pick the model from trial evidence on this Workbench's real tasks (see
`trials.md`). Until there is evidence, keep the existing choice and report it
as unevaluated. Cost matters: report cost per working result, not per run.

## Routes: leave them out by default

```yaml
model:
  id: anthropic/claude-opus-5-5
```

With no `routes`, every provider that serves the model is allowed, the lab's
own provider first. A consumer with an Anthropic key, an OpenRouter key, or a
Vercel AI Gateway key can all run it. This is the right default: consumers
should never be stuck because they lack one particular provider's key.

Add `routes` only when a provider must be excluded or ordered, for example a
provider whose serving of the model is known to break the work:

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
- `model` inside a route overrides the provider-native id, for providers that
  name it differently.
- A model the catalog does not know needs explicit route `model` ids and a
  packaged `runner_config` describing it to the runner.

## How consumers authenticate

The engine uses the first authenticated route: an explicit `--connection`, the
consumer's `wb connect` default, then a route whose key is in the environment
(for example `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`), then
the runner's own credential store. Keys for other providers are removed from
the run. The package never contains keys; it declares names only.

When writing the Workbench's description or README, name the providers it was
trialed with, so consumers know which keys are proven.

## Runner choice

- `opencode`: the default. Supports remote MCP servers, permission config in
  `opencode.json`, and OpenCode's own sign-in flows (including a ChatGPT
  subscription for OpenAI models).
- `pi`: no MCP support (a Pi Workbench with `mcps` fails), needs a directory
  `runner_config`, and first-run sign-in inside a run is not available; give
  consumers env keys.
