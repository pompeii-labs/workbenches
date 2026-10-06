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

- `local`: the runner's own sign-in on the host (`opencode auth login`, or `pi` with `/login`). `wb connect` checks it but never writes it.
- `docker`: a per-runner volume, written by `wb connect <alias> --runtime docker` through the Workbench image.
- `e2b`: a store under `~/.workbench/runtime-credentials/e2b/`, written by `wb connect` and synced into each sandbox.
- `daytona`: no store. Environment keys only, so `wb connect` only checks that the provider variable is set.

## wb connect

`wb connect <alias> --runtime <runtime>` saves one default per runner and runtime (the provider and the sign-in method: `api-key`, `chatgpt` for an OpenAI subscription, or the provider's native sign-in), writes the provider credential into that runtime's store, and checks it. The default is reused by every compatible Workbench on that runner and runtime. Without a Workbench, use `--runtime`, `--harness`, and `--provider` (and `--method` when the provider has several); `docker` always needs a Workbench, because its volume is written through the Workbench image.

Where the credential comes from, in order:

1. `--stdin`: an API key on standard input. The only unattended way to give a new key. Never put a key in argv.
2. The person's own local runner sign-in for that provider. A terminal asks `Use your local <Provider> credential in <runtime>? [Y/n]`; unattended, it is copied only with `--yes`. Only that provider's entry is copied.
3. A subscription or native sign-in: `opencode auth login` runs on the host against a private temporary directory. It needs a person at a terminal. Pi has no command-line sign-in: the person signs in with `pi` (`/login`) locally, then `wb connect ... --yes` copies it.
4. A masked API-key prompt in a terminal.

The last line is `Ready: <Provider> for <Runner> in <runtime>` after the runner itself listed the credential, or `Saved: ...` for `e2b`, where checking would create a billable sandbox and the first run confirms it. Anything else exits 3 with the missing piece and the command that fixes it. Piped output is `ready`, `saved`, `removed`, or `absent`, then runtime, runner, and provider, tab separated.

`wb connect --runtime e2b --harness opencode --provider openrouter --remove` removes that provider's entry from that store and keeps the others (`docker` needs the Workbench reference). Plain `wb connect --runtime e2b --remove` still removes the saved E2B key.

An environment variable for the provider, or `--env-file`, always wins over a stored entry and works for one run without connecting.

## Errors and fixes

| Error | Fix |
| --- | --- |
| `No authenticated route is available for <model>. Run wb connect <ref> --runtime <runtime>, or pass the provider key for one run with --env-file.` | Run `wb view <ref>` to see allowed routes. Pass one provider's key with `--env-file` (or the environment of `wb`), or run the exact `wb connect` command shown, which fills that runtime's store. Exit code 3. |
| `Connection X is not authenticated for <model> with <runner> in the <runtime> runtime. Run wb connect ...` | The `--connection` provider has no credential in this runtime. Drop the flag, supply that provider's key, or connect it for that runtime. |
| `wb connect` exits 3 with `Pass the <Provider> API key on standard input: ...` | No key was given and no terminal is attached. Pipe the key with `--stdin`, or have the person run the command in a terminal. |
| `wb connect` exits 3 with `Copy your local <Runner> <Provider> credential with ... --yes` | The person's own sign-in has that provider. Add `--yes` only if they agree to copy it into the runtime. |
| `Docker keeps <Runner> credentials in a volume that is written and checked through a Workbench image` | Rerun with a Workbench reference: `wb connect <alias> --runtime docker`. |
| `Daytona has no runner credential store...` | Set the provider variable where `wb` runs, or pass `--env-file` on each run. |
| `Authentication is required for <provider>. Start this Workbench interactively once to finish <provider> sign-in.` | The saved default is an OAuth or native sign-in that has not finished. Run once without `--detach`, or switch to an API key. |
| `First-run authentication for pi is not available inside a Workbench run yet` | Connect the key first with `wb connect <alias> --runtime <runtime> --stdin`, or pass an env key. |
| `DAYTONA_API_KEY is required for the Daytona runtime...` / `E2B_API_KEY is required...` | Set the variable or have the person run `wb connect --runtime daytona` (or `e2b`). |
| `Model metadata is not cached. Run the command again while connected to the internet.` | The catalog was never fetched; go online once. |
| `Missing required environment variable: NAME` | The Workbench declares `NAME` as required. Provide it by env or `--env-file`. |

Never read or print a key to check for it. Test by name: `test -n "$ANTHROPIC_API_KEY" && echo set`.
