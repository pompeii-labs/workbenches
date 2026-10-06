# Providers and connections

## The model catalog

`wb` reads a digest-verified model catalog from `metadata.workbenches.dev` and caches it for six hours. It maps each model (`lab/model`) to the providers that serve it and each provider to the environment variable names it reads. Hundreds of providers are listed. `wb view <alias>` shows the routes a Workbench allows and which are ready. There is no command to browse the whole catalog; `wb init --model <id>` rejects a model the catalog does not know.

## How a run picks a provider

- No `routes` in the manifest: every catalog provider that serves the model is allowed, the lab's own provider first, then alphabetically.
- With `routes`: only those providers, in the author's order.
- Selection: `--connection` if authenticated, else the `wb connect` default if authenticated, else the first route with a key in the environment, else the runner's own credential store. If the first route has no key and a later one does, the later one is used without a warning.
- After selection, keys for other providers are removed from the run's environment.

Common provider variables:

| Provider | Variable |
| --- | --- |
| `openai` | `OPENAI_API_KEY` |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` |
| `google` | `GEMINI_API_KEY`, `GOOGLE_API_KEY`, or `GOOGLE_GENERATIVE_AI_API_KEY` |
| `xai` | `XAI_API_KEY` |
| `mistral` | `MISTRAL_API_KEY` |
| `vercel` | `AI_GATEWAY_API_KEY` |

Where keys come from, per run: the `wb` process environment, then `--env-file FILE`, then `--env NAME=value`. `--env-file` silently ignores names that are not provider keys or declared by the Workbench; `--env` rejects them. Prefer `--env-file` or the inherited environment over `--env`, which lands in shell history.

Runner credential stores:

- OpenCode: `opencode auth login` on the host serves `local`. `docker` keeps its own credential volume. `e2b` uses a store under `~/.workbench`. These are filled by the first interactive `wb run` sign-in.
- Pi: configure Pi separately for `local`; supply env keys for other runtimes.
- Daytona: no store. Environment keys only.

## wb connect

`wb connect <alias>` saves one default per runner and runtime: the provider and the sign-in method (`api-key`, `chatgpt` for an OpenAI subscription, or the provider's native sign-in). It stores no secret. The default is reused by every compatible Workbench on that runner and runtime. It prompts unless `--runtime`, `--harness`, `--provider`, and `--method` are all given. It is not a sign-in.

A ChatGPT subscription or other native sign-in completes on the first interactive run. A detached or headless run cannot complete it.

## Errors and fixes

| Error | Fix |
| --- | --- |
| `No authenticated route is available for <model>. Run wb connect <ref>.` | Run `wb view <ref>` to see allowed routes. Export one provider's key in the environment of `wb` (or pass `--env-file`), or have the person run `wb connect <ref>` and sign in interactively once. Exit code 3. |
| `Connection X is not authenticated for <model> with <runner> in the <runtime> runtime. Run wb connect <ref>.` | The `--connection` provider has no credential in this runtime. Drop the flag or supply that provider's key. |
| `Authentication is required for <provider>. Start this Workbench interactively once to finish <provider> sign-in.` | The saved default is an OAuth or native sign-in that has not finished. Run once without `--detach`, or switch to an API key. |
| `First-run authentication for pi is not available inside a Workbench run yet` | Configure Pi outside `wb`, or pass an env key. |
| `DAYTONA_API_KEY is required for the Daytona runtime...` / `E2B_API_KEY is required...` | Set the variable or have the person run `wb connect --runtime daytona` (or `e2b`). |
| `Model metadata is not cached. Run the command again while connected to the internet.` | The catalog was never fetched; go online once. |
| `Missing required environment variable: NAME` | The Workbench declares `NAME` as required. Provide it by env or `--env-file`. |

Never read or print a key to check for it. Test by name: `test -n "$ANTHROPIC_API_KEY" && echo set`.
