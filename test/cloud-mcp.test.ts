import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Connection } from '../src/database/connection.js';
import { McpServices } from '../src/mcp/index.js';
import { RegistryClient } from '../src/registry/client.js';
import { Services } from '../src/workbench/services.js';
import { CLOUD_RUN_ID, CLOUD_SESSION_ID, FakeCloudApi } from './cloud-fixture.js';

const homes: string[] = [];
const clouds: FakeCloudApi[] = [];
const connections: Connection[] = [];

afterEach(async () => {
    for (const cloud of clouds.splice(0)) cloud.stop();
    RegistryClient.configureApiUrl(undefined);
    for (const connection of connections.splice(0)) connection.close();
    await Promise.all(
        homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))
    );
});

/** The services and MCP operations of a home, built after its login. */
function open(home: string) {
    const connection = Connection.open(home);
    connections.push(connection);
    const services = new Services(home, connection);
    return { services, mcp: new McpServices(home, process.cwd(), services) };
}

describe('cloud MCP', () => {
    test('run starts cloud work and returns the tracked ids', async () => {
        const { home, cloud } = await setup();
        const receipt = await open(home).mcp.launcher.start({
            where: 'cloud',
            workbench: 'acme/reviewer',
            task: '# Review cloud changes',
            project: 'Demo',
        });

        expect(receipt).toEqual({
            session_id: CLOUD_SESSION_ID,
            run_id: CLOUD_RUN_ID,
            tools: {
                wait: { session_id: CLOUD_SESSION_ID },
                send: { session_id: CLOUD_SESSION_ID },
                answer: { session_id: CLOUD_SESSION_ID },
                cancel: { session_id: CLOUD_SESSION_ID },
            },
        });
        expect(cloud.requests).toContainEqual({
            method: 'POST',
            path: '/v1/runs',
            body: expect.objectContaining({ workbench: 'acme/reviewer' }),
        });
    });

    test('run reports logged out and strict project errors', async () => {
        const home = await temporaryHome();
        await open(home).services.projects.create('Demo');
        await expect(
            open(home).mcp.launcher.start({
                where: 'cloud',
                workbench: 'acme/reviewer',
                task: 'Review',
                project: 'Demo',
            })
        ).rejects.toThrow('wb login');
        const cloud = new FakeCloudApi();
        clouds.push(cloud);
        await cloud.login(home);
        await expect(
            open(home).mcp.launcher.start({
                where: 'cloud',
                workbench: 'acme/reviewer',
                task: 'Review',
                project: 'Missing',
            })
        ).rejects.toThrow('No project "Missing"');
    });

    test('waits for permission, answers, and waits to completion', async () => {
        const { home, cloud } = await setupAndRun();
        cloud.askPermission();
        const supervision = open(home).mcp.supervision;

        const waiting = await supervision.wait({
            runId: CLOUD_RUN_ID,
            timeoutSeconds: 2,
        });
        expect(waiting).toMatchObject({
            session_id: CLOUD_SESSION_ID,
            run_id: CLOUD_RUN_ID,
            state: 'needs_input',
            pending_requests: [
                { id: 'permission-1', kind: 'permission', text: 'Allow command?' },
            ],
        });
        const answered = await supervision.answer(
            CLOUD_SESSION_ID,
            'permission-1',
            'allow'
        );
        expect(answered).toMatchObject({
            session_id: CLOUD_SESSION_ID,
            run_id: CLOUD_RUN_ID,
            input_id: expect.any(String),
        });
        cloud.complete();
        const completed = await supervision.wait({
            runId: CLOUD_RUN_ID,
            after: Number(waiting.next),
            timeoutSeconds: 2,
        });
        expect(completed).toMatchObject({
            state: 'completed',
            final: 'Cloud complete',
            pending_requests: [],
        });
    });

    test('returns a pending permission when the cursor is past its event', async () => {
        const { home, cloud } = await setupAndRun();
        cloud.askPermission();
        const started = performance.now();

        const waiting = await open(home).mcp.supervision.wait({
            runId: CLOUD_RUN_ID,
            after: 2,
            timeoutSeconds: 2,
        });

        expect(performance.now() - started).toBeLessThan(1_000);
        expect(waiting).toMatchObject({
            state: 'needs_input',
            next: 2,
            pending_requests: [{ id: 'permission-1', kind: 'permission' }],
        });
    });

    test('returns an already completed run immediately', async () => {
        const { home, cloud } = await setupAndRun();
        cloud.askPermission();
        cloud.terminalReason = 'completed';
        cloud.complete();
        const after = cloud.events.at(-1)?.sequence ?? 0;
        const started = performance.now();

        const completed = await open(home).mcp.supervision.wait({
            runId: CLOUD_RUN_ID,
            after,
            timeoutSeconds: 2,
        });

        expect(performance.now() - started).toBeLessThan(1_000);
        expect(completed).toMatchObject({
            state: 'completed',
            next: after,
            final: 'Cloud complete',
            pending_requests: [],
        });
        expect(completed).not.toHaveProperty('error');
    });

    test('advances through existing boundaries one at a time', async () => {
        const { home, cloud } = await setupAndRun();
        cloud.emit('usage.updated', {
            kind: 'delta',
            input_tokens: 1,
            output_tokens: 0,
            cost_usd: 0,
        });
        cloud.emit('turn.completed', {});
        cloud.emit('usage.updated', {
            kind: 'delta',
            input_tokens: 2,
            output_tokens: 0,
            cost_usd: 0,
        });
        cloud.complete();
        const supervision = open(home).mcp.supervision;

        const first = await supervision.wait({ runId: CLOUD_RUN_ID, after: 1 });
        expect(first).toMatchObject({
            state: 'turn_completed',
            next: 3,
            usage: { input_tokens: 1 },
        });
        const second = await supervision.wait({
            runId: CLOUD_RUN_ID,
            after: Number(first.next),
        });
        expect(second).toMatchObject({
            state: 'completed',
            next: 5,
            usage: { input_tokens: 2 },
        });
    });

    test('sends and cancels a tracked cloud session', async () => {
        const { home, cloud } = await setupAndRun();
        const supervision = open(home).mcp.supervision;
        expect(
            await supervision.send(CLOUD_SESSION_ID, 'Check cleanup', 'queue')
        ).toMatchObject({
            session_id: CLOUD_SESSION_ID,
            run_id: CLOUD_RUN_ID,
            input_id: expect.any(String),
        });
        expect(await supervision.cancel(CLOUD_SESSION_ID)).toEqual({
            session_id: CLOUD_SESSION_ID,
            run_id: CLOUD_RUN_ID,
            state: 'cancelled',
        });
        expect(
            cloud.requests.filter((request) => request.path.endsWith('/commands'))
        ).toHaveLength(2);
    });

    test('lists tracked cloud runs, sessions, and tasks', async () => {
        const { home } = await setupAndRun();
        const { mcp, services } = open(home);
        const supervision = mcp.supervision;
        expect(await supervision.runs({ project: 'Demo', limit: 20 })).toMatchObject([
            { id: CLOUD_RUN_ID, session_id: CLOUD_SESSION_ID, runtime: 'cloud' },
        ]);
        expect(
            await supervision.sessions({ project: 'Demo', limit: 20 })
        ).toMatchObject([
            {
                session_id: CLOUD_SESSION_ID,
                project: 'Demo',
                latest_run: { id: CLOUD_RUN_ID },
            },
        ]);
        expect(await services.studio.board.tasks('Demo')).toMatchObject([
            { id: CLOUD_SESSION_ID, source: 'cloud' },
        ]);
    });
});

async function setup(): Promise<{ home: string; cloud: FakeCloudApi }> {
    const home = await temporaryHome();
    await open(home).services.projects.create('Demo');
    const cloud = new FakeCloudApi();
    clouds.push(cloud);
    await cloud.login(home);
    return { home, cloud };
}

async function setupAndRun(): Promise<{ home: string; cloud: FakeCloudApi }> {
    const value = await setup();
    await open(value.home).mcp.launcher.start({
        where: 'cloud',
        workbench: 'acme/reviewer',
        task: '# Review cloud changes',
        project: 'Demo',
    });
    return value;
}

async function temporaryHome(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'workbench-cloud-mcp-test-'));
    homes.push(home);
    return home;
}
