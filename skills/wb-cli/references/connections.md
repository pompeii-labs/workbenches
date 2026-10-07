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

Runner credential stores, one per runtime:

- `local`: the runner's normal local sign-in, which `wb connect` only verifies and `--remove` never changes.
- `docker`: a per-runner volume. OpenCode and Pi keep their native files; Claude Code keeps container sign-in state and engine-owned provider-key entries.
- `e2b`: a private native store for OpenCode and Pi; Claude Code uses provider environment variables instead.
- `daytona`: environment only for model credentials.

## wb connect

`wb connect <alias> --runtime <runtime>` saves one default per runner and runtime after the route is ready. Depending on runner capabilities and runtime, it verifies local sign-in, opens Docker sign-in, writes a runner-native credential, or checks a provider variable. The default is reused by every compatible Workbench on that runner and runtime. Without a Workbench, use `--runtime`, `--harness`, and `--provider`, plus `--method` when the provider has several. Docker always needs a Workbench because its volume is prepared and checked through the Workbench image.

Where the credential comes from, in order:

1. A declared Docker native login, such as `claude auth login`, runs with inherited terminal input and output inside the Workbench container.
2. `--stdin`: an API key on standard input for a Workbench-owned store, as the bare value only (not a `NAME=value` line). Never put a key in argv.
3. Any stored API-key method in a terminal: a hidden paste prompt, such as `OpenRouter API key for Docker runs (input hidden)`.
4. A Docker subscription method: the runner's documented login command runs with inherited terminal input and output. It needs a person at a terminal.

`wb connect` never reads another tool's credential files directly. The runner reports readiness. Claude Code local runs use the person's normal sign-in: `wb connect` checks `claude auth status --json`, reads only login status and method fields, and directs a missing login to `claude auth login`. It never launches or removes local login. Docker keeps a separate Claude Code sign-in in the runner's named volume. Claude Code credentials are never copied to E2B or Daytona.

The last line is `Ready: <Provider> for <Runner> in <runtime>` after the runner itself listed the credential, or `Saved: ...` for `e2b`, where checking would create a billable sandbox and the first run confirms it. Anything else exits 3 with the missing piece and the command that fixes it, and leaves the previous default in place; the default is saved only on success. Readiness respects the method: a provider variable never makes a subscription ready. Piped output is `ready`, `saved`, `removed`, or `absent`, then runtime, runner, and provider, tab separated.

`wb connect --runtime e2b --harness opencode --provider openrouter --remove` removes that provider's entry from that store, keeps the others, and drops the saved default if it pointed at that provider (`docker` needs the Workbench reference). For an environment-only route or any local runner, `--remove` still drops the default without changing external credentials. `--status` checks a selected model credential without changing it. Plain `wb connect --runtime e2b --remove` still removes the saved E2B key.

An environment variable for the provider, or `--env-file`, wins over a stored entry and works for one run without connecting. Pi is the exception: its native stored credential wins over the provider variable.

## Errors and fixes

| Error | Fix |
| --- | --- |
| `No authenticated route is available for <model>. Run wb connect <ref> --runtime <runtime>, or pass the provider key for one run with --env-file.` | Run `wb view <ref>` to see allowed routes. Pass one provider's key with `--env-file` (or the environment of `wb`), or run the exact `wb connect` command shown, which fills that runtime's store. Exit code 3. |
| `Connection X is not authenticated for <model> with <runner> in the <runtime> runtime. Run wb connect ...` | The `--connection` provider has no credential in this runtime. Drop the flag, supply that provider's key, or connect it for that runtime. |
| `wb connect` exits 3 with `Pass the <Provider> API key on standard input: ...` | No key was given and no terminal is attached. Pipe the key with `--stdin`, or have the person run the command in a terminal. |
| `wb connect` exits 3 with `... in a terminal with OpenCode installed` | A subscription needs a fresh sign-in. Hand the command to the person, or start one foreground task run so Workbench can present the sign-in flow. |
| `Docker keeps <Runner> credentials in a volume that is written and checked through a Workbench image` | Rerun with a Workbench reference: `wb connect <alias> --runtime docker`. |
| `<Runtime> has no runner credential store...` | Set the provider variable where `wb` runs or pass `--env-file` on each run. Claude Code uses this path on E2B and Daytona. |
| `Authentication is required for <provider>. Start a foreground task run once to finish <provider> sign-in.` | The saved default is an OAuth or native sign-in that has not finished. Run once without `--detach`, or switch to an API key. |
| `First-run authentication for pi is not available inside a Workbench run yet` | Connect the key first with `wb connect <alias> --runtime <runtime> --stdin`, or pass an env key. |
| `DAYTONA_API_KEY is required for the Daytona runtime...` / `E2B_API_KEY is required...` | Set the variable or have the person run `wb connect --runtime daytona` (or `e2b`). |
| `Model metadata is not cached. Run the command again while connected to the internet.` | The catalog was never fetched; go online once. |
| `Missing required environment variable: NAME` | The Workbench declares `NAME` as required. Provide it by env or `--env-file`. |

Never read or print a key to check for it. Test by name: `test -n "$ANTHROPIC_API_KEY" && echo set`.
