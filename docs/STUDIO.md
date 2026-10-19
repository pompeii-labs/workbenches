# Local Studio API

The Workbench Studio API is a local control surface for the separately distributed dashboard. `wb studio` publishes the dashboard at `127.0.0.1:9292` and binds the API at `127.0.0.1:9293`. Use `--port` and `--api-port` to override them. Startup fails without launching the API or container if either selected port is busy. It reads records from `$WORKBENCH_HOME/wb.db`, keeps its runtime state in the owner-only file `$WORKBENCH_HOME/studio/state.json`, which `wb studio stop` removes, and makes no request to workbenches.dev.

Projects are created explicitly with `wb project create <name>`. A project is a row in the local `wb.db` with a name and a slug; it can span any number of directories and works the same with or without `wb login`. `wb run --project <name-or-slug>` resolves an existing project case-insensitively and never creates one. Only sessions started with a project appear as tasks. A resumed or continued session retains its original project. Runtime names map to the `local`, `docker`, `e2b`, or `daytona` source.

## Connect an agent

Expose the local project and run tools to Claude Code:

```sh
claude mcp add wb -- wb mcp
```

Other MCP clients can use the equivalent stdio configuration:

```json
{
  "mcpServers": {
    "wb": {
      "command": "wb",
      "args": ["mcp"]
    }
  }
}
```

The server provides `search`, `view`, `run`, `wait`, `send`, `answer`, `cancel`, `runs`, `sessions`, `push`, `projects`, `create_project`, and `tasks`. `search` always includes saved Workbenches and adds registry results when the CLI already has a registry login. `run` starts a detached local run from a saved Workbench alias and accepts `project`, `dir`, and `runtime` to select a declared `local`, `docker`, `e2b`, or `daytona` runtime. `push` never starts a login flow. `wb mcp` runs, supervises, and lists local work and local projects only; for cloud work, connect agents to `mcp.workbenches.dev`.

Find a saved or published Workbench with `search`, inspect it with `view`, then start it with `run`. Work the loop: `run`, then `wait`, then `send` or `answer`, then `wait` again. `wait` returns early with a cursor when a turn ends, something needs input, or its timeout reaches 60 seconds. A run that is still going is normal. Call `wait` again with the returned `next` until the state is `completed`, `failed`, or `cancelled`. When a run asks a question or permission, reply with `answer` and the request id. Use `cancel` to stop one.

## Opening the studio

The browser gate is not authentication; it only proves the browser is the one `wb studio` opened.

The dashboard only serves a browser that holds its access cookie, `wb_studio_access`, so a Docker-sandboxed run or another local user that reaches the published port cannot drive local sessions. Every `wb studio`, including one run while Studio is already up, mints a fresh open code from the stored API token and opens the browser at the open link `http://127.0.0.1:<port>/open?code=<open code>`. Running it again never restarts the container. The open code is `v1.<expiry>.<nonce>.<sig>`: the expiry is five minutes out, the nonce is 16 random bytes, and the signature is HMAC-SHA256 over `v1.<expiry>.<nonce>` with a key that is HMAC-SHA256 of the token over `wb studio open v1`. The container accepts each open code once, before it expires, then sets an `HttpOnly`, `SameSite=Strict` access cookie holding an access key it generates at each start and keeps only in memory. A link that was already used shows a page saying so and asking you to run `wb studio` again. Restarting the container drops the access key, so every browser needs a new open link.

The open code never appears in a process argument, where other local users could read it with `ps` or `/proc`. Instead `wb studio` writes a handoff page to `$WORKBENCH_HOME/studio/studio-open-<random>.html`, created as a new file with mode 0600 in a 0700 directory so only you can read it, and passes that file path to `open` or `xdg-open`. The page redirects to the open link without sending a referrer and links to it as a fallback. Its open code expires in five minutes. Each `wb studio` deletes earlier handoff pages before writing a new one, and `wb studio stop` deletes them all. The page is left in place after opening because the browser reads it asynchronously.

The terminal and `--json` always show the plain dashboard URL. Only when the browser is not opened (`--no-open`) or opening fails do they also show the open link, marked as working once within 5 minutes, and `--json` includes it as `open_url`. `--no-open` writes no handoff page, and a failed open deletes its page. Apart from the handoff page, the open code is never written to a file, log, or state.

Cookies ignore ports, so the browser also sends the access cookie to other servers on `127.0.0.1` and `localhost`. A local attacker who gets the browser to visit their own port can read it. Stopping or restarting Studio revokes it.

## Container

The default image is `ghcr.io/pompeii-labs/workbenches/studio:0.2.0@sha256:9f470434880319cab6944fa0e51e6db6456aa8c92363f948b4cb821af3531b33`, pinned by digest; `--image` selects another. Before anything starts, `wb studio` checks Docker with `docker info`: a daemon that is not running fails with "Docker isn't running. Start Docker and run wb studio again.", and Docker Desktop in Windows containers mode fails with a request to switch to Linux containers. When the image is not present locally, `wb studio` pulls it. It then resolves the image to its immutable ID with `docker image inspect` and runs that ID, so a tag repointed between the check and the run cannot swap the image. The image must carry the `dev.workbenches.studio.contract` label value this version of wb expects; an image built for another version, or without the label, is refused before the API or container starts. `wb studio --json` and `wb studio status --json` report the requested reference as `image` and the running ID as `image_id`.

The container runs with `--read-only`, `--tmpfs /tmp`, `--cap-drop ALL`, and `--security-opt no-new-privileges` on every platform.

On macOS and Windows the container runs on its own bridge network, `workbench-studio`, labelled `dev.workbenches.studio=1`. Studio creates the network before `docker run` when it is missing, refuses a network of that name without the label, and removes it on `wb studio stop` unless another container still uses it. The container publishes the dashboard on `127.0.0.1:<port>` and reaches the API at `host.docker.internal:<api-port>`. On Linux the container runs with `--network host`, binds the dashboard to `127.0.0.1:<port>`, and reaches the API at `127.0.0.1:<api-port>`, because Docker Engine's host gateway cannot reach a loopback-only API.

## API authorization

Every request requires the bearer token provisioned to the dashboard container. Requests are rejected unless `Host` is `127.0.0.1:<api-port>`, `localhost:<api-port>`, or `host.docker.internal:<api-port>`. Authentication failures use status 401, Host failures use status 403, and both return `{ "error": { "code", "message" } }`. An unknown run, including on a WebSocket upgrade, returns status 404 with the same body.

## Routes

All routes are beneath `/v1` and JSON fields use snake case.

| Method | Path | Result |
| --- | --- | --- |
| GET | `/status` | Engine version |
| GET | `/projects` | Project summaries by newest activity, including empty projects last |
| GET | `/tasks?project=<name>` | Tracked tasks, newest first |
| GET | `/tasks/:id` | One task and its runs, oldest run first |
| GET | `/runs/:id` | One run |
| GET | `/runs/:id/events?after=<seq>&limit=<n>` | Exact normalized protocol 0 events; limit defaults to 100 and must be 1 to 500 |
| WS | `/runs/:id/events?after=<seq>` | Replay followed by live normalized events; closes normally after a terminal event |
| POST | `/runs/:id/commands` | Submit `send`, `steer`, `queue`, `answer`, or `cancel`; repeated idempotency keys return the original result while the API server runs |
| GET | `/runs/:id/outcome/files` | Outcome artifact metadata |
| GET | `/runs/:id/outcome/files/<path>` | Original artifact bytes. A file is served inline only when its declared media type parses as exactly PNG, JPEG, GIF, WebP, AVIF, video, audio, PDF, or plain text, optionally followed by `; charset=<name>`, and Studio sends the lowercased type rather than the declared string. Any other parameter, a comma, or an unparseable type is `application/octet-stream` with `Content-Disposition: attachment`. Always `nosniff` with `Content-Security-Policy: sandbox; default-src 'none'` |
| WS | `/live` | Initial status, then changed task and project summaries |

Command requests have `{ "kind", "payload", "idempotency_key" }`. Text commands use `{ "text" }`; answers use `{ "request_id", "response" }`, where `response` is a string or an array of string arrays; cancellation uses an empty object. The response is HTTP 202 with `{ "command": { "id", "status", "message" } }`. Commands use the same session control operations as `wb send`, `wb answer`, and `wb kill`.

The API does not poll SQLite. The server owns `$WORKBENCH_HOME/studio.sock`; local run writers send a best-effort wake containing only the run ID, and the server pushes the changed events, task, and project to connected clients.
