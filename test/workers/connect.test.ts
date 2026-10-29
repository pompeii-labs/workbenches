import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { ServerWebSocket } from 'bun';

import { RunnerRegistry } from '../../src/runners/registry.js';
import { WorkerApi } from '../../src/workers/api.js';
import {
    WorkerConnect,
    type WorkerConnectTerminal,
} from '../../src/workers/connect.js';
import { WorkerDaemon } from '../../src/workers/daemon.js';
import { WorkerRunEnvironment } from '../../src/workers/environment.js';
import { WorkerHome } from '../../src/workers/home.js';
import { WorkerLog } from '../../src/workers/log.js';
import { WorkerSignIns } from '../../src/workers/signin.js';
import { seedModelCatalogFixture } from '../model-catalog-fixture.js';
import { FakeRunHost, FakeWorkerServer, WORKER_KEY } from './fixture.js';

setDefaultTimeout(30_000);

const TOKEN = 'sk-ant-oat01-member-subscription-token';
const KEY = 'sk-or-MUST_NOT_RENDER_MEMBER_KEY';
const LOGIN_KEY = 'wbcli_placeholder_login_key';
const CLI = resolve(import.meta.dir, '..', '..', 'src', 'cli.ts');

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * A fake `claude auth login`, the way Claude Code signs in on a machine the
 * browser cannot call back to: it turns on bracketed paste, prints the link
 * as a terminal hyperlink, reads the code the browser shows from its
 * terminal, saves the login in its credential store, its home's unless
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR` names one, and turns bracketed paste off
 * as its very last output.
 */
const FAKE_CLAUDE = [
    '#!/bin/sh',
    '[ "$*" = "auth login --claudeai" ] || exit 2',
    'printf "\\033[?2004h"',
    'printf "\\033]8;id=1;https://claude.example/oauth/authorize?code=true\\007https://claude.example/oauth/authorize?code=true\\033]8;;\\007\\r\\n"',
    'printf "Paste code here if prompted > "',
    'read code',
    '[ "$code" = "code-123" ] || exit 3',
    'store="$HOME/.claude"',
    'if [ -n "$CLAUDE_SECURESTORAGE_CONFIG_DIR" ]; then store="$CLAUDE_SECURESTORAGE_CONFIG_DIR"; fi',
    'mkdir -p "$store"',
    `printf '{"claudeAiOauth":{"accessToken":"${TOKEN}"}}' > "$store/.credentials.json"`,
    'printf "\\r\\nLogin successful\\r\\n\\033[?2004l"',
].join('\n');

/**
 * A fake `opencode auth login` that records its arguments in its home. The
 * ChatGPT device sign-in prints its link and code, spins while it waits, and
 * saves its login in the data home once the person approves, with no key
 * pressed. Anthropic asks how to sign in with a menu and records the keys,
 * and OpenCode's own provider fails.
 */
const FAKE_OPENCODE = [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then echo "1.18.34"; exit 0; fi',
    '[ "$1 $2" = "auth login" ] || exit 2',
    'printf "%s\\n" "$@" > "$HOME/opencode-args"',
    'if [ "$4" = "opencode" ]; then printf "Sign-in failed\\r\\n"; exit 4; fi',
    'if [ "$4" = "anthropic" ]; then',
    '  stty raw -echo',
    '  printf "Login method\\r\\n> Claude Pro/Max\\r\\n  API key\\r\\n"',
    '  keys=$(dd bs=4 count=1 2>/dev/null); stty sane',
    '  printf "%s" "$keys" > "$HOME/picked"; exit 0',
    'fi',
    'printf "●  Go to: https://auth.example/codex/device\\r\\n●  Enter code: ABCD-1234\\r\\n"',
    'i=0; while [ $i -lt 10 ]; do printf "\\033[999D\\033[J◐  Waiting for authorization"; sleep 0.05; i=$((i+1)); done',
    'mkdir -p "$XDG_DATA_HOME/opencode"',
    'printf "{}" > "$XDG_DATA_HOME/opencode/auth.json"',
].join('\n');

/** OpenCode 2, which keeps its login in its database and exports it on request. */
const FAKE_OPENCODE_V2 = [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then echo "opencode v2.2.2"; exit 0; fi',
    'if [ "$1 $2 $3" = "auth export openai" ]; then',
    '  [ -f "$OPENCODE_DB" ] || exit 5',
    `  printf '%s' '[{"integrationID":"openai","active":true,"value":{"type":"oauth","access":"access-1","refresh":"refresh-1","expires":1,"metadata":{"accountID":"acct-1"}}}]'`,
    '  exit 0',
    'fi',
    '[ "$1 $2" = "auth login" ] || exit 2',
    'mkdir -p "$(dirname "$OPENCODE_DB")"',
    'printf "login" > "$OPENCODE_DB"',
].join('\n');

/** The person's terminal, scripted: what it shows, what is typed when, and the secrets asked for. */
class ScriptedTerminal implements WorkerConnectTerminal {
    screen = '';
    readonly asked: string[] = [];
    readonly #typed = new Set<string>();
    #input: ((data: Uint8Array) => void) | undefined;

    constructor(
        /** Keys to type once the screen shows each text, once each. */
        private readonly keys: Array<[string, string]> = [],
        private readonly answer: (message: string) => string | undefined = () =>
            undefined
    ) {}

    size() {
        return { cols: 120, rows: 40 };
    }

    attach(input: (data: Uint8Array) => void) {
        this.#input = input;
        this.#type();
        return () => {
            this.#input = undefined;
        };
    }

    write(data: Uint8Array) {
        this.screen += new TextDecoder().decode(data);
        this.#type();
    }

    async secret(message: string) {
        this.asked.push(message);
        return this.answer(message);
    }

    #type() {
        for (const [when, keys] of this.keys) {
            if (this.#typed.has(when) || !this.#input) continue;
            if (!plain(this.screen).includes(when)) continue;
            this.#typed.add(when);
            this.#input(new TextEncoder().encode(keys));
        }
    }
}

/**
 * A worker daemon with real sign-ins in real terminals, against a stand-in
 * site that relays between the person's CLI and the worker as
 * workbenches.dev does: the connection request becomes `connect.start`, the
 * person's terminal attaching becomes `connect.attach`, and the sign-in's
 * terminal and the person's keys and secrets pass through as they are.
 */
async function relay(opencode = FAKE_OPENCODE) {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-worker-connect-'));
    // Installed outside the temporary directories, which a sandboxed sign-in
    // on Linux sees as empty ones of its own, as runner CLIs are.
    const bin = await mkdtemp(join(process.cwd(), '.connect-runners-'));
    cleanups.push(() => rm(bin, { recursive: true, force: true }));
    await writeFile(join(bin, 'claude'), `${FAKE_CLAUDE}\n`, { mode: 0o755 });
    await writeFile(join(bin, 'opencode'), `${opencode}\n`, { mode: 0o755 });
    const path = `${bin}:/usr/bin:/bin`;
    const server = new FakeWorkerServer();
    const starts: Array<Record<string, unknown>> = [];
    /** Everything the stand-in site passed to and from the person's terminal. */
    const relayed: string[] = [];
    /** Whose machine the site says the worker is, when it is not the person's own. */
    const machine: { owner: string | null } = { owner: null };
    let terminal: ServerWebSocket<unknown> | undefined;
    let ended = false;
    const body = async (request: Request): Promise<Record<string, unknown>> => {
        const value: unknown = await request.json();
        return typeof value === 'object' && value !== null
            ? Object.fromEntries(Object.entries(value))
            : {};
    };
    server.routes.set('POST /v1/workers/mini/connections', async (request) => {
        const { runner, provider, method } = await body(request);
        const start = {
            type: 'connect.start',
            connect_id: 'con_1',
            member_id: 'mem_1',
            member_name: 'matty',
            runner,
            provider,
            method,
        };
        starts.push(start);
        server.send(start);
        return Response.json({ id: 'con_1', owner: machine.owner }, { status: 201 });
    });
    server.terminals = {
        opened: (socket) => {
            terminal = socket;
            const size = socket.data.terminal;
            server.send({
                type: 'connect.attach',
                connect_id: 'con_1',
                cols: size?.cols,
                rows: size?.rows,
            });
        },
        message: (_socket, message) => {
            relayed.push(JSON.stringify(message));
            if (message.type === 'input')
                server.send({
                    type: 'connect.input',
                    connect_id: 'con_1',
                    data: message.data,
                });
            if (message.type === 'resize')
                server.send({
                    ...message,
                    type: 'connect.resize',
                    connect_id: 'con_1',
                });
            if (message.type === 'secret')
                server.send({
                    type: 'connect.secret',
                    connect_id: 'con_1',
                    text: message.text,
                });
        },
        closed: () => {
            if (!ended) server.send({ type: 'connect.cancel', connect_id: 'con_1' });
        },
        worker: (message) => {
            if (message.connect_id !== 'con_1' || !terminal) return;
            const reply = (frame: Record<string, unknown>) => {
                relayed.push(JSON.stringify(frame));
                terminal?.send(JSON.stringify(frame));
            };
            if (message.type === 'connect.output')
                reply({ type: 'output', data: message.data });
            else if (message.type === 'connect.update' && message.state === 'secret')
                reply({ type: 'secret', message: message.message });
            else if (message.type === 'connect.update') {
                ended = true;
                reply({ type: 'end', state: message.state, message: message.message });
                terminal.close(1000, 'The sign-in ended');
            }
        },
    };
    const home = new WorkerHome(directory);
    const registration = {
        version: 1 as const,
        id: 'wrk_1',
        slug: 'mini',
        name: 'mini',
        organization: 'acme',
        key: WORKER_KEY,
        api_url: server.url,
        registered_at: new Date().toISOString(),
    };
    await home.saveRegistration(registration);
    const runners = RunnerRegistry.standard();
    const log = new WorkerLog(home, 'mini');
    const daemon = new WorkerDaemon({
        home,
        registration,
        settings: { runtimes: ['docker'], slots: 1 },
        host: new FakeRunHost(),
        api: new WorkerApi(server.url),
        machine: {
            describe: async () => ({
                os: 'linux',
                arch: 'x64',
                cpus: 8,
                memory_gb: 16,
                gpus: [],
                docker: null,
                runners: [],
            }),
        },
        log,
        version: '1.4.0',
        tickMilliseconds: 10,
        backoff: () => 20,
        signIns: (send) =>
            new WorkerSignIns({
                home,
                runners,
                environment: new WorkerRunEnvironment(home, runners, {
                    PATH: path,
                    HOME: join(directory, 'account'),
                    CLAUDE_CODE_OAUTH_TOKEN: 'MUST_NOT_RENDER_ACCOUNT_TOKEN',
                }),
                log,
                send,
                which: (name) => Bun.which(name, { PATH: path }),
            }),
    });
    const running = daemon.run();
    cleanups.push(async () => {
        daemon.terminate();
        await running;
        server.stop();
        await rm(directory, { recursive: true, force: true });
    });
    await server.next((message) => message.type === 'hello');
    /** Connects as `wb connect --worker` does, with what the person picked, typed, and pasted. */
    const connect = (
        choice: { runner: string; provider: string; method: string },
        terminal = new ScriptedTerminal()
    ) =>
        new WorkerConnect({
            api: new WorkerApi(server.url),
            login: LOGIN_KEY,
            worker: 'mini',
            ...choice,
            terminal,
        }).run();
    const refusal = (choice: { runner: string; provider: string; method: string }) =>
        connect(choice).then(
            () => 'connected',
            (error: Error) => error.message
        );
    return { directory, server, home, log, starts, relayed, machine, connect, refusal };
}

/** Every file under `directory` except the member connections, which hold the secrets. */
async function everyFile(directory: string): Promise<string> {
    const contents: string[] = [];
    for (const entry of await readdir(directory, {
        recursive: true,
        withFileTypes: true,
    }))
        if (entry.isFile() && entry.name !== 'connections.json')
            // A temporary file the worker renames into place can go between the listing and the read.
            contents.push(
                await readFile(join(entry.parentPath, entry.name), 'utf8').catch(
                    (error: NodeJS.ErrnoException) => {
                        if (error.code === 'ENOENT') return '';
                        throw error;
                    }
                )
            );
    return contents.join('\n');
}

describe('wb connect --worker', () => {
    test("shows the sign-in's own terminal, types the person's keys into it, and leaves the login in their home on the worker", async () => {
        const { server, home, log, starts, connect } = await relay();
        const terminal = new ScriptedTerminal([['Paste code here', 'code-123\r']]);
        const result = await connect(
            { runner: 'claude-code', provider: 'anthropic', method: 'native' },
            terminal
        );

        expect(starts).toEqual([
            expect.objectContaining({
                runner: 'claude-code',
                provider: 'anthropic',
                method: 'native',
            }),
        ]);
        // The screen is the sign-in's, hyperlink and all, as it would be on this machine.
        expect(terminal.screen).toContain(
            '\u001b]8;id=1;https://claude.example/oauth/authorize?code=true\u0007'
        );
        expect(plain(terminal.screen)).toContain('Login successful');
        // Its last output, which puts the person's terminal back, arrives before the end.
        expect(terminal.screen.endsWith('\u001b[?2004l')).toBe(true);
        expect(terminal.asked).toEqual([]);
        expect(result).toEqual({ message: 'Signed in to Claude Code on this worker.' });

        // Claude Code kept its login in the member's sign-ins, where their
        // local and docker runs read and renew it, never in the account's own
        // store; the worker records only which login it is.
        const member = home.memberDirectory('mem_1');
        expect(
            await readFile(
                join(member, '.local', 'share', 'claude', '.credentials.json'),
                'utf8'
            )
        ).toContain(TOKEN);
        expect(await home.readMemberConnection('mem_1', 'claude-code')).toEqual({
            provider: 'anthropic',
            method: 'native',
        });
        expect((await stat(join(member, 'connections.json'))).mode & 0o777).toBe(0o600);

        // The CLI's key reached only the site, and the worker owner's sign-in reached nothing.
        await log.flush();
        await server.next((message) =>
            JSON.stringify(message).includes('sign-in finished  claude-code')
        );
        expect(JSON.stringify(server.received)).not.toContain(LOGIN_KEY);
        expect(JSON.stringify(server.received)).not.toContain('MUST_NOT_RENDER');
        expect(server.logLines().join('\n')).not.toContain(TOKEN);
        expect(await everyFile(home.root)).not.toContain('MUST_NOT_RENDER');
    });

    test("says whose machine it is before signing in on someone else's worker", async () => {
        const notice =
            "mini is Ada's machine. Anyone who runs there can read what you sign in with.";
        const choice = {
            runner: 'claude-code',
            provider: 'anthropic',
            method: 'native',
        };
        const signIn = async (owner: string | null) => {
            const { machine, connect } = await relay();
            machine.owner = owner;
            const terminal = new ScriptedTerminal([['Paste code here', 'code-123\r']]);
            await connect(choice, terminal);
            return terminal.screen;
        };
        expect(await signIn(null)).not.toContain(notice);
        expect((await signIn('Ada')).startsWith(`${notice}\r\n`)).toBe(true);
    });

    test("runs the runner's own sign-in for the chosen provider and method in the member's home, and ends when it does", async () => {
        const { home, connect } = await relay();
        const terminal = new ScriptedTerminal();
        const result = await connect(
            { runner: 'opencode', provider: 'openai', method: 'chatgpt' },
            terminal
        );
        expect(result).toEqual({ message: 'Signed in to OpenCode on this worker.' });
        const member = home.memberDirectory('mem_1');
        // The browser sign-in returns to the worker's localhost, so its device-code form runs.
        expect(await readFile(join(member, 'opencode-args'), 'utf8')).toBe(
            [
                'auth',
                'login',
                '--provider',
                'openai',
                '--method',
                'ChatGPT Pro/Plus (headless)',
                '',
            ].join('\n')
        );
        // Its link, code, and spinner arrive as drawn, and nothing was asked of the person.
        expect(plain(terminal.screen)).toContain(
            '● Go to: https://auth.example/codex/device ● Enter code: ABCD-1234'
        );
        expect(terminal.screen).toContain(
            '\u001b[999D\u001b[J◐  Waiting for authorization'
        );
        expect(terminal.asked).toEqual([]);
        expect(
            await stat(join(member, '.local', 'share', 'opencode', 'auth.json'))
        ).toBeTruthy();
        expect(await home.readMemberConnection('mem_1', 'opencode')).toEqual({
            provider: 'openai',
            method: 'chatgpt',
        });
    });

    test("copies an OpenCode 2 login into the member's credential file, so any image's OpenCode reads it", async () => {
        const { home, connect } = await relay(FAKE_OPENCODE_V2);
        expect(
            await connect({ runner: 'opencode', provider: 'openai', method: 'chatgpt' })
        ).toEqual({ message: 'Signed in to OpenCode on this worker.' });
        const file = join(
            home.memberDirectory('mem_1'),
            '.local',
            'share',
            'opencode',
            'auth.json'
        );
        expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
            openai: {
                type: 'oauth',
                access: 'access-1',
                refresh: 'refresh-1',
                expires: 1,
                metadata: { accountID: 'acct-1' },
                accountId: 'acct-1',
            },
        });
        expect((await stat(file)).mode & 0o777).toBe(0o600);
    });

    test("passes the person's keys raw, so a sign-in's menu works as it does locally", async () => {
        const { home, connect } = await relay();
        const terminal = new ScriptedTerminal([['Login method', '\u001b[B\r']]);
        expect(
            await connect(
                { runner: 'opencode', provider: 'anthropic', method: 'native' },
                terminal
            )
        ).toEqual({ message: 'Signed in to OpenCode on this worker.' });
        expect(
            await readFile(join(home.memberDirectory('mem_1'), 'picked'), 'utf8')
        ).toBe('\u001b[B\r');
    });

    test('a sign-in that fails says so with its exit code, and saves nothing', async () => {
        const { home, refusal } = await relay();
        expect(
            await refusal({
                runner: 'opencode',
                provider: 'opencode',
                method: 'native',
            })
        ).toBe('OpenCode sign-in did not finish (exit 4).');
        expect(await home.readMemberConnection('mem_1', 'opencode')).toBeUndefined();
    });

    test('refuses what a worker cannot sign in to, and says why', async () => {
        const { home, refusal } = await relay();
        expect(
            await refusal({ runner: 'pi', provider: 'openai', method: 'chatgpt' })
        ).toBe(
            'Pi has no command-line sign-in, so a Pi subscription cannot be connected on a worker yet. An API key can be.'
        );
        // A method `wb connect` does not offer for `local` is not run at all.
        expect(
            await refusal({
                runner: 'claude-code',
                provider: 'anthropic',
                method: 'setup-token',
            })
        ).toBe('Claude Code has no setup-token method for Anthropic.');
        expect(await home.readMemberConnection('mem_1', 'pi')).toBeUndefined();
    });

    test('takes an API key for the provider variable and keeps it only on the worker', async () => {
        const { server, home, log, relayed, connect } = await relay();
        const terminal = new ScriptedTerminal([], () => KEY);
        const result = await connect(
            { runner: 'claude-code', provider: 'openrouter', method: 'api-key' },
            terminal
        );
        expect(terminal.asked).toEqual([
            'Paste your OpenRouter API key. Your Claude Code runs on this worker get it as OPENROUTER_API_KEY.',
        ]);
        expect(result).toEqual({
            message: 'Saved your OpenRouter API key for Claude Code on this worker.',
        });
        expect(await home.readMemberConnection('mem_1', 'claude-code')).toEqual({
            provider: 'openrouter',
            method: 'api-key',
            variable: 'OPENROUTER_API_KEY',
            secret: KEY,
        });
        const saved = join(home.memberDirectory('mem_1'), 'connections.json');
        expect((await stat(saved)).mode & 0o777).toBe(0o600);
        // Only the person's own secret frame carries it; the worker never sends it back.
        await log.flush();
        await server.next((message) =>
            JSON.stringify(message).includes('key saved  claude-code')
        );
        expect(relayed.filter((frame) => frame.includes(KEY))).toEqual([
            JSON.stringify({ type: 'secret', text: KEY }),
        ]);
        expect(server.logLines().join('\n')).not.toContain('MUST_NOT_RENDER');
        expect(JSON.stringify(server.received)).not.toContain('MUST_NOT_RENDER');
        expect(JSON.stringify(server.requests)).not.toContain('MUST_NOT_RENDER');
        expect(await everyFile(home.root)).not.toContain('MUST_NOT_RENDER');
    });

    test('refuses a paste of only whitespace and saves nothing', async () => {
        const { home, connect } = await relay();
        const ended = await connect(
            { runner: 'claude-code', provider: 'openrouter', method: 'api-key' },
            new ScriptedTerminal([], () => ' \n ')
        ).catch((error: Error) => error.message);
        expect(ended).toBe('Nothing was pasted, so nothing was saved.');
        expect(await home.readMemberConnection('mem_1', 'claude-code')).toBeUndefined();
    });

    test('cancels the sign-in on the worker when the person stops', async () => {
        const { server, home, connect } = await relay();
        const ended = await connect(
            { runner: 'claude-code', provider: 'openrouter', method: 'api-key' },
            new ScriptedTerminal([], () => undefined)
        ).catch((error: Error) => error.message);
        expect(ended).toBe('Connection setup cancelled');
        await server.next((message) =>
            JSON.stringify(message).includes('sign-in cancelled  claude-code')
        );
        expect(await home.readMemberConnection('mem_1', 'claude-code')).toBeUndefined();
    });

    test('asks the providers and methods plain wb connect asks for local, for every runner', async () => {
        const home = await cliHome();
        for (const [runner, provider] of [
            ['claude-code', 'anthropic'],
            ['opencode', 'openai'],
            ['pi', 'openai'],
        ] as const) {
            for (const flags of [
                ['--provider', 'no-such-provider'],
                ['--provider', provider, '--method', 'no-such-method'],
            ]) {
                const worker = await cli(home, [
                    'connect',
                    '--worker',
                    'mini',
                    runner,
                    ...flags,
                ]);
                const plain = await cli(home, [
                    'connect',
                    '--runtime',
                    'local',
                    '--harness',
                    runner,
                    ...flags,
                ]);
                expect(worker.code).toBe(1);
                expect(worker.stderr).toContain('Expected one of: ');
                expect(worker.stderr).toBe(plain.stderr);
            }
        }
    });

    test('the CLI puts the sign-in in this terminal, and reads a key hidden', async () => {
        const { server, home } = await relay();
        const cliHomeDirectory = await cliHome();
        await writeFile(
            join(cliHomeDirectory, 'credentials.json'),
            `${JSON.stringify({
                version: 2,
                registries: [
                    {
                        url: server.url,
                        defaultSlug: 'acme',
                        organizations: [
                            {
                                organizationId: 'org_1',
                                slug: 'acme',
                                name: 'Acme',
                                personal: false,
                                token: LOGIN_KEY,
                                keyId: 'key_1',
                                scopes: [],
                                expiresAt: '2999-01-01T00:00:00.000Z',
                            },
                        ],
                    },
                ],
            })}\n`,
            { mode: 0o600 }
        );
        const run = async (args: string[], keys: Array<[string, string]>) => {
            const decoder = new TextDecoder();
            let screen = '';
            const terminal = new Bun.Terminal({
                cols: 132,
                rows: 43,
                data: (_terminal, data) => {
                    screen += decoder.decode(data, { stream: true });
                },
            });
            const child = Bun.spawn(
                [
                    process.execPath,
                    CLI,
                    '--api-url',
                    server.url,
                    'connect',
                    '--worker',
                    'mini',
                    ...args,
                ],
                { env: cliEnvironment(cliHomeDirectory), terminal }
            );
            cleanups.push(() => {
                child.kill();
                terminal.close();
            });
            for (const [when, typed] of keys) {
                const deadline = Date.now() + 20_000;
                while (!plain(screen).includes(when) && Date.now() < deadline)
                    await Bun.sleep(50);
                terminal.write(typed);
                await Bun.sleep(200);
                terminal.write('\r');
            }
            return { code: await child.exited, screen };
        };

        const key = await run(
            ['claude-code', '--provider', 'openrouter', '--method', 'api-key'],
            [['input hidden', KEY]]
        );
        expect(key.code).toBe(0);
        expect(plain(key.screen)).toContain(
            'Paste your OpenRouter API key. Your Claude Code runs on this worker get it as OPENROUTER_API_KEY.'
        );
        expect(plain(key.screen)).toContain(
            'Saved your OpenRouter API key for Claude Code on this worker.'
        );
        // Typed, never echoed.
        expect(key.screen).not.toContain('MUST_NOT_RENDER');
        // Taking the terminal back for the key turns bracketed paste off, so the paste is just the key.
        expect(key.screen).toContain('\u001b[?2004l');
        expect(
            JSON.parse(
                server.requests.find(
                    (request) =>
                        request.method === 'POST' &&
                        request.path === '/v1/workers/mini/connections'
                )?.body ?? '{}'
            )
        ).toEqual({ runner: 'claude-code', provider: 'openrouter', method: 'api-key' });
        expect((await home.readMemberConnection('mem_1', 'claude-code'))?.secret).toBe(
            KEY
        );
        // The terminal opens at this terminal's size, as the person's key.
        expect(
            server.requests.find((request) => request.path.endsWith('/terminal'))
        ).toMatchObject({
            method: 'GET',
            path: '/v1/workers/mini/connections/con_1/terminal',
            authorization: `Bearer ${LOGIN_KEY}`,
        });
    });
});

/** A throwaway CLI home with the model catalog, so `wb connect` reads nothing of this machine. */
async function cliHome(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-connect-cli-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    await seedModelCatalogFixture(directory);
    return directory;
}

function cliEnvironment(home: string): Record<string, string | undefined> {
    return {
        PATH: process.env.PATH,
        HOME: home,
        WORKBENCH_HOME: home,
        NO_COLOR: '1',
        TERM: 'xterm-256color',
    };
}

async function cli(home: string, args: string[]) {
    const child = Bun.spawn([process.execPath, CLI, ...args], {
        env: cliEnvironment(home),
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const [stderr, code] = await Promise.all([
        new Response(child.stderr).text(),
        child.exited,
    ]);
    return { stderr, code };
}

function plain(screen: string): string {
    return stripVTControlCharacters(screen).replace(/\s+/g, ' ');
}
