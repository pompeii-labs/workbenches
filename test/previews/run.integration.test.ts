import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { seedModelCatalogFixture } from '../model-catalog-fixture.js';

const projectDirectory = resolve(import.meta.dir, '..', '..');
const cliPath = join(projectDirectory, 'src', 'cli.ts');
const directories: string[] = [];
const serverPids: string[] = [];

afterEach(async () => {
    for (const pid of serverPids.splice(0)) {
        try {
            process.kill(Number(pid));
        } catch {}
    }
    await Promise.all(
        directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
});

async function temporaryDirectory(prefix: string): Promise<string> {
    const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
    directories.push(directory);
    return directory;
}

/**
 * What a runner's shell tool does for the agent: start a small HTTP server in
 * the background, wait for its port, and announce it with `wbx` from PATH.
 */
async function shellStep(directory: string): Promise<string> {
    const server = join(directory, 'server.ts');
    await writeFile(
        server,
        [
            'const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("demo") });',
            'await Bun.write(Bun.argv[2] + ".tmp", String(server.port));',
            'const { rename } = await import("node:fs/promises");',
            'await rename(Bun.argv[2] + ".tmp", Bun.argv[2]);',
            'setTimeout(() => process.exit(0), 30_000);',
            '',
        ].join('\n')
    );
    const script = join(directory, 'announce.sh');
    await writeFile(
        script,
        [
            '#!/bin/sh',
            'set -eu',
            'record=$WB_TEST_RECORD',
            `${JSON.stringify(process.execPath)} ${JSON.stringify(server)} "$record.port" >/dev/null 2>&1 &`,
            'echo $! >"$record.pid"',
            'while [ ! -s "$record.port" ]; do sleep 0.05; done',
            'command -v wbx >"$record.which"',
            'wbx preview "$(cat "$record.port")" --name demo >"$record.wbx" 2>&1',
            '',
        ].join('\n')
    );
    await chmod(script, 0o755);
    return script;
}

/** Fake native runners whose turn runs the shell step before replying. */
async function fakeRunners(script: string): Promise<string> {
    const bin = await temporaryDirectory('workbench-preview-bin-');
    const shell = `const shell = async () => { const child = Bun.spawn(["/bin/sh", ${JSON.stringify(script)}], { env: process.env, stdout: "ignore", stderr: "ignore" }); await child.exited; };`;
    const runners: Record<string, string[]> = {
        opencode: [
            'if (Bun.argv[2] === "--version") { console.log("1.18.30"); process.exit(0); }',
            'if (Bun.argv[2] !== "serve") process.exit(1);',
            'const encoder = new TextEncoder();',
            'const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();',
            'const emit = (type: string, properties: Record<string, unknown>) => {',
            '  const chunk = encoder.encode("data: " + JSON.stringify({ type, properties: { sessionID: "ses_fixture", ...properties } }) + "\\n\\n");',
            '  for (const client of clients) client.enqueue(chunk);',
            '};',
            'const finish = (id: string) => {',
            '  emit("message.updated", { info: { id: "assistant_" + id, role: "assistant", parentID: id } });',
            '  emit("message.part.updated", { part: { id: "part_" + id, messageID: "assistant_" + id, type: "text", text: "" } });',
            '  emit("message.part.delta", { messageID: "assistant_" + id, partID: "part_" + id, field: "text", delta: "preview ready" });',
            '  emit("message.part.updated", { part: { id: "finish_" + id, messageID: "assistant_" + id, type: "step-finish", reason: "stop", tokens: { total: 2, input: 1, output: 1, reasoning: 0 }, cost: 0 } });',
            '  emit("session.status", { status: { type: "idle" } });',
            '};',
            'const app = Bun.serve({',
            '  hostname: "127.0.0.1",',
            '  port: 0,',
            '  async fetch(request) {',
            '    const url = new URL(request.url);',
            '    if (url.pathname === "/event") {',
            '      let controller: ReadableStreamDefaultController<Uint8Array>;',
            '      const body = new ReadableStream<Uint8Array>({',
            '        start(value) { controller = value; clients.add(value); value.enqueue(encoder.encode(": connected\\n\\n")); },',
            '        cancel() { clients.delete(controller); },',
            '      });',
            '      return new Response(body, { headers: { "content-type": "text/event-stream" } });',
            '    }',
            '    if (url.pathname === "/session" && request.method === "POST") return Response.json({ id: "ses_fixture" });',
            '    if (url.pathname.startsWith("/session/") && request.method === "GET") return Response.json({ id: url.pathname.split("/").at(-1) });',
            '    if (url.pathname.endsWith("/prompt_async")) {',
            '      const input = await request.json() as { messageID: string };',
            '      emit("session.status", { status: { type: "busy" } });',
            '      void shell().then(() => finish(input.messageID));',
            '      return new Response(null, { status: 204 });',
            '    }',
            '    if (url.pathname.endsWith("/abort")) return Response.json(true);',
            '    return new Response(null, { status: 404 });',
            '  },',
            '});',
            'process.stdout.write("opencode server listening on http://127.0.0.1:" + app.port + "\\n");',
            'const shutdown = () => { for (const client of clients) client.close(); app.stop(true); process.exit(0); };',
            'process.on("SIGTERM", shutdown);',
            'process.on("SIGINT", shutdown);',
        ],
        pi: [
            'const args = Bun.argv.slice(2);',
            'if (args[0] === "--version") { console.log("0.84.3"); process.exit(0); }',
            'if (args.includes("--list-models")) { process.stderr.write("provider  model\\nopenrouter  openai/gpt-5.6-terra\\n"); process.exit(0); }',
            'const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\\n");',
            'const decoder = new TextDecoder();',
            'let pending = "";',
            'for await (const chunk of Bun.stdin.stream()) {',
            '  pending += decoder.decode(chunk, { stream: true });',
            '  const lines = pending.split("\\n");',
            '  pending = lines.pop() ?? "";',
            '  for (const line of lines) {',
            '    if (!line.trim()) continue;',
            '    const command = JSON.parse(line);',
            '    emit({ id: command.id, type: "response", command: command.type, success: true, ...(command.type === "get_state" ? { data: { sessionId: "pi_fixture" } } : {}) });',
            '    if (command.type !== "prompt") continue;',
            '    await shell();',
            '    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "preview ready" } });',
            '    emit({ type: "turn_end", message: { stopReason: "completed" } });',
            '    emit({ type: "agent_end", messages: [] });',
            '  }',
            '}',
        ],
        claude: [
            'const args = Bun.argv.slice(2);',
            'const signedIn = process.env.CLAUDE_CODE_OAUTH_TOKEN === "fixture-subscription-token";',
            'if (args[0] === "--version") { console.log("2.1.292 (Claude Code)"); process.exit(0); }',
            'if (args[0] === "auth") { console.log(JSON.stringify(signedIn ? { loggedIn: true, authMethod: "oauth_token" } : { loggedIn: false })); process.exit(signedIn ? 0 : 1); }',
            'const session = args[args.indexOf("--session-id") + 1] ?? "fixture-session";',
            'const emit = (value: Record<string, unknown>) => process.stdout.write(JSON.stringify({ session_id: session, ...value }) + "\\n");',
            'const decoder = new TextDecoder();',
            'let pending = "";',
            'for await (const chunk of Bun.stdin.stream()) {',
            '  pending += decoder.decode(chunk, { stream: true });',
            '  const lines = pending.split("\\n");',
            '  pending = lines.pop() ?? "";',
            '  for (const line of lines) {',
            '    const message = line.trim() ? JSON.parse(line) : undefined;',
            '    if (message?.type !== "user") continue;',
            '    emit({ type: "command_lifecycle", command_uuid: message.uuid, state: "started" });',
            '    emit({ type: "system", subtype: "init" });',
            '    await shell();',
            '    emit({ type: "assistant", parent_tool_use_id: null, message: { id: "msg_fixture", role: "assistant", content: [{ type: "text", text: "preview ready" }] } });',
            '    emit({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", result: "preview ready", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 });',
            '    emit({ type: "command_lifecycle", command_uuid: message.uuid, state: "completed" });',
            '  }',
            '}',
        ],
    };
    for (const [name, body] of Object.entries(runners)) {
        const path = join(bin, name);
        await writeFile(path, ['#!/usr/bin/env bun', shell, ...body, ''].join('\n'));
        await chmod(path, 0o755);
    }
    return bin;
}

async function packageFor(
    root: string,
    runner: string,
    model: string
): Promise<string> {
    const directory = join(root, '.workbenches', 'core');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'instructions.md'), '# Instructions\n');
    await writeFile(
        join(directory, 'workbench.yml'),
        [
            'spec: 0',
            'version: 0.1.0',
            'name: preview-fixture',
            `runner: ${runner}`,
            'model:',
            `  id: ${model}`,
            'instructions: ./instructions.md',
            'skills: []',
            'tools: []',
            'mcps: []',
            'env: {}',
            'runtime: local',
            '',
        ].join('\n')
    );
    return directory;
}

async function cli(
    args: string[],
    environment: Record<string, string | undefined>,
    cwd: string
) {
    const child = Bun.spawn([process.execPath, cliPath, ...args], {
        cwd,
        env: environment,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    return { stdout, stderr, code };
}

const cases = [
    { runner: 'opencode', model: 'openai/gpt-5.6-terra', claude: false },
    { runner: 'pi', model: 'openai/gpt-5.6-terra', claude: false },
    { runner: 'claude-code', model: 'anthropic/claude-sonnet-4-5', claude: true },
];

describe('live previews on the local runtime', () => {
    setDefaultTimeout(30_000);

    for (const { runner, model, claude } of cases) {
        test(`${runner} announces a preview with wbx and wb run reports it`, async () => {
            const root = await temporaryDirectory('workbench-preview-run-');
            const home = join(root, 'workbench-home');
            const userHome = join(root, 'user-home');
            await mkdir(userHome, { recursive: true });
            await seedModelCatalogFixture(home);
            const record = join(root, 'shell');
            const bin = await fakeRunners(await shellStep(root));
            const packageDirectory = await packageFor(root, runner, model);
            const environmentFile = join(root, 'runner.env');
            await writeFile(
                environmentFile,
                'CLAUDE_CODE_OAUTH_TOKEN=fixture-subscription-token\n'
            );
            const environment = {
                PATH: `${bin}:${process.env.PATH ?? ''}`,
                HOME: userHome,
                XDG_DATA_HOME: join(userHome, '.local', 'share'),
                PI_CODING_AGENT_DIR: join(userHome, '.pi', 'agent'),
                WORKBENCH_HOME: home,
                WB_TEST_RECORD: record,
                NO_COLOR: '1',
                FORCE_COLOR: '0',
                ...(claude ? {} : { OPENROUTER_API_KEY: 'fixture-openrouter-key' }),
            };
            expect(
                (
                    await cli(
                        ['add', packageDirectory, '--as', 'preview'],
                        environment,
                        root
                    )
                ).code
            ).toBe(0);

            const ran = await cli(
                [
                    'run',
                    'preview',
                    '--task',
                    'Start the demo server and show it to me',
                    '--json',
                    ...(claude ? ['--env-file', environmentFile] : []),
                ],
                environment,
                root
            );
            const pid = await readFile(`${record}.pid`, 'utf8').catch(() => '');
            if (pid.trim()) serverPids.push(pid.trim());
            expect({ code: ran.code, stderr: ran.stderr }).toEqual({
                code: 0,
                stderr: '',
            });
            const port = Number(await readFile(`${record}.port`, 'utf8'));
            expect(await readFile(`${record}.wbx`, 'utf8')).toBe(
                `wbx: announced preview demo on port ${port}\n`
            );
            const events = ran.stdout
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line));
            const previews = events.filter(
                (event) => event.type === 'preview.available'
            );
            expect(previews).toHaveLength(1);
            expect(previews[0].data).toEqual({
                name: 'demo',
                port,
                protocol: 'http',
                url: `http://127.0.0.1:${port}/`,
            });
            expect(events.at(-1)?.type).toBe('run.completed');
            const helper = (await readFile(`${record}.which`, 'utf8')).trim();
            expect(helper).toStartWith(join(home, 'files', 'work'));
            expect(helper).toEndWith('/bin/wbx');
            // The helper exists only for the run's lifetime.
            expect(await Bun.file(helper).exists()).toBeFalse();

            const attached = await cli(
                ['attach', previews[0].run_id],
                environment,
                root
            );
            expect(attached.code).toBe(0);
            expect(attached.stdout).toContain(
                `Live preview: demo at http://127.0.0.1:${port}/`
            );
        });
    }
});
