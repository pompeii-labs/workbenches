import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Connection } from '../src/database/connection.js';
import { ProjectRecordStore } from '../src/database/projects.js';
import { RegistryAccountStore } from '../src/registry/account-store.js';
import { RegistryClient } from '../src/registry/client.js';
import { Services } from '../src/workbench/services.js';

const homes: string[] = [];
const servers: Bun.Server<undefined>[] = [];
const connections: Connection[] = [];
const cli = join(import.meta.dir, '..', 'src', 'cli.ts');

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

describe('projects', () => {
    test('create, list, resolve slugs, and reject case-insensitive duplicates', async () => {
        const home = await temporaryHome();
        const store = open(home).projects;

        const first = await store.create('  Pixel Pirate  ');
        const second = await store.create('Harbor Watch');

        expect(first).toMatchObject({ name: 'Pixel Pirate', slug: 'pixel-pirate' });
        expect((await store.list()).map((project) => project.name)).toEqual([
            'Harbor Watch',
            'Pixel Pirate',
        ]);
        expect(await store.resolve('PIXEL-PIRATE')).toEqual(first);
        expect(await store.resolve('pixel pirate')).toEqual(first);
        await expect(store.create('pixel pirate')).rejects.toThrow(
            'Project already exists: Pixel Pirate'
        );
        await expect(store.create('Pixel--Pirate')).rejects.toThrow(
            'Project already exists: Pixel Pirate'
        );
        expect(second.created_at >= first.created_at).toBeTrue();
    });

    test('validates names and suggests a close existing project', async () => {
        const home = await temporaryHome();
        const store = open(home).projects;
        await store.create('Pixel Pirate');

        await expect(store.create('')).rejects.toThrow('Project name cannot be empty');
        await expect(store.create('x'.repeat(65))).rejects.toThrow(
            'Project name cannot be longer than 64 characters'
        );
        await expect(store.create('bad\u0000name')).rejects.toThrow(
            'Project name cannot contain control characters'
        );
        await expect(store.resolve('Pixel Pirates')).rejects.toThrow(
            'No project "Pixel Pirates". Did you mean "Pixel Pirate"?\n' +
                'Create it with: wb project create "Pixel Pirates"'
        );
        await expect(store.resolve('Unrelated')).rejects.toThrow(
            'No project "Unrelated".\nCreate it with: wb project create "Unrelated"'
        );
    });

    test('keeps names unique per owner and reads a session project by join', async () => {
        const home = await temporaryHome();
        const { connection, sessions } = open(home);
        const records = new ProjectRecordStore(connection);
        records.insert(
            'Pixel: Pirate',
            'pixel-pirate',
            null,
            '2026-10-01T00:00:00.000Z'
        );
        records.insert(
            'Pixel: Pirate',
            'pixel-pirate',
            'acme',
            '2026-10-03T00:00:00.000Z'
        );
        records.insert(
            'Pixel: Pirate',
            'pixel-pirate',
            'other',
            '2026-10-03T00:00:00.000Z'
        );
        expect(() =>
            records.insert(
                'PIXEL: PIRATE',
                'different',
                'acme',
                '2026-10-03T00:00:00.000Z'
            )
        ).toThrow();
        expect(() =>
            records.insert(
                'Different',
                'PIXEL-PIRATE',
                null,
                '2026-10-03T00:00:00.000Z'
            )
        ).toThrow();
        const local = records.find('pixel: pirate', 'pixel-pirate', null, false);
        if (!local) throw new Error('Missing local project');

        await sessions.create({
            id: 'wb_123456789012345678901234',
            project: local,
            workbench: 'fixture',
            workbench_version: '1.0.0',
            runner: 'opencode',
            model: 'openai/test',
            reference: 'fixture',
            workbench_path: '/fixture',
            workspace: '/workspace',
            workspaces: [],
            latest_run_id: 'wb_123456789012345678901234',
        });

        expect(
            connection.one(
                'SELECT project_id FROM sessions WHERE id = ?',
                'wb_123456789012345678901234'
            )
        ).toEqual({ project_id: local.id });
        expect((await sessions.read('wb_123456789012345678901234')).project).toBe(
            'Pixel: Pirate'
        );
    });

    test('creates, lists, and refreshes a missing project through the cloud', async () => {
        const home = await temporaryHome();
        const cloud = fakeProjectsApi();
        await fakeLogin(home, cloud.url);
        const store = open(home).projects;

        const created = await store.create('Pixel Pirate');
        cloud.projects.push(project('Harbor Watch'));

        expect(created).toMatchObject({
            name: 'Pixel Pirate',
            slug: 'pixel-pirate',
            organization: 'acme',
        });
        expect((await store.list()).map((item) => item.name)).toEqual([
            'Pixel Pirate',
            'Harbor Watch',
        ]);
        cloud.projects.push(project('Lantern Bay'));
        expect(await store.resolve('lantern-bay')).toMatchObject({
            name: 'Lantern Bay',
            organization: 'acme',
        });
        expect(
            cloud.requests.filter((request) => request.method === 'GET')
        ).toHaveLength(2);
    });

    test('falls back to mirrored cloud projects and explains offline creation', async () => {
        const home = await temporaryHome();
        const cloud = fakeProjectsApi();
        await fakeLogin(home, cloud.url);
        const store = open(home).projects;
        await store.create('Pixel Pirate');
        await store.list();
        cloud.server.stop(true);
        servers.splice(servers.indexOf(cloud.server), 1);

        expect((await store.list()).map((item) => item.name)).toEqual(['Pixel Pirate']);
        await expect(store.create('Offline Project')).rejects.toThrow(
            'Could not reach Workbenches to create the project. Try again, or log out to work locally.'
        );
    });

    test('merges local projects once in creation order and accepts a conflict', async () => {
        const home = await temporaryHome();
        const local = open(home);
        const first = await local.projects.create('First Local');
        await local.projects.create('Existing Cloud');
        await local.sessions.create({
            id: 'wb_localprojectsession12345678',
            project: first,
            workbench: 'fixture',
            workbench_version: '1.0.0',
            runner: 'opencode',
            model: 'openai/test',
            reference: 'fixture',
            workbench_path: '/fixture',
            workspace: '/workspace',
            workspaces: [],
            latest_run_id: 'wb_localprojectsession12345678',
        });
        const cloud = fakeProjectsApi([project('Existing Cloud')]);
        await fakeLogin(home, cloud.url);
        const { projects: store, connection } = open(home);

        await store.list();
        await store.resolve('first-local');

        expect(
            cloud.requests
                .filter((request) => request.method === 'POST')
                .map((request) => request.name)
        ).toEqual(['First Local', 'Existing Cloud']);
        expect(
            connection.all('SELECT name, organization FROM projects ORDER BY id')
        ).toEqual([
            { name: 'First Local', organization: 'acme' },
            { name: 'Existing Cloud', organization: 'acme' },
        ]);
        expect(
            connection.one(
                'SELECT organization FROM project_merges WHERE organization = ?',
                'acme'
            )
        ).toEqual({ organization: 'acme' });
        expect(
            connection.one(
                'SELECT project_id FROM sessions WHERE id = ?',
                'wb_localprojectsession12345678'
            )
        ).toEqual({ project_id: first.id });
    });

    test('uses local projects when the cloud project routes are unsupported', async () => {
        const home = await temporaryHome();
        await open(home).projects.create('Local Project');
        const cloud = fakeProjectsApi([], false);
        await fakeLogin(home, cloud.url);
        const { projects: store, connection } = open(home);

        const beforeList = cloud.requests.length;
        expect((await store.list()).map((item) => item.name)).toEqual([
            'Local Project',
        ]);
        expect(cloud.requests.length - beforeList).toBe(1);

        const beforeCreate = cloud.requests.length;
        expect(await store.create('Second Local')).toMatchObject({
            name: 'Second Local',
            organization: null,
        });
        expect(cloud.requests.length - beforeCreate).toBe(1);

        const beforeResolve = cloud.requests.length;
        expect(await store.resolve('local-project')).toMatchObject({
            name: 'Local Project',
            organization: null,
        });
        expect(cloud.requests.length - beforeResolve).toBe(1);
        expect(
            connection.one(
                'SELECT organization FROM project_merges WHERE organization = ?',
                'acme'
            )
        ).toBeUndefined();

        cloud.setSupported(true);
        expect((await store.list()).map((item) => item.name)).toEqual([
            'Local Project',
            'Second Local',
        ]);
        expect(
            connection.one(
                'SELECT organization FROM project_merges WHERE organization = ?',
                'acme'
            )
        ).toEqual({ organization: 'acme' });

        cloud.setSupported(false);
        const beforeMirroredResolve = cloud.requests.length;
        await expect(store.resolve('local-project')).rejects.toThrow(
            'No project "local-project"'
        );
        expect(cloud.requests.length - beforeMirroredResolve).toBe(1);
    });

    test('creates and lists projects through the CLI as JSON', async () => {
        const home = await temporaryHome();

        const created = await runCli(home, [
            'project',
            'create',
            'Pixel Pirate',
            '--json',
        ]);
        const listed = await runCli(home, ['project', 'list', '--json']);
        const duplicate = await runCli(home, ['project', 'create', 'PIXEL PIRATE']);

        expect(created.code).toBe(0);
        expect(JSON.parse(created.stdout)).toMatchObject({
            project: { name: 'Pixel Pirate', slug: 'pixel-pirate' },
        });
        expect(JSON.parse(listed.stdout)).toEqual({
            projects: [
                {
                    name: 'Pixel Pirate',
                    slug: 'pixel-pirate',
                    counts: { needs_you: 0, running: 0, done: 0, failed: 0 },
                    created_at: expect.any(String),
                },
            ],
        });
        expect(duplicate.code).toBe(1);
        expect(duplicate.stderr).toContain('Project already exists: Pixel Pirate');
    });
});

async function temporaryHome(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'workbench-projects-'));
    homes.push(home);
    return home;
}

function fakeProjectsApi(
    initial: Record<string, unknown>[] = [],
    initiallySupported = true
) {
    const projects = [...initial];
    const requests: Array<{ method: string; name?: string }> = [];
    let supported = initiallySupported;
    const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
            const url = new URL(request.url);
            if (url.pathname !== '/v1/projects')
                return new Response(null, { status: 404 });
            expect(request.headers.get('authorization')).toBe('Bearer placeholder-key');
            if (!supported) {
                requests.push({ method: request.method });
                return Response.json(
                    { error: { message: 'Project routes are not available' } },
                    { status: 404 }
                );
            }
            if (request.method === 'GET') {
                requests.push({ method: 'GET' });
                return Response.json({ projects });
            }
            const value: unknown = await request.json();
            const name = projectName(value);
            requests.push({ method: 'POST', name });
            if (projects.some((item) => item.name === name))
                return Response.json(
                    { error: { message: `Project already exists: ${name}` } },
                    { status: 409 }
                );
            const created = project(name);
            projects.push(created);
            return Response.json(created, { status: 201 });
        },
    });
    servers.push(server);
    const url = `http://127.0.0.1:${server.port}`;
    return {
        server,
        url,
        projects,
        requests,
        setSupported(value: boolean) {
            supported = value;
        },
    };
}

async function fakeLogin(home: string, url: string): Promise<void> {
    RegistryClient.configureApiUrl(url);
    await new RegistryAccountStore({ home }).save(
        {
            organizationId: '00000000-0000-4000-8000-000000000001',
            slug: 'acme',
            name: 'Acme',
            personal: false,
            token: 'placeholder-key',
            keyId: '00000000-0000-4000-8000-000000000002',
            scopes: ['projects:read', 'projects:write'],
            expiresAt: '2099-01-01T00:00:00.000Z',
        },
        { makeDefault: true }
    );
}

function projectName(value: unknown): string {
    if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        !('name' in value) ||
        typeof value.name !== 'string'
    )
        throw new Error('Invalid project request');
    return value.name;
}

function project(name: string): Record<string, unknown> {
    return {
        name,
        slug: name.toLowerCase().replaceAll(' ', '-'),
        counts: { needs_you: 0, running: 0, done: 0, failed: 0 },
        updated_at: '2026-10-13T12:00:00.000Z',
        now: [],
        waiting: [],
        latest_done: null,
        today: { runs: 0, tokens: 0, cost_usd: null },
    };
}

async function runCli(home: string, args: string[]) {
    const child = Bun.spawn([process.execPath, cli, ...args], {
        env: { ...process.env, WORKBENCH_HOME: home },
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
