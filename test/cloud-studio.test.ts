import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Connection } from '../src/database/connection.js';
import { McpServices } from '../src/mcp/index.js';
import { RegistryAccountStore } from '../src/registry/account-store.js';
import { RegistryClient } from '../src/registry/client.js';
import type { StudioServer } from '../src/studio/server.js';
import { isRecord } from '../src/studio/values.js';
import { Services } from '../src/workbench/services.js';
import { CLOUD_RUN_ID, CLOUD_SESSION_ID, FakeCloudApi } from './cloud-fixture.js';

const homes: string[] = [];
const clouds: FakeCloudApi[] = [];
const studios: StudioServer[] = [];
const connections: Connection[] = [];

afterEach(async () => {
    await Promise.all(studios.splice(0).map((studio) => studio.stop()));
    for (const cloud of clouds.splice(0)) cloud.stop();
    RegistryClient.configureApiUrl(undefined);
    for (const connection of connections.splice(0)) connection.close();
    await Promise.all(
        homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))
    );
});

/** Services for a home, built after any login the test performed. */
function open(home: string) {
    const connection = Connection.open(home);
    connections.push(connection);
    return Object.assign(new Services(home, connection), { connection });
}

describe('cloud Studio API', () => {
    test('loads tracked cloud views when project routes are unsupported', async () => {
        const { cloud, studio } = await setup(false);

        expect(await (await request(studio, '/v1/projects')).json()).toMatchObject({
            projects: [{ name: 'Demo', counts: { running: 2 } }],
        });
        expect(await (await request(studio, '/v1/tasks')).json()).toMatchObject({
            tasks: [{ source: 'cloud', id: CLOUD_SESSION_ID }, { source: 'local' }],
        });
        expect(
            await (await request(studio, `/v1/tasks/${CLOUD_SESSION_ID}`)).json()
        ).toMatchObject({
            task: { id: CLOUD_SESSION_ID, source: 'cloud' },
            runs: [{ id: CLOUD_RUN_ID, status: 'running' }],
        });
        expect(
            await (await request(studio, `/v1/runs/${CLOUD_RUN_ID}`)).json()
        ).toMatchObject({
            id: CLOUD_RUN_ID,
            status: 'running',
        });
        expect(
            cloud.requests.filter((item) => item.path.includes('/tasks'))
        ).toHaveLength(0);

        const live = webSocket(studio, '/v1/live');
        expect(await nextFrame(live)).toMatchObject({ type: 'status' });
        await Bun.sleep(50);
        expect(cloud.opened).toBe(0);

        const run = webSocket(studio, `/v1/runs/${CLOUD_RUN_ID}/events?after=0`);
        expect(await nextFrame(run)).toMatchObject({ type: 'run.started' });
        await eventually(() => cloud.opened === 1);
        const output = nextFrame(run);
        cloud.emit('output.text', { id: 'message-1', text: 'Fallback output' });
        expect(await output).toMatchObject({ type: 'output.text', sequence: 2 });

        run.close();
        live.close();
    });

    test('merges local and cloud projects and tasks only while logged in', async () => {
        const { home, cloud, studio, services } = await setup();
        services.connection.run(
            'UPDATE cloud_sessions SET title = ? WHERE session_id = ?',
            'Tracked title',
            CLOUD_SESSION_ID
        );
        const projects = await (await request(studio, '/v1/projects')).json();
        expect(projects).toMatchObject({
            projects: [
                {
                    name: 'Demo',
                    counts: { running: 2 },
                },
            ],
        });
        const tasks = await (await request(studio, '/v1/tasks')).json();
        expect(tasks).toMatchObject({
            tasks: [
                {
                    source: 'cloud',
                    id: CLOUD_SESSION_ID,
                    title: 'Review cloud changes',
                },
                { source: 'local' },
            ],
        });
        expect(await (await request(studio, '/v1/status')).json()).toMatchObject({
            login: { organization: 'acme' },
        });

        await new RegistryAccountStore({ home }).remove('acme');
        expect(await (await request(studio, '/v1/tasks')).json()).toMatchObject({
            tasks: [{ source: 'local' }],
        });
        expect(await (await request(studio, '/v1/status')).json()).toMatchObject({
            login: null,
        });
        expect(cloud.requests.length).toBeGreaterThan(0);
    });

    test('applies cloud project frames live without refetching per event', async () => {
        const { cloud, studio } = await setup();
        const live = webSocket(studio, '/v1/live');
        expect(await nextFrame(live)).toMatchObject({
            type: 'status',
            status: { login: { organization: 'acme' } },
        });
        await eventually(() => cloud.opened === 1);

        const changed = nextFrame(live);
        cloud.emit('output.text', { id: 'message-1', text: 'Cloud output' });
        expect(await changed).toMatchObject({
            type: 'task',
            task: { id: CLOUD_SESSION_ID, source: 'cloud' },
        });

        const requestsBefore = cloud.requests.filter(
            (request) =>
                request.method === 'GET' && request.path === `/v1/runs/${CLOUD_RUN_ID}`
        ).length;
        const finished = frameMatching(
            live,
            (frame) => frame.type === 'task' && JSON.stringify(frame).includes('done')
        );
        cloud.complete();
        await finished;
        expect(
            await (await request(studio, `/v1/runs/${CLOUD_RUN_ID}`)).json()
        ).toMatchObject({
            final_response: 'Cloud complete',
            started_at: '2026-10-13T12:00:01.000Z',
            completed_at: '2026-10-13T12:01:00.000Z',
        });
        expect(
            cloud.requests.filter(
                (request) =>
                    request.method === 'GET' &&
                    request.path === `/v1/runs/${CLOUD_RUN_ID}`
            ).length - requestsBefore
        ).toBe(1);
        live.close();
    });

    test('loads a cloud run lazily after its project task enters running', async () => {
        const { cloud, studio } = await setup();
        cloud.status = 'provisioning';
        cloud.events.splice(0);
        const live = webSocket(studio, '/v1/live');
        await nextFrame(live);
        await eventually(() => cloud.opened === 1);
        const requestsBefore = cloud.requests.filter(
            (request) =>
                request.method === 'GET' && request.path === `/v1/runs/${CLOUD_RUN_ID}`
        ).length;
        const started = frameMatching(
            live,
            (frame) =>
                frame.type === 'task' && JSON.stringify(frame).includes('running')
        );

        cloud.status = 'running';
        cloud.startedAt = '2026-10-13T12:00:01.000Z';
        cloud.emit('run.started', {});
        await started;

        expect(
            await (await request(studio, `/v1/runs/${CLOUD_RUN_ID}`)).json()
        ).toMatchObject({ started_at: '2026-10-13T12:00:01.000Z' });
        expect(
            cloud.requests.filter(
                (request) =>
                    request.method === 'GET' &&
                    request.path === `/v1/runs/${CLOUD_RUN_ID}`
            ).length - requestsBefore
        ).toBe(1);
        live.close();
    });

    test('streams frequent cloud events with a constant number of API requests', async () => {
        const { cloud, studio } = await setup();
        const live = webSocket(studio, '/v1/live');
        await nextFrame(live);
        await eventually(() => cloud.opened === 1);
        const requestsBefore = cloud.requests.length;
        expect(
            cloud.requests.filter(
                (request) =>
                    request.method === 'GET' &&
                    request.path === '/v1/projects/demo/tasks'
            )
        ).toHaveLength(1);
        const latest = frameMatching(
            live,
            (frame) =>
                frame.type === 'project' &&
                JSON.stringify(frame).includes('Cloud output 49')
        );

        for (let index = 0; index < 50; index += 1) {
            cloud.emit('output.text', {
                id: `message-${index}`,
                text: `Cloud output ${index}`,
            });
        }

        await latest;
        expect(cloud.requests.length - requestsBefore).toBe(0);
        live.close();
    });

    test('reconnects a dropped cloud socket from the cached sequence', async () => {
        const { cloud, studio } = await setup();
        const live = webSocket(studio, '/v1/live');
        await nextFrame(live);
        await eventually(() => cloud.opened === 1);
        const first = frameMatching(live, (frame) =>
            JSON.stringify(frame).includes('Before disconnect')
        );
        cloud.emit('output.text', { id: 'message-1', text: 'Before disconnect' });
        await first;
        const requestsBefore = cloud.requests.length;

        cloud.dropSockets();
        await eventually(() => cloud.opened === 2);
        expect(cloud.openedAfter).toEqual([]);
        expect(cloud.requests.length).toBe(requestsBefore);

        const later = frameMatching(live, (frame) =>
            JSON.stringify(frame).includes('After reconnect')
        );
        cloud.emit('output.text', { id: 'message-2', text: 'After reconnect' });
        await later;
        const page = await (
            await request(studio, `/v1/runs/${CLOUD_RUN_ID}/events?after=0`)
        ).json();
        expect(page).toMatchObject({
            events: [{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }],
            next: 3,
        });
        live.close();
    });

    test('reconnects the realtime socket at once when the cloud asks to reauthenticate', async () => {
        const { cloud, studio } = await setup();
        const live = webSocket(studio, '/v1/live');
        await nextFrame(live);
        await eventually(() => cloud.opened === 1);

        // Exponential backoff would need 1s + 2s + 4s, past the wait limit.
        for (let round = 2; round <= 4; round += 1) {
            cloud.dropSockets(4001, 'reauthenticate');
            await eventually(() => cloud.opened === round);
        }
        const later = frameMatching(live, (frame) =>
            JSON.stringify(frame).includes('After reauthenticate')
        );
        cloud.emit('output.text', { id: 'message-1', text: 'After reauthenticate' });
        await later;
        live.close();
    });

    test('backs off when the realtime socket closes with another code', async () => {
        const { cloud, studio } = await setup();
        const live = webSocket(studio, '/v1/live');
        await nextFrame(live);
        await eventually(() => cloud.opened === 1);

        cloud.dropSockets(1012, 'Restarting');
        await Bun.sleep(200);
        expect(cloud.opened).toBe(1);
        await eventually(() => cloud.opened === 2);
        live.close();
    });

    test('resumes a run socket from its last sequence after a reauthenticate close', async () => {
        const { cloud, studio } = await setup();
        const live = webSocket(studio, '/v1/live');
        await nextFrame(live);
        await eventually(() => cloud.opened === 1);

        const run = webSocket(studio, `/v1/runs/${CLOUD_RUN_ID}/events?after=0`);
        const sequences: number[] = [];
        run.addEventListener('message', (message) => {
            const frame: unknown = JSON.parse(String(message.data));
            if (isRecord(frame) && typeof frame.sequence === 'number')
                sequences.push(frame.sequence);
        });
        await eventually(
            () => cloud.openedAfter.length === 1 && sequences.length === 1
        );

        // Exponential backoff would need 1s + 2s + 4s, past the wait limit.
        for (let round = 1; round <= 3; round += 1) {
            cloud.dropSockets(4001, 'reauthenticate', 'run');
            cloud.emit('output.text', {
                id: `message-${round}`,
                text: `Round ${round}`,
            });
            await eventually(() => cloud.openedAfter.length === round + 1);
            await eventually(() => sequences.length === round + 1);
        }
        expect(cloud.openedAfter.every((after) => after >= 1)).toBe(true);
        expect(sequences).toEqual([1, 2, 3, 4]);
        run.close();
        live.close();
    });

    test('backs off when a run socket closes with another code', async () => {
        const { cloud, studio } = await setup();
        const live = webSocket(studio, '/v1/live');
        await nextFrame(live);
        await eventually(() => cloud.opened === 1);
        const run = webSocket(studio, `/v1/runs/${CLOUD_RUN_ID}/events?after=0`);
        await nextFrame(run);
        await eventually(() => cloud.opened === 2);

        cloud.dropSockets(1012, 'Restarting', 'run');
        await Bun.sleep(200);
        expect(cloud.opened).toBe(2);
        await eventually(() => cloud.opened === 3);
        run.close();
        live.close();
    });

    test('opens a per-run cloud socket only for an open run view', async () => {
        const { cloud, studio } = await setup();
        const live = webSocket(studio, '/v1/live');
        await nextFrame(live);
        await eventually(() => cloud.opened === 1);

        const run = webSocket(studio, `/v1/runs/${CLOUD_RUN_ID}/events?after=0`);
        expect(await nextFrame(run)).toMatchObject({ type: 'run.started' });
        await eventually(() => cloud.opened === 2);
        expect(cloud.openedAfter).toEqual([1]);
        const requestsBefore = cloud.requests.length;
        const output = nextFrame(run);
        cloud.emit('output.text', { id: 'message-1', text: 'Open run output' });
        expect(await output).toMatchObject({ type: 'output.text', sequence: 2 });
        expect(cloud.requests.length).toBe(requestsBefore);

        run.close();
        await eventually(() => cloud.closed === 1);
        expect(cloud.opened - cloud.closed).toBe(1);
        live.close();
    });

    test('applies a task for an uncached project before its project frame', async () => {
        const { cloud, studio } = await setup();
        const live = webSocket(studio, '/v1/live');
        await nextFrame(live);
        await eventually(() => cloud.opened === 1);

        const task = {
            ...cloud.task(),
            id: 'wbs_elsewhere',
            latest_run_id: 'wb_elsewhere12345678901234567',
            project: { name: 'Other', slug: 'other' },
        };
        const landed = frameMatching(live, (frame) =>
            JSON.stringify(frame).includes('wbs_elsewhere')
        );
        cloud.sendRealtime({ type: 'task', topic: 'project:other', task });
        await landed;
        expect(await (await request(studio, '/v1/tasks')).json()).toMatchObject({
            tasks: expect.arrayContaining([
                expect.objectContaining({ id: 'wbs_elsewhere' }),
            ]),
        });

        const registered = frameMatching(
            live,
            (frame) =>
                frame.type === 'project' && JSON.stringify(frame).includes('Other')
        );
        cloud.sendRealtime({
            type: 'project',
            topic: 'project:other',
            project: { ...cloud.project(), name: 'Other', slug: 'other' },
        });
        await registered;
        expect(await (await request(studio, '/v1/projects')).json()).toMatchObject({
            projects: expect.arrayContaining([
                expect.objectContaining({ name: 'Other' }),
            ]),
        });
        expect(cloud.opened).toBe(1);
        live.close();
    });

    test('drops realtime frames it does not understand and keeps the socket open', async () => {
        const { cloud, studio } = await setup();
        const live = webSocket(studio, '/v1/live');
        await nextFrame(live);
        await eventually(() => cloud.opened === 1);

        cloud.sendRealtime({ type: 'task', topic: 'org:acme', task: cloud.task() });
        cloud.sendRealtime({ type: 'task', task: cloud.task() });
        cloud.sendRealtime({ type: 'audit', topic: 'project:demo' });

        const followed = frameMatching(
            live,
            (frame) =>
                frame.type === 'task' && JSON.stringify(frame).includes('Tracked')
        );
        cloud.sendRealtime({
            type: 'task',
            topic: 'project:demo',
            task: { ...cloud.task(), title: 'Tracked title' },
        });
        const frame = await followed;
        expect(frame).toMatchObject({ type: 'task', task: { id: CLOUD_SESSION_ID } });
        expect(cloud.opened).toBe(1);
        live.close();
    });

    test('treats a realtime topic that disagrees with its body as an error', async () => {
        const { cloud, studio } = await setup();
        const live = webSocket(studio, '/v1/live');
        await nextFrame(live);
        await eventually(() => cloud.opened === 1);

        cloud.sendRealtime({
            type: 'task',
            topic: 'project:other',
            task: cloud.task(),
        });
        await eventually(() => cloud.opened === 2);
        live.close();
    });

    test('serves tracked cloud run events and commands', async () => {
        const { studio } = await setup();
        expect(
            await (await request(studio, `/v1/runs/${CLOUD_RUN_ID}`)).json()
        ).toMatchObject({ id: CLOUD_RUN_ID, status: 'running' });
        expect(
            await (
                await request(studio, `/v1/runs/${CLOUD_RUN_ID}/events?after=0`)
            ).json()
        ).toMatchObject({ events: [{ type: 'run.started' }], next: 1 });
        const response = await request(studio, `/v1/runs/${CLOUD_RUN_ID}/commands`, {
            method: 'POST',
            body: JSON.stringify({
                kind: 'send',
                payload: { text: 'Continue' },
                idempotency_key: 'cloud-command-1',
            }),
            headers: { 'Content-Type': 'application/json' },
        });
        expect(response.status).toBe(202);
        expect(await response.json()).toMatchObject({
            command: { status: 'accepted' },
        });
    });
});

async function setup(projectsSupported = true): Promise<{
    home: string;
    cloud: FakeCloudApi;
    studio: StudioServer;
    services: ReturnType<typeof open>;
}> {
    const home = await temporaryHome();
    await open(home).projects.create('Demo');
    await seedLocal(home);
    const cloud = new FakeCloudApi();
    cloud.projectsSupported = projectsSupported;
    clouds.push(cloud);
    await cloud.login(home);
    const services = open(home);
    await new McpServices(home, process.cwd(), services).launcher.start({
        where: 'cloud',
        workbench: 'acme/reviewer',
        task: '# Review cloud changes',
        project: 'Demo',
    });
    const studio = services.studio.server('test-token', 0);
    studios.push(studio);
    await studio.start();
    return { home, cloud, studio, services };
}

async function seedLocal(home: string): Promise<void> {
    const id = 'wb_localrun12345678901234567';
    const services = open(home);
    const project = await services.projects.resolve('Demo');
    const session = await services.sessions.create({
        id,
        project,
        workbench: 'local-reviewer',
        workbench_version: '1.0.0',
        runner: 'opencode',
        model: 'openai/test',
        runtime: 'local',
        reference: 'local-reviewer',
        workbench_path: '/fixture',
        workspace: '/workspace',
        workspaces: [],
        latest_run_id: id,
    });
    const run = await services.runs.create({
        id,
        metadata: {
            workbench: session.workbench,
            workbench_version: session.workbench_version,
            runner: session.runner,
            model: session.model,
            runtime: session.runtime,
            workspace: session.workspace,
            session_id: id,
            task: '# Local review',
        },
        request: {
            workbench_path: '/fixture',
            workspace: '/workspace',
            task: '# Local review',
        },
    });
    await services.runs.appendEvent(run.id, {
        protocol: 0,
        run_id: run.id,
        sequence: 1,
        timestamp: '2026-10-13T11:00:00.000Z',
        type: 'run.started',
        runner: 'opencode',
        data: {},
    });
}

async function request(
    studio: StudioServer,
    path: string,
    init: RequestInit = {}
): Promise<Response> {
    return fetch(`http://127.0.0.1:${studio.port}${path}`, {
        ...init,
        headers: {
            Host: `127.0.0.1:${studio.port}`,
            Authorization: 'Bearer test-token',
            ...init.headers,
        },
    });
}

function webSocket(studio: StudioServer, path: string): WebSocket {
    return new WebSocket(`ws://127.0.0.1:${studio.port}${path}`, {
        headers: { Authorization: 'Bearer test-token' },
    });
}

function nextFrame(socket: WebSocket): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Frame timed out')), 5_000);
        socket.addEventListener(
            'message',
            (message) => {
                clearTimeout(timer);
                const value: unknown = JSON.parse(String(message.data));
                if (!isRecord(value)) return reject(new Error('Invalid frame'));
                resolve(value);
            },
            { once: true }
        );
        socket.addEventListener('error', () => reject(new Error('Socket failed')), {
            once: true,
        });
    });
}

function frameMatching(
    socket: WebSocket,
    matches: (frame: Record<string, unknown>) => boolean
): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.removeEventListener('message', receive);
            reject(new Error('Matching frame timed out'));
        }, 5_000);
        const receive = (message: MessageEvent) => {
            const value: unknown = JSON.parse(String(message.data));
            if (!isRecord(value) || !matches(value)) return;
            clearTimeout(timer);
            socket.removeEventListener('message', receive);
            resolve(value);
        };
        socket.addEventListener('message', receive);
    });
}

async function eventually(condition: () => boolean): Promise<void> {
    const started = Date.now();
    while (!condition()) {
        if (Date.now() - started > 5_000) throw new Error('Condition timed out');
        await Bun.sleep(10);
    }
}

async function temporaryHome(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'workbench-cloud-studio-test-'));
    homes.push(home);
    return home;
}
