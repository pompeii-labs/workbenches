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
    for (const connection of connections.splice(0)) connection.close();
    await Promise.all(
        homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))
    );
});

function open(home: string) {
    const connection = Connection.open(home);
    connections.push(connection);
    return Object.assign(new Services(home, connection), { connection });
}

describe('projects', () => {
    test('create, list, resolve slugs, and reject case-insensitive duplicates', async () => {
        const home = await temporaryHome();
        const store = open(home).projects;

        const first = store.create('  Pixel Pirate  ');
        const second = store.create('Harbor Watch');

        expect(first).toMatchObject({ name: 'Pixel Pirate', slug: 'pixel-pirate' });
        expect(store.list().map((project) => project.name)).toEqual([
            'Harbor Watch',
            'Pixel Pirate',
        ]);
        expect(store.resolve('PIXEL-PIRATE')).toEqual(first);
        expect(store.resolve('pixel pirate')).toEqual(first);
        expect(() => store.create('pixel pirate')).toThrow(
            'Project already exists: Pixel Pirate'
        );
        expect(() => store.create('Pixel--Pirate')).toThrow(
            'Project already exists: Pixel Pirate'
        );
        expect(second.created_at >= first.created_at).toBeTrue();
    });

    test('validates names and suggests a close existing project', async () => {
        const home = await temporaryHome();
        const store = open(home).projects;
        store.create('Pixel Pirate');

        expect(() => store.create('')).toThrow('Project name cannot be empty');
        expect(() => store.create('x'.repeat(65))).toThrow(
            'Project name cannot be longer than 64 characters'
        );
        expect(() => store.create('bad\u0000name')).toThrow(
            'Project name cannot contain control characters'
        );
        expect(() => store.resolve('Pixel Pirates')).toThrow(
            'No project "Pixel Pirates". Did you mean "Pixel Pirate"?\n' +
                'Create it with: wb project create "Pixel Pirates"'
        );
        expect(() => store.resolve('Unrelated')).toThrow(
            'No project "Unrelated".\nCreate it with: wb project create "Unrelated"'
        );
    });

    test('keeps names and slugs unique and reads a session project by join', async () => {
        const home = await temporaryHome();
        const { connection, sessions } = open(home);
        const records = new ProjectRecordStore(connection);
        records.insert('Pixel: Pirate', 'pixel-pirate', '2026-10-01T00:00:00.000Z');
        expect(() =>
            records.insert('PIXEL: PIRATE', 'different', '2026-10-03T00:00:00.000Z')
        ).toThrow();
        expect(() =>
            records.insert('Different', 'PIXEL-PIRATE', '2026-10-03T00:00:00.000Z')
        ).toThrow();
        const project = records.find('pixel: pirate', 'pixel-pirate');
        if (!project) throw new Error('Missing project');

        await sessions.create({
            id: 'wb_123456789012345678901234',
            project,
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
        ).toEqual({ project_id: project.id });
        expect((await sessions.read('wb_123456789012345678901234')).project).toBe(
            'Pixel: Pirate'
        );
    });

    test('stays local and makes no request when logged in', async () => {
        const home = await temporaryHome();
        const requests: string[] = [];
        const api = Bun.serve({
            hostname: '127.0.0.1',
            port: 0,
            fetch(request) {
                requests.push(new URL(request.url).pathname);
                return Response.json({ projects: [] });
            },
        });
        servers.push(api);
        const apiUrl = `http://127.0.0.1:${api.port}`;
        await new RegistryAccountStore({
            home,
            client: new RegistryClient({ home, apiUrl }),
        }).save(
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

        const created = await runCli(home, [
            'project',
            'create',
            'Pixel Pirate',
            '--api-url',
            apiUrl,
        ]);
        const listed = await runCli(home, [
            'project',
            'list',
            '--json',
            '--api-url',
            apiUrl,
        ]);

        expect(created.code).toBe(0);
        expect(listed.code).toBe(0);
        expect(
            (
                JSON.parse(listed.stdout) as { projects: { name: string }[] }
            ).projects.map((project) => project.name)
        ).toEqual(['Pixel Pirate']);
        expect(requests).toEqual([]);
        expect(open(home).connection.all('SELECT name, slug FROM projects')).toEqual([
            { name: 'Pixel Pirate', slug: 'pixel-pirate' },
        ]);
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
