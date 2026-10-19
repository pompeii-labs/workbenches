import { createHash, timingSafeEqual } from 'node:crypto';
import { safeArtifactPath } from '../outcomes/paths.js';
import { RunStore } from '../runs/store.js';
import type { StudioBoard } from './board.js';
import type { StudioCommand, StudioCommands } from './commands.js';
import { isRecord } from './values.js';
import type { StudioWakeSocket } from './wake.js';

const SERVABLE_ESSENCE =
    /^(?:image\/(?:png|jpeg|gif|webp|avif)|video\/[\w.+-]+|audio\/[\w.+-]+|application\/pdf|text\/plain)$/;
const DECLARED_MEDIA_TYPE = /^\s*([^\s;]+)\s*(?:;\s*charset\s*=\s*([\w-]+)\s*)?$/i;

interface RunSocketData {
    kind: 'run';
    runId: string;
    cursor: number;
}

interface LiveSocketData {
    kind: 'live';
}

type SocketData = RunSocketData | LiveSocketData;
type StudioSocket = Bun.ServerWebSocket<SocketData>;

/** The loopback Studio API the dashboard container calls with its bearer token. */
export class StudioServer {
    readonly #runSockets = new Set<StudioSocket>();
    readonly #liveSockets = new Set<StudioSocket>();
    #server: Bun.Server<SocketData> | undefined;
    #wakeQueue = Promise.resolve();

    constructor(
        private readonly token: string,
        private readonly requestedPort: number,
        private readonly board: StudioBoard,
        private readonly commands: StudioCommands,
        private readonly wake: StudioWakeSocket,
        private readonly runs: Pick<RunStore, 'read'>
    ) {}

    get port(): number {
        if (!this.#server) throw new Error('Studio server is not running');
        return this.#server.port ?? this.requestedPort;
    }

    async start(): Promise<void> {
        if (this.#server) return;
        this.#server = Bun.serve<SocketData>({
            hostname: '127.0.0.1',
            port: this.requestedPort,
            development: false,
            fetch: (request, server) => this.fetch(request, server),
            websocket: {
                open: (socket) => void this.open(socket),
                message() {},
                close: (socket) => {
                    this.#runSockets.delete(socket);
                    this.#liveSockets.delete(socket);
                },
            },
        });
        await this.wake.start((runId) => {
            this.#wakeQueue = this.#wakeQueue
                .then(() => this.publish(runId))
                .catch(() => {});
        });
    }

    async stop(): Promise<void> {
        await this.wake.stop();
        this.#server?.stop(true);
        this.#server = undefined;
        this.#runSockets.clear();
        this.#liveSockets.clear();
    }

    private async fetch(
        request: Request,
        server: Bun.Server<SocketData>
    ): Promise<Response | undefined> {
        const rejected = this.authorize(request);
        if (rejected) return rejected;
        const url = new URL(request.url);
        if (request.method === 'GET' && url.pathname === '/v1/live') {
            return server.upgrade(request, { data: { kind: 'live' } })
                ? undefined
                : error(400, 'upgrade_failed', 'WebSocket upgrade failed');
        }
        try {
            const runEvents = url.pathname.match(
                /^\/v1\/runs\/(wb_[a-z0-9]+)\/events$/
            );
            if (
                request.method === 'GET' &&
                runEvents &&
                request.headers.has('upgrade')
            ) {
                const after = integer(url.searchParams.get('after'), 0, 0);
                if (after instanceof Response) return after;
                await this.board.run(runEvents[1] as string);
                return server.upgrade(request, {
                    data: { kind: 'run', runId: runEvents[1] as string, cursor: after },
                })
                    ? undefined
                    : error(400, 'upgrade_failed', 'WebSocket upgrade failed');
            }
            return await this.route(request, url);
        } catch (caught) {
            const message =
                caught instanceof Error ? caught.message : 'Studio request failed';
            return error(404, 'not_found', message);
        }
    }

    private async route(request: Request, url: URL): Promise<Response> {
        if (request.method === 'GET' && url.pathname === '/v1/status')
            return json(this.board.status());
        if (request.method === 'GET' && url.pathname === '/v1/projects')
            return json({ projects: await this.board.projects() });
        if (request.method === 'GET' && url.pathname === '/v1/tasks')
            return json({
                tasks: await this.board.tasks(
                    url.searchParams.get('project') ?? undefined
                ),
            });
        const task = url.pathname.match(/^\/v1\/tasks\/(wb_[a-z0-9]+)$/);
        if (request.method === 'GET' && task)
            return json(await this.board.task(task[1] as string));
        const run = url.pathname.match(/^\/v1\/runs\/(wb_[a-z0-9]+)$/);
        if (request.method === 'GET' && run)
            return json(await this.board.run(run[1] as string));
        const events = url.pathname.match(/^\/v1\/runs\/(wb_[a-z0-9]+)\/events$/);
        if (request.method === 'GET' && events) {
            const after = integer(url.searchParams.get('after'), 0, 0);
            if (after instanceof Response) return after;
            const limit = integer(url.searchParams.get('limit'), 100, 1, 500);
            if (limit instanceof Response) return limit;
            return json(await this.board.events(events[1] as string, after, limit));
        }
        const commands = url.pathname.match(/^\/v1\/runs\/(wb_[a-z0-9]+)\/commands$/);
        if (request.method === 'POST' && commands)
            return this.command(commands[1] as string, request);
        const files = url.pathname.match(
            /^\/v1\/runs\/(wb_[a-z0-9]+)\/outcome\/files$/
        );
        if (request.method === 'GET' && files)
            return json({ files: await this.board.outcomeFiles(files[1] as string) });
        const file = url.pathname.match(
            /^\/v1\/runs\/(wb_[a-z0-9]+)\/outcome\/files\/(.+)$/
        );
        if (request.method === 'GET' && file) {
            const path = safeArtifactPath(
                (file[2] as string)
                    .split('/')
                    .map((part) => decodeURIComponent(part))
                    .join('/')
            );
            const found = await this.board.outcomeFile(file[1] as string, path);
            const inline = servableMediaType(found.mediaType);
            return new Response(found.bytes, {
                headers: {
                    'Content-Type': inline ?? 'application/octet-stream',
                    ...(inline ? {} : { 'Content-Disposition': 'attachment' }),
                    'X-Content-Type-Options': 'nosniff',
                    'Content-Security-Policy': "sandbox; default-src 'none'",
                },
            });
        }
        return error(404, 'not_found', 'Studio route does not exist');
    }

    private authorize(request: Request): Response | undefined {
        const host = request.headers.get('host');
        const allowed = new Set([
            `127.0.0.1:${this.port}`,
            `localhost:${this.port}`,
            `host.docker.internal:${this.port}`,
        ]);
        if (!host || !allowed.has(host))
            return error(403, 'invalid_host', 'Host is not allowed');
        const authorization = request.headers.get('authorization') ?? '';
        const expected = `Bearer ${this.token}`;
        const actualDigest = createHash('sha256').update(authorization).digest();
        const expectedDigest = createHash('sha256').update(expected).digest();
        if (!timingSafeEqual(actualDigest, expectedDigest))
            return error(401, 'unauthorized', 'Authorization is required');
        return undefined;
    }

    private async open(socket: StudioSocket): Promise<void> {
        if (socket.data.kind === 'live') {
            this.#liveSockets.add(socket);
            socket.send(
                JSON.stringify({ type: 'status', status: this.board.status() })
            );
            return;
        }
        this.#runSockets.add(socket);
        await this.sendEvents(socket);
    }

    private async publish(runId: string): Promise<void> {
        const sockets = [...this.#runSockets].filter(
            (socket) => socket.data.kind === 'run' && socket.data.runId === runId
        );
        await Promise.all(sockets.map((socket) => this.sendEvents(socket)));
        const sessionId = (await this.runs.read(runId).catch(() => undefined))
            ?.session_id;
        if (!sessionId) return;
        const task = await this.board
            .task(sessionId)
            .then((result) => result.task)
            .catch(() => undefined);
        if (!task) return;
        const project = await this.board.project(task.project);
        for (const socket of this.#liveSockets) {
            socket.send(JSON.stringify({ type: 'task', task }));
            if (project) socket.send(JSON.stringify({ type: 'project', project }));
        }
    }

    private async sendEvents(socket: StudioSocket): Promise<void> {
        if (socket.data.kind !== 'run') return;
        while (true) {
            const page = await this.board.events(
                socket.data.runId,
                socket.data.cursor,
                500
            );
            for (const event of page.events) socket.send(JSON.stringify(event));
            socket.data.cursor = page.next;
            if (page.events.length < 500) break;
        }
        const run = await this.runs.read(socket.data.runId);
        if (RunStore.isTerminal(run.status)) socket.close(1000);
    }

    private async command(runId: string, request: Request): Promise<Response> {
        const body = await commandBody(request);
        if (body instanceof Response) return body;
        return json(await this.commands.submit(runId, body), 202);
    }
}

async function commandBody(request: Request): Promise<StudioCommand | Response> {
    let value: unknown;
    try {
        value = await request.json();
    } catch {
        return error(400, 'invalid_json', 'Request body must be JSON');
    }
    if (
        !value ||
        typeof value !== 'object' ||
        !('kind' in value) ||
        !['send', 'steer', 'queue', 'answer', 'cancel'].includes(String(value.kind)) ||
        !('payload' in value) ||
        !value.payload ||
        !isRecord(value.payload) ||
        !('idempotency_key' in value) ||
        typeof value.idempotency_key !== 'string' ||
        !value.idempotency_key
    )
        return error(400, 'invalid_command', 'Command body is invalid');
    const kind = value.kind;
    if (
        kind !== 'send' &&
        kind !== 'steer' &&
        kind !== 'queue' &&
        kind !== 'answer' &&
        kind !== 'cancel'
    )
        return error(400, 'invalid_command', 'Command kind is invalid');
    return { kind, payload: value.payload, idempotency_key: value.idempotency_key };
}

// Returns the normalized type to serve inline, or undefined for an attachment.
export function servableMediaType(declared: string): string | undefined {
    const match = declared.match(DECLARED_MEDIA_TYPE);
    const essence = match?.[1]?.toLowerCase();
    if (!essence || !SERVABLE_ESSENCE.test(essence)) return undefined;
    const charset = match?.[2]?.toLowerCase();
    return charset ? `${essence}; charset=${charset}` : essence;
}

function integer(
    value: string | null,
    fallback: number,
    minimum: number,
    maximum = Number.MAX_SAFE_INTEGER
): number | Response {
    if (value === null) return fallback;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
        ? parsed
        : error(400, 'invalid_parameter', 'Query parameter is out of range');
}

function json(value: unknown, status = 200): Response {
    return Response.json(value, { status });
}

function error(status: number, code: string, message: string): Response {
    return json({ error: { code, message } }, status);
}
