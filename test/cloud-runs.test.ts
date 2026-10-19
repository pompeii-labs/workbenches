import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Connection } from '../src/database/connection.js';
import { RegistryAccountStore } from '../src/registry/account-store.js';
import { RegistryClient } from '../src/registry/client.js';
import { Services } from '../src/workbench/services.js';

const homes: string[] = [];
const servers: Bun.Server<undefined>[] = [];
const connections: Connection[] = [];

afterEach(async () => {
    for (const server of servers.splice(0)) server.stop(true);
    RegistryClient.configureApiUrl(undefined);
    for (const connection of connections.splice(0)) connection.close();
    await Promise.all(
        homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))
    );
});

/** Services for a home, built after any API URL the test configured. */
function open(home: string) {
    const connection = Connection.open(home);
    connections.push(connection);
    return Object.assign(new Services(home, connection), { connection });
}

describe('cloud runs', () => {
    test('tracks cloud sessions by session and latest run', async () => {
        const home = await temporaryHome();
        const { projects, cloudSessions: store, connection } = open(home);
        const project = await projects.create('Cloud Demo');
        store.track({
            sessionId: 'wbs_cloudsession',
            latestRunId: 'wb_cloudrun1234567890123456',
            organization: 'acme',
            projectId: project.id,
            workbench: 'acme/reviewer',
            title: 'Review this',
            createdAt: '2026-10-13T12:00:00.000Z',
        });

        expect(
            connection.one('SELECT max(version) AS version FROM __migrations')
        ).toEqual({ version: 3 });
        expect(store.bySession('wbs_cloudsession')).toMatchObject({
            project: 'Cloud Demo',
            latestRunId: 'wb_cloudrun1234567890123456',
        });
        expect(store.byRun('wb_cloudrun1234567890123456')?.sessionId).toBe(
            'wbs_cloudsession'
        );
    });

    test('requires a login and resolves projects strictly before launch', async () => {
        const home = await temporaryHome();
        const services = open(home);
        await expect(
            services.cloud.start({
                workbench: 'acme/reviewer',
                task: 'Review this',
                project: 'Missing',
            })
        ).rejects.toThrow('No project "Missing"');
        await services.projects.create('Cloud Demo');
        await expect(
            services.cloud.start({
                workbench: 'acme/reviewer',
                task: 'Review this',
                project: 'Cloud Demo',
            })
        ).rejects.toThrow('wb login');
    });

    test('starts and tracks a cloud run with the held organization key', async () => {
        const home = await temporaryHome();
        const project = await open(home).projects.create('Cloud Demo');
        const server = Bun.serve({
            hostname: '127.0.0.1',
            port: 0,
            fetch: async (request) => {
                expect(request.headers.get('authorization')).toBe(
                    'Bearer placeholder-cloud-key'
                );
                const url = new URL(request.url);
                if (url.pathname === '/v1/projects') {
                    await request.json();
                    return Response.json(cloudProject(), { status: 201 });
                }
                expect(await request.json()).toMatchObject({
                    workbench: 'acme/reviewer',
                    task: 'Review this',
                    project: 'cloud-demo',
                });
                return Response.json(cloudRun(), { status: 201 });
            },
        });
        servers.push(server);
        RegistryClient.configureApiUrl(`http://127.0.0.1:${server.port}`);
        await fakeLogin(home);
        const services = open(home);

        const receipt = await services.cloud.start({
            workbench: 'acme/reviewer',
            task: 'Review this',
            project: project.slug,
        });

        expect(receipt).toEqual({
            session_id: 'wbs_cloudsession',
            run_id: 'wb_cloudrun1234567890123456',
        });
        expect(services.cloudSessions.bySession(receipt.session_id)).toMatchObject({
            organization: 'acme',
            project: 'Cloud Demo',
            workbench: 'acme/reviewer',
            title: 'Review this',
        });
    });

    test('starts against an older cloud without project routes', async () => {
        const home = await temporaryHome();
        await open(home).projects.create('Local Demo');
        const requests: Array<{ path: string; body: unknown }> = [];
        const server = Bun.serve({
            hostname: '127.0.0.1',
            port: 0,
            fetch: async (request) => {
                const url = new URL(request.url);
                const body = await request.json().catch(() => null);
                requests.push({ path: url.pathname, body });
                if (url.pathname === '/v1/projects')
                    return Response.json(
                        { error: { message: 'Not found' } },
                        { status: 404 }
                    );
                return Response.json(cloudRun(), { status: 201 });
            },
        });
        servers.push(server);
        RegistryClient.configureApiUrl(`http://127.0.0.1:${server.port}`);
        await fakeLogin(home);
        const services = open(home);

        const receipt = await services.cloud.start({
            workbench: 'acme/reviewer',
            task: 'Review this',
            project: 'local-demo',
        });

        expect(requests).toHaveLength(2);
        expect(requests[1]).toMatchObject({
            path: '/v1/runs',
            body: { project: 'local-demo' },
        });
        expect(services.cloudSessions.bySession(receipt.session_id)).toMatchObject({
            project: 'Local Demo',
            organization: 'acme',
        });
    });
});

async function temporaryHome(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'workbench-cloud-test-'));
    homes.push(home);
    return home;
}

async function fakeLogin(home: string): Promise<void> {
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

function cloudRun(): Record<string, unknown> {
    return {
        id: 'wb_cloudrun1234567890123456',
        session_id: 'wbs_cloudsession',
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
        status: 'queued',
        task: 'Review this',
        executor: 'test',
        final_response: null,
        terminal_reason: null,
        usage: null,
        outcome_size: null,
        idempotency_key: 'test-key',
        created_at: '2026-10-13T12:00:00.000Z',
        started_at: null,
        completed_at: null,
        updated_at: '2026-10-13T12:00:00.000Z',
    };
}

function cloudProject(): Record<string, unknown> {
    return {
        name: 'Cloud Demo',
        slug: 'cloud-demo',
        counts: { needs_you: 0, running: 0, done: 0, failed: 0 },
        updated_at: '2026-10-13T12:00:00.000Z',
        now: [],
        waiting: [],
        latest_done: null,
        today: { runs: 0, tokens: 0, cost_usd: null },
    };
}
