import { RegistryAccountStore } from '../src/registry/account-store.js';
import { RegistryClient } from '../src/registry/client.js';
import type { WorkbenchEvent } from '../src/runs/events.js';

type SocketData = { kind: 'run'; runId: string; after: number } | { kind: 'projects' };

export class FakeCloudApi {
    readonly requests: Array<{ method: string; path: string; body: unknown }> = [];
    readonly events: WorkbenchEvent[] = [];
    readonly openedAfter: number[] = [];
    readonly server: Bun.Server<SocketData>;
    readonly #sockets = new Set<Bun.ServerWebSocket<SocketData>>();
    status = 'running';
    startedAt: string | null = null;
    finalResponse: string | null = null;
    terminalReason: string | null = null;
    outcomeSize: number | null = null;
    projectsSupported = true;
    opened = 0;
    closed = 0;

    constructor() {
        this.events.push(event(1, 'run.started', {}));
        this.server = Bun.serve<SocketData>({
            hostname: '127.0.0.1',
            port: 0,
            fetch: (request, server) => this.fetch(request, server),
            websocket: {
                open: (socket) => {
                    this.opened += 1;
                    if (socket.data.kind === 'run')
                        this.openedAfter.push(socket.data.after);
                    this.#sockets.add(socket);
                    if (socket.data.kind === 'run') {
                        socket.subscribe(socket.data.runId);
                        for (const item of this.events) {
                            if (item.sequence > socket.data.after)
                                socket.send(JSON.stringify(item));
                        }
                    }
                },
                message() {},
                close: (socket) => {
                    this.closed += 1;
                    this.#sockets.delete(socket);
                },
            },
        });
    }

    get url(): string {
        return `http://127.0.0.1:${this.server.port}`;
    }

    async login(home: string): Promise<void> {
        RegistryClient.configureApiUrl(this.url);
        await new RegistryAccountStore({ home }).save(
            {
                organizationId: '00000000-0000-4000-8000-000000000001',
                slug: 'acme',
                name: 'Acme',
                personal: false,
                token: 'placeholder-cloud-key',
                keyId: '00000000-0000-4000-8000-000000000002',
                scopes: ['runs:read', 'runs:write'],
                expiresAt: '2099-01-01T00:00:00.000Z',
            },
            { makeDefault: true }
        );
    }

    askPermission(): void {
        this.status = 'needs_input';
        this.emit(
            'input.requested',
            {
                id: 'permission-1',
                message: 'Allow command?',
                options: ['allow', 'deny'],
            },
            false
        );
    }

    complete(): void {
        this.status = 'completed';
        this.startedAt = '2026-10-13T12:00:01.000Z';
        this.finalResponse = 'Cloud complete';
        this.emit('run.completed', {});
    }

    dropSockets(code = 1012, reason = 'Dropped', kind?: SocketData['kind']): void {
        for (const socket of this.#sockets) {
            if (!kind || socket.data.kind === kind) socket.close(code, reason);
        }
    }

    emit(
        type: WorkbenchEvent['type'],
        data: Record<string, unknown>,
        publish = true
    ): void {
        const next = event(this.events.length + 1, type, data);
        this.events.push(next);
        if (publish) {
            this.server.publish(CLOUD_RUN_ID, JSON.stringify(next));
            this.publishProjectFrames();
        }
    }

    stop(): void {
        this.server.stop(true);
    }

    private async fetch(
        request: Request,
        server: Bun.Server<SocketData>
    ): Promise<Response | undefined> {
        if (request.headers.get('authorization') !== 'Bearer placeholder-cloud-key')
            return Response.json(
                { error: { message: 'Unauthorized' } },
                { status: 401 }
            );
        const url = new URL(request.url);
        if (!this.projectsSupported && url.pathname.startsWith('/v1/projects')) {
            this.requests.push({
                method: request.method,
                path: url.pathname,
                body: null,
            });
            return Response.json(
                { error: { message: 'Project routes are not available' } },
                { status: 404 }
            );
        }
        if (
            request.method === 'GET' &&
            url.pathname === '/v1/realtime' &&
            request.headers.get('upgrade')?.toLowerCase() === 'websocket'
        ) {
            return server.upgrade(request, { data: { kind: 'projects' } })
                ? undefined
                : new Response('Upgrade failed', { status: 400 });
        }
        if (
            request.method === 'GET' &&
            url.pathname === `/v1/runs/${CLOUD_RUN_ID}/events` &&
            request.headers.get('upgrade')?.toLowerCase() === 'websocket'
        ) {
            const after = Number(url.searchParams.get('after') ?? 0);
            const upgraded = server.upgrade(request, {
                data: { kind: 'run', runId: CLOUD_RUN_ID, after },
            });
            if (upgraded) return undefined;
            return new Response('Upgrade failed', { status: 400 });
        }
        const body =
            request.method === 'POST' ? await request.json().catch(() => null) : null;
        this.requests.push({ method: request.method, path: url.pathname, body });
        if (request.method === 'GET' && url.pathname === '/v1/projects')
            return Response.json({ projects: [this.project()] });
        if (request.method === 'GET' && url.pathname === '/v1/projects/demo/tasks')
            return Response.json({ tasks: [this.task()] });
        if (request.method === 'POST' && url.pathname === '/v1/projects')
            return Response.json(this.project(), { status: 201 });
        if (request.method === 'POST' && url.pathname === '/v1/runs')
            return Response.json(this.run(), { status: 201 });
        if (request.method === 'GET' && url.pathname === `/v1/runs/${CLOUD_RUN_ID}`)
            return Response.json(this.run());
        if (request.method === 'GET' && url.pathname === '/v1/runs')
            return Response.json({ runs: [this.run()], next: null });
        if (
            request.method === 'GET' &&
            url.pathname === `/v1/runs/${CLOUD_RUN_ID}/events`
        ) {
            const after = Number(url.searchParams.get('after') ?? 0);
            const limit = Number(url.searchParams.get('limit') ?? 100);
            const events = this.events
                .filter((item) => item.sequence > after)
                .slice(0, limit);
            return Response.json({ events, next: events.at(-1)?.sequence ?? after });
        }
        if (
            request.method === 'POST' &&
            url.pathname === `/v1/runs/${CLOUD_RUN_ID}/commands`
        ) {
            const command = commandBody(body);
            if (command.kind === 'answer') {
                this.status = 'running';
                this.emit('input.accepted', {
                    id: 'permission-1',
                    kind: 'permission',
                });
            }
            if (command.kind === 'cancel') {
                this.status = 'cancelled';
                this.emit('run.cancelled', {});
            }
            return Response.json(
                {
                    command: {
                        id: `cmd_${this.requests.length}`,
                        run_id: CLOUD_RUN_ID,
                        kind: command.kind,
                        payload: command.payload,
                        idempotency_key: command.idempotency_key,
                        status: 'pending',
                        reason: null,
                        created_at: '2026-10-13T12:00:00.000Z',
                        delivered_at: null,
                    },
                    after_sequence: this.events.at(-1)?.sequence ?? 0,
                },
                { status: 202 }
            );
        }
        if (
            request.method === 'GET' &&
            url.pathname === `/v1/runs/${CLOUD_RUN_ID}/outcome/files`
        )
            return Response.json({ files: [] });
        return Response.json({ error: { message: 'Not found' } }, { status: 404 });
    }

    private run(): Record<string, unknown> {
        return {
            id: CLOUD_RUN_ID,
            session_id: CLOUD_SESSION_ID,
            project: { name: 'Demo', slug: 'demo' },
            organization_id: '00000000-0000-4000-8000-000000000001',
            workbench_id: '00000000-0000-4000-8000-000000000003',
            version_id: '00000000-0000-4000-8000-000000000004',
            workbench: {
                id: '00000000-0000-4000-8000-000000000003',
                slug: 'reviewer',
                organization_slug: 'acme',
            },
            version: {
                id: '00000000-0000-4000-8000-000000000004',
                version: '1.2.3',
                digest: 'a'.repeat(64),
            },
            package_digest: 'a'.repeat(64),
            kind: 'initial',
            status: this.status,
            task: '# Review cloud changes',
            executor: 'test',
            final_response: this.finalResponse,
            terminal_reason: this.terminalReason,
            usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.01 },
            outcome_size: this.outcomeSize,
            idempotency_key: 'test-key',
            created_at: '2026-10-13T12:00:00.000Z',
            started_at: this.startedAt,
            completed_at:
                this.status === 'completed' ? '2026-10-13T12:01:00.000Z' : null,
            updated_at: `2026-10-13T12:00:${String(this.events.length).padStart(2, '0')}.000Z`,
        };
    }

    task(): Record<string, unknown> {
        return {
            id: CLOUD_SESSION_ID,
            project: { name: 'Demo', slug: 'demo' },
            source: 'cloud',
            title: 'Review cloud changes',
            workbench: { name: 'acme/reviewer', version: '1.2.3' },
            status: this.status,
            column:
                this.status === 'completed'
                    ? 'done'
                    : this.status === 'failed' || this.status === 'cancelled'
                      ? 'failed'
                      : this.status === 'needs_input'
                        ? 'needs_you'
                        : 'running',
            latest_run_id: CLOUD_RUN_ID,
            needs_input: this.status === 'needs_input',
            created_at: '2026-10-13T12:00:00.000Z',
            updated_at: `2026-10-13T12:00:${String(this.events.length).padStart(2, '0')}.000Z`,
        };
    }

    project(): Record<string, unknown> {
        const latest = this.events.at(-1);
        const running = !['completed', 'failed', 'cancelled', 'needs_input'].includes(
            this.status
        );
        const text =
            latest?.type === 'output.text' &&
            isRecord(latest.data) &&
            typeof latest.data.text === 'string'
                ? latest.data.text
                : 'Cloud run active';
        return {
            name: 'Demo',
            slug: 'demo',
            counts: {
                needs_you: this.status === 'needs_input' ? 1 : 0,
                running: running ? 1 : 0,
                done: this.status === 'completed' ? 1 : 0,
                failed: this.status === 'failed' || this.status === 'cancelled' ? 1 : 0,
            },
            updated_at: `2026-10-13T12:00:${String(this.events.length).padStart(2, '0')}.000Z`,
            now: running
                ? [
                      {
                          task_id: CLOUD_SESSION_ID,
                          latest_run_id: CLOUD_RUN_ID,
                          title: 'Review cloud changes',
                          workbench: 'acme/reviewer',
                          source: 'cloud',
                          text,
                          at: latest?.timestamp ?? '2026-10-13T12:00:00.000Z',
                      },
                  ]
                : [],
            waiting: [],
            latest_done:
                this.status === 'completed'
                    ? {
                          task_id: CLOUD_SESSION_ID,
                          latest_run_id: CLOUD_RUN_ID,
                          title: 'Review cloud changes',
                          at: '2026-10-13T12:01:00.000Z',
                          has_outcome: this.outcomeSize !== null,
                      }
                    : null,
            today: { runs: 1, tokens: 15, cost_usd: 0.01 },
        };
    }

    sendRealtime(frame: unknown): void {
        for (const socket of this.#sockets) {
            if (socket.data.kind === 'projects') socket.send(JSON.stringify(frame));
        }
    }

    private publishProjectFrames(): void {
        this.sendRealtime({ type: 'task', topic: 'project:demo', task: this.task() });
        this.sendRealtime({
            type: 'project',
            topic: 'project:demo',
            project: this.project(),
        });
    }
}

export const CLOUD_RUN_ID = 'wb_cloudrun1234567890123456';
export const CLOUD_SESSION_ID = 'wbs_cloudsession';

function event(
    sequence: number,
    type: WorkbenchEvent['type'],
    data: Record<string, unknown>
): WorkbenchEvent {
    return {
        protocol: 0,
        run_id: CLOUD_RUN_ID,
        sequence,
        timestamp: `2026-10-13T12:00:${String(sequence).padStart(2, '0')}.000Z`,
        type,
        runner: 'opencode',
        data,
    };
}

function commandBody(value: unknown): {
    kind: 'send' | 'steer' | 'queue' | 'answer' | 'cancel';
    payload: Record<string, unknown>;
    idempotency_key: string;
} {
    if (
        value === null ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        !('kind' in value) ||
        !commandKind(value.kind) ||
        !('payload' in value) ||
        !isRecord(value.payload) ||
        !('idempotency_key' in value) ||
        typeof value.idempotency_key !== 'string'
    )
        throw new Error('Invalid fake command');
    return {
        kind: value.kind,
        payload: value.payload,
        idempotency_key: value.idempotency_key,
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function commandKind(
    value: unknown
): value is 'send' | 'steer' | 'queue' | 'answer' | 'cancel' {
    return (
        value === 'send' ||
        value === 'steer' ||
        value === 'queue' ||
        value === 'answer' ||
        value === 'cancel'
    );
}
