import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerWebSocket } from 'bun';

import type { WorkbenchEvent, WorkbenchEventType } from '../../src/runs/events.js';
import type {
    WorkerAdmission,
    WorkerOutcome,
    WorkerRunContext,
    WorkerRunHost,
} from '../../src/workers/contracts.js';
import { WorkerRejection } from '../../src/workers/contracts.js';
import type { RunStart, WorkerCommand } from '../../src/workers/protocol.js';

export const WORKER_KEY = 'wbk_placeholder-worker-key';

type Message = Record<string, unknown> & { type: string };

interface Recorded {
    method: string;
    path: string;
    authorization: string | null;
    body: string;
}

/** A socket the fake site accepted: the worker's, or a member's terminal on a sign-in. */
interface SocketData {
    id: number;
    terminal?: { connectId: string; cols: number; rows: number };
}

/** What a test does with a member's terminal socket, as the site relays it. */
export interface FakeTerminalRelay {
    opened(socket: ServerWebSocket<SocketData>): void;
    message(socket: ServerWebSocket<SocketData>, message: Message): void;
    closed(socket: ServerWebSocket<SocketData>): void;
    /** A frame the worker sent, for the terminals it concerns. */
    worker(message: Message): void;
}

/**
 * A stand-in for workbenches.dev: the worker WebSocket, members' terminal
 * sockets, and the HTTP routes, scripted by each test. Every frame the
 * worker sends is recorded in order.
 */
export class FakeWorkerServer {
    readonly server: ReturnType<typeof Bun.serve<SocketData>>;
    readonly received: Array<Message & { connection: number }> = [];
    readonly requests: Recorded[] = [];
    readonly routes = new Map<
        string,
        (request: Request) => Response | Promise<Response>
    >();
    connections = 0;
    /** What the server answers `hello` with; return undefined to stay silent. */
    welcome: (hello: Message) => Message | undefined = () => ({
        type: 'welcome',
        worker: { id: 'wrk_1', slug: 'mini' },
        organization: 'acme',
        stored: [],
    });
    /** Relays members' terminal sockets, when a test sets it. */
    terminals: FakeTerminalRelay | undefined;
    #socket: ServerWebSocket<SocketData> | undefined;
    #waiters: Array<() => void> = [];

    constructor() {
        this.server = Bun.serve<SocketData>({
            port: 0,
            fetch: async (request, server) => {
                const url = new URL(request.url);
                const authorization = request.headers.get('authorization');
                if (url.pathname === '/v1/workers/connect') {
                    if (authorization !== `Bearer ${WORKER_KEY}`)
                        return new Response('unauthorized', { status: 401 });
                    this.connections += 1;
                    if (server.upgrade(request, { data: { id: this.connections } }))
                        return undefined;
                    return new Response('upgrade failed', { status: 400 });
                }
                const terminal = url.pathname.match(
                    /^\/v1\/workers\/[^/]+\/connections\/([^/]+)\/terminal$/
                );
                if (terminal?.[1]) {
                    this.requests.push({
                        method: request.method,
                        path: url.pathname,
                        authorization,
                        body: '',
                    });
                    const data: SocketData = {
                        id: 0,
                        terminal: {
                            connectId: terminal[1],
                            cols: Number(url.searchParams.get('cols')),
                            rows: Number(url.searchParams.get('rows')),
                        },
                    };
                    if (server.upgrade(request, { data })) return undefined;
                    return new Response('upgrade failed', { status: 400 });
                }
                const body = await request.text();
                this.requests.push({
                    method: request.method,
                    path: url.pathname,
                    authorization,
                    body,
                });
                this.notify();
                const route = this.routes.get(`${request.method} ${url.pathname}`);
                if (!route)
                    return Response.json(
                        { error: { message: 'not found' } },
                        { status: 404 }
                    );
                return route(
                    new Request(request.url, {
                        method: request.method,
                        headers: request.headers,
                        ...(body ? { body } : {}),
                    })
                );
            },
            websocket: {
                open: (socket) => {
                    if (socket.data.terminal) this.terminals?.opened(socket);
                    else this.#socket = socket;
                },
                message: (socket, data) => {
                    const message = JSON.parse(String(data)) as Message;
                    if (socket.data.terminal) {
                        this.terminals?.message(socket, message);
                        return;
                    }
                    this.received.push({ ...message, connection: socket.data.id });
                    this.terminals?.worker(message);
                    if (message.type === 'hello') {
                        const welcome = this.welcome(message);
                        if (welcome) socket.send(JSON.stringify(welcome));
                    }
                    this.notify();
                },
                close: (socket) => {
                    if (socket.data.terminal) this.terminals?.closed(socket);
                    this.notify();
                },
            },
        });
    }

    get url(): string {
        return `http://127.0.0.1:${this.server.port}`;
    }

    send(message: Message): void {
        if (!this.#socket) throw new Error('No worker is connected');
        this.#socket.send(JSON.stringify(message));
    }

    close(code: number, reason = ''): void {
        this.#socket?.close(code, reason);
        this.#socket = undefined;
    }

    /** Waits for the first recorded frame after `from` that matches. */
    async next(
        predicate: (message: Message & { connection: number }) => boolean,
        from = 0,
        timeout = 5000
    ): Promise<Message & { connection: number }> {
        const deadline = Date.now() + timeout;
        for (;;) {
            const found = this.received.slice(from).find(predicate);
            if (found) return found;
            if (Date.now() > deadline)
                throw new Error(
                    `No matching worker frame. Received: ${JSON.stringify(this.received.map((entry) => entry.type))}`
                );
            await this.changed(Math.max(1, deadline - Date.now()));
        }
    }

    /** Every event the worker sent for a run, in order. */
    events(runId: string): WorkbenchEvent[] {
        return this.received.flatMap((message) =>
            message.type === 'events' && message.run_id === runId
                ? (message.events as WorkbenchEvent[])
                : []
        );
    }

    logLines(): string[] {
        return this.received.flatMap((message) =>
            message.type === 'log'
                ? (message.lines as Array<{ text: string }>).map((line) => line.text)
                : []
        );
    }

    async request(
        predicate: (request: Recorded) => boolean,
        timeout = 5000
    ): Promise<Recorded> {
        const deadline = Date.now() + timeout;
        for (;;) {
            const found = this.requests.find(predicate);
            if (found) return found;
            if (Date.now() > deadline) throw new Error('No matching HTTP request');
            await this.changed(Math.max(1, deadline - Date.now()));
        }
    }

    stop(): void {
        this.server.stop(true);
    }

    private changed(timeout: number): Promise<void> {
        return new Promise((resolve) => {
            const timer = setTimeout(resolve, Math.min(timeout, 50));
            this.#waiters.push(() => {
                clearTimeout(timer);
                resolve();
            });
        });
    }

    private notify(): void {
        const waiters = this.#waiters;
        this.#waiters = [];
        for (const waiter of waiters) waiter();
    }
}

interface FakeSession {
    events: WorkbenchEvent[];
    active: boolean;
    outcome?: { run: string; pullRequest?: number };
}

/** An engine that keeps sessions in memory, so the daemon can be driven directly. */
export class FakeRunHost implements WorkerRunHost {
    readonly sessions = new Map<string, FakeSession>();
    readonly commands: Array<{
        session: string;
        command: WorkerCommand;
        context: WorkerRunContext;
        start?: RunStart;
    }> = [];
    readonly launched: RunStart[] = [];
    readonly released: string[] = [];
    readonly recovered: string[][] = [];
    /** Admissions held until released, to drive a start that is still being admitted. */
    admitting: Promise<void> | undefined;
    admissions = 0;
    refuse: string | undefined;
    failLaunch: string | undefined;
    failCommand: string | undefined;

    async admit(_start: RunStart): Promise<WorkerAdmission> {
        this.admissions += 1;
        await this.admitting;
        if (this.refuse) throw new WorkerRejection(this.refuse);
        return { workbench: 'threejs-game', runner: 'opencode' };
    }

    async launch(start: RunStart): Promise<string> {
        if (this.failLaunch) throw new Error(this.failLaunch);
        this.launched.push(start);
        const id = `wb_${start.run_id.replace(/[^a-z0-9]/g, '')}session`;
        this.sessions.set(id, { events: [], active: true });
        this.emit(id, 'run.started', {});
        return id;
    }

    emit(
        session: string,
        type: WorkbenchEventType,
        data: Record<string, unknown>
    ): void {
        const state = this.require(session);
        state.events.push({
            protocol: 0,
            run_id: session,
            sequence: state.events.length + 1,
            timestamp: new Date().toISOString(),
            type,
            runner: 'opencode',
            data,
        });
        if (
            type === 'run.completed' ||
            type === 'run.failed' ||
            type === 'run.cancelled'
        )
            state.active = false;
    }

    finish(session: string, pullRequest?: number): void {
        this.require(session).outcome = {
            run: session,
            ...(pullRequest ? { pullRequest } : {}),
        };
        this.emit(session, 'run.completed', { duration_ms: 1 });
    }

    async events(session: string, after: number): Promise<WorkbenchEvent[]> {
        return this.require(session).events.filter((event) => event.sequence > after);
    }

    async active(session: string): Promise<boolean> {
        return this.require(session).active;
    }

    async command(
        session: string,
        command: WorkerCommand,
        context: WorkerRunContext
    ): Promise<void> {
        this.commands.push({
            session,
            command,
            context,
            ...(context.start ? { start: context.start } : {}),
        });
        if (this.failCommand) throw new Error(this.failCommand);
        if (command.kind === 'cancel' && this.require(session).active)
            this.emit(session, 'run.cancelled', {});
    }

    async release(runId: string): Promise<void> {
        this.released.push(runId);
    }

    async recover(
        active: Array<{ run_id: string; runtime: string; session_id: string | null }>
    ): Promise<void> {
        this.recovered.push(active.map((run) => run.run_id));
    }

    async outcomes(session: string, uploaded: string[]): Promise<WorkerOutcome[]> {
        const outcome = this.require(session).outcome;
        if (!outcome || uploaded.includes(outcome.run)) return [];
        return [
            {
                run: outcome.run,
                ...(outcome.pullRequest ? { pullRequest: outcome.pullRequest } : {}),
                archive: async () => new TextEncoder().encode('outcome-archive'),
            },
        ];
    }

    private require(session: string): FakeSession {
        const state = this.sessions.get(session);
        if (!state) throw new Error(`Unknown session ${session}`);
        return state;
    }
}

export function runStart(overrides: Partial<RunStart> = {}): Message {
    return {
        type: 'run.start',
        run_id: 'run_1',
        session_id: 'ses_1',
        started_by: { member_id: null },
        runtime: 'docker',
        workbench: { version_id: 'wv_1', download_url: 'https://example.test/package' },
        image_pull: {
            registry: 'images.example.test',
            username: 'workbench',
            password: 'MUST_NOT_RENDER_IMAGE_PASSWORD',
            expires_at: '2030-01-01T00:00:00Z',
        },
        task: 'Build a pirate game with three.js',
        max_minutes: 60,
        workspace: null,
        env: { OPENROUTER_API_KEY: 'MUST_NOT_RENDER_ENV_VALUE' },
        connection: null,
        run_token: 'MUST_NOT_RENDER_RUN_TOKEN',
        ...overrides,
    };
}

/**
 * A repository with one commit served over git's smart HTTP protocol, as
 * GitHub and the API's proxy serve a run's remote, and the commit it holds.
 * `api` is the address a worker belonging to this server would be given.
 */
export async function bareRepository(): Promise<{
    url: string;
    api: string;
    commit: string;
    cleanup: () => Promise<void>;
}> {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-worker-remote-'));
    const environment = {
        PATH: process.env.PATH ?? '',
        HOME: directory,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
    };
    const git = async (cwd: string, ...args: string[]): Promise<string> => {
        const child = Bun.spawn(['git', ...args], {
            cwd,
            env: environment,
            stdout: 'pipe',
            stderr: 'pipe',
        });
        const [code, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
        ]);
        if (code !== 0) throw new Error(`git ${args.join(' ')}: ${stderr}`);
        return stdout.trim();
    };
    const work = join(directory, 'work');
    await git(directory, 'init', '--quiet', work);
    await writeFile(join(work, 'README.md'), '# Game\n');
    await writeFile(join(work, 'notes.txt'), 'first\n');
    await git(work, 'add', '-A');
    await git(
        work,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '--quiet',
        '-m',
        'first'
    );
    const commit = await git(work, 'rev-parse', 'HEAD');
    const bare = join(directory, 'remote.git');
    await git(directory, 'clone', '--quiet', '--bare', work, bare);
    const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch: (request) => httpBackend(directory, request),
    });
    const api = `http://127.0.0.1:${server.port}`;
    return {
        url: `${api}/remote.git`,
        api,
        commit,
        cleanup: async () => {
            await server.stop(true);
            await rm(directory, { recursive: true, force: true });
        },
    };
}

/** Answers one git HTTP request from the repositories in `root` through `git http-backend`. */
async function httpBackend(root: string, request: Request): Promise<Response> {
    const url = new URL(request.url);
    const child = Bun.spawn(['git', 'http-backend'], {
        env: {
            PATH: process.env.PATH ?? '',
            GIT_PROJECT_ROOT: root,
            GIT_HTTP_EXPORT_ALL: '1',
            REQUEST_METHOD: request.method,
            PATH_INFO: url.pathname,
            QUERY_STRING: url.search.slice(1),
            CONTENT_TYPE: request.headers.get('content-type') ?? '',
            HTTP_CONTENT_ENCODING: request.headers.get('content-encoding') ?? '',
            GIT_PROTOCOL: request.headers.get('git-protocol') ?? '',
        },
        stdin: new Uint8Array(await request.arrayBuffer()),
        stdout: 'pipe',
        stderr: 'ignore',
    });
    const output = Buffer.from(await new Response(child.stdout).arrayBuffer());
    await child.exited;
    const split = output.indexOf('\r\n\r\n');
    const headers = new Headers();
    let status = 200;
    for (const line of output.subarray(0, split).toString().split('\r\n')) {
        const [name = '', ...value] = line.split(': ');
        if (name.toLowerCase() === 'status')
            status = Number.parseInt(value[0] ?? '', 10);
        else if (name) headers.set(name, value.join(': '));
    }
    return new Response(output.subarray(split + 4), { status, headers });
}
