import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AuthoringOperation } from '../src/authoring/index.js';
import { SavedWorkbenchCatalog, WorkbenchPackage } from '../src/catalog/index.js';
import { RegistryAccountStore, RegistryClient } from '../src/registry/index.js';
import { RunDispatcher, RunStore } from '../src/runs/index.js';
import { SessionResolver, SessionStore } from '../src/sessions/index.js';
import { Workbench, WorkbenchResolver } from '../src/workbench/index.js';
import { seedModelCatalogFixture } from './model-catalog-fixture.js';

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(
        roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
});

describe('saved-source contract', () => {
    test('verified authoring preserves a live alias and reports collisions without failing the package', async () => {
        const { root, home, path } = await fixture();
        const catalog = new SavedWorkbenchCatalog(home);
        await catalog.addLocal({
            alias: 'custom-expert',
            workbench: await Workbench.load(path),
        });
        const creator = {
            version: '0.1.4',
            digest: `sha256:${'b'.repeat(64)}`,
            registry_version_id: 'fixture-version',
            cached: true,
        };
        const operation = await AuthoringOperation.prepare(
            home,
            {
                id: 'author_alias',
                kind: 'improve',
                repository: root,
                targetSelector: 'core',
                creator,
            },
            async () => {}
        );
        const manifestPath = join(path, 'workbench.yml');
        await writeFile(
            manifestPath,
            (await readFile(manifestPath, 'utf8')).replace('0.1.0', '0.1.1')
        );
        expect(await operation.finish()).toMatchObject({ status: 'completed' });
        expect(await catalog.list()).toMatchObject([
            { alias: 'custom-expert', localPath: path, version: '0.1.1' },
        ]);
        const other = await fixture();
        await catalog.addLocal({
            alias: 'expert',
            workbench: await Workbench.load(other.path),
        });
        await catalog.remove('custom-expert');
        const collision = await AuthoringOperation.prepare(
            home,
            {
                id: 'author_collision',
                kind: 'improve',
                repository: root,
                targetSelector: 'core',
                creator,
            },
            async () => {}
        );
        await writeFile(
            manifestPath,
            (await readFile(manifestPath, 'utf8')).replace('0.1.1', '0.1.2')
        );
        const result = await collision.finish();
        expect(result.status).toBe('completed');
        expect(result.warnings?.[0]).toContain(path);
        expect(result.warnings?.[0]).toContain('--as <alias>');
        expect((await catalog.find('expert'))?.localPath).toBe(other.path);
    });

    test('legacy frozen sessions retain their exact original catalog package after alias removal', async () => {
        const { root, home, path } = await fixture();
        const catalog = new SavedWorkbenchCatalog(home);
        const entry = await catalog.add({
            alias: 'expert',
            source: root,
            workbench: await Workbench.load(path),
        });
        const id = RunStore.createId();
        await new SessionStore(home).create({
            id,
            workbench: 'expert',
            workbench_version: '0.1.0',
            runner: 'opencode',
            model: 'openai/gpt-5.6-terra',
            runtime: 'local',
            reference: 'expert',
            workbench_path: entry.packagePath,
            workbench_digest: entry.digest,
            workspace: root,
            workspaces: [],
            latest_run_id: id,
            native_session_id: 'legacy-native',
        });
        await catalog.remove('expert');
        const resumed = await new SessionResolver(home).resolve(id);
        expect(resumed.resolved.workbench.packageDirectory).toBe(entry.packagePath);
        expect(
            await readFile(resumed.resolved.workbench.instructionsPath, 'utf8')
        ).toBe('Original instructions');
        await rm(entry.packagePath, { recursive: true });
        await catalog.addLocal({
            alias: 'expert',
            workbench: await Workbench.load(path),
        });
        await expect(new SessionResolver(home).resolve(id)).rejects.toThrow();
    });

    test('local add is live, idempotent, absolute, and never deletes the source', async () => {
        const { root, home, path } = await fixture();
        const first = await cli(
            home,
            ['add', './.workbenches/core', '--as', 'expert'],
            root
        );
        expect(first.code).toBe(0);
        const catalog = new SavedWorkbenchCatalog(home);
        expect(await catalog.find('expert')).toMatchObject({
            localPath: path,
            packagePath: path,
        });
        expect(
            (await cli(home, ['add', './.workbenches/core', '--as', 'expert'], root))
                .code
        ).toBe(0);
        await writeFile(join(path, 'instructions.md'), 'Edited instructions');
        const resolved = await new WorkbenchResolver().resolve('expert', {
            home,
            savedOnly: true,
            cwd: root,
        });
        expect(await readFile(resolved.workbench.instructionsPath, 'utf8')).toBe(
            'Edited instructions'
        );
        expect(resolved.workspaceDirectory).toBe(root);
        expect((await cli(home, ['remove', 'expert'], root)).code).toBe(0);
        expect(await readFile(join(path, 'instructions.md'), 'utf8')).toBe(
            'Edited instructions'
        );
    });

    test('local collisions require --as and multi-package input lists --name choices', async () => {
        const { root, home, path } = await fixture();
        const second = await packageAt(root, 'other', 'expert');
        const ambiguous = await cli(home, ['add', '.'], root);
        expect(ambiguous.code).toBe(1);
        expect(ambiguous.stderr).toContain('--name');
        expect(ambiguous.stderr).toContain('core, other');
        expect((await cli(home, ['add', '.', '--name', 'core'], root)).code).toBe(0);
        expect((await new SavedWorkbenchCatalog(home).find('expert'))?.localPath).toBe(
            path
        );
        expect((await cli(home, ['add', second, '--as', 'second'], root)).code).toBe(0);
        expect((await cli(home, ['add', '.#core'], root)).stderr).toContain(
            'Use --name'
        );
    });

    test('run rejects unsaved local sources and registry misses never become GitHub lookups', async () => {
        const { root, home, path } = await fixture();
        const unsaved = await cli(
            home,
            ['run', path, '--task', 'inspect', '--dry-run'],
            root
        );
        expect(unsaved.code).toBe(1);
        expect(unsaved.stderr).toContain('Workbench is not saved');
        const requests: string[] = [];
        const server = Bun.serve({
            port: 0,
            hostname: '127.0.0.1',
            fetch(request) {
                requests.push(new URL(request.url).pathname);
                return new Response('missing', { status: 404 });
            },
        });
        try {
            const missing = await cli(
                home,
                ['add', 'missing/package', '--api-url', server.url.origin],
                root
            );
            expect(missing.code).toBe(1);
            expect(missing.stderr).toContain('Registry Workbench does not exist');
            expect(missing.stderr).not.toContain('GitHub');
            expect(requests).toEqual(['/v1/resolutions']);
        } finally {
            server.stop(true);
        }
    });

    test('each session owns package bytes through edits, removal, and deleted local sources', async () => {
        const { root, home, path } = await fixture();
        const catalog = new SavedWorkbenchCatalog(home);
        await catalog.addLocal({ workbench: await Workbench.load(path) });
        await writeFile(join(root, 'workspace-only.txt'), 'Never package me');
        const resolver = new WorkbenchResolver();
        const dispatcher = new RunDispatcher(home);
        const first = await dispatcher.prepare({
            resolved: await resolver.resolve('expert', {
                home,
                savedOnly: true,
                cwd: root,
            }),
            mode: 'interactive',
        });
        const sessions = new SessionStore(home);
        const saved = await sessions.update(first.id, {
            native_session_id: 'native-fixture',
        });
        expect(saved.workbench_path).toStartWith(join(home, 'sessions', first.id));
        expect(saved.source_workbench_path).toBe(path);
        expect(saved.workspace).toBe(root);
        expect(
            await readFile(join(saved.workbench_path, 'instructions.md'), 'utf8')
        ).toBe('Original instructions');
        expect(
            await Bun.file(join(saved.workbench_path, 'workspace-only.txt')).exists()
        ).toBeFalse();
        await writeFile(join(path, 'instructions.md'), 'Edited instructions');
        const next = await dispatcher.prepare({
            resolved: await resolver.resolve('expert', {
                home,
                savedOnly: true,
                cwd: root,
            }),
            mode: 'foreground',
            task: 'next',
        });
        const nextSession = await sessions.read(next.id);
        expect(
            await readFile(join(nextSession.workbench_path, 'instructions.md'), 'utf8')
        ).toBe('Edited instructions');
        await catalog.remove('expert');
        await rm(path, { recursive: true });
        const original = await new SessionResolver(home).resolve(first.id);
        expect(
            await readFile(original.resolved.workbench.instructionsPath, 'utf8')
        ).toBe('Original instructions');
        const resumed = await dispatcher.prepare({
            resolved: original.resolved,
            session: original.session,
            mode: 'interactive',
        });
        expect((await new RunStore(home).takeRequest(resumed.id)).workbench_path).toBe(
            saved.workbench_path
        );
        expect(await readFile(join(root, 'workspace-only.txt'), 'utf8')).toBe(
            'Never package me'
        );
    });

    test('remote additions are idempotent, require explicit upgrade, and preserve session bytes', async () => {
        const { root, home, path } = await fixture();
        const workbench = await Workbench.load(path);
        const remote = {
            source: 'https://github.com/example/project',
            revision: 'a'.repeat(40),
            selector: 'core',
            manifest: workbench.manifest,
            files: await new WorkbenchPackage(workbench).files(),
        };
        const catalog = new SavedWorkbenchCatalog(home);
        const entry = await catalog.addRemote({ alias: 'expert', workbench: remote });
        expect(await catalog.addRemote({ alias: 'expert', workbench: remote })).toEqual(
            entry
        );
        const dispatcher = new RunDispatcher(home);
        const run = await dispatcher.prepare({
            resolved: await new WorkbenchResolver().resolve('expert', {
                home,
                savedOnly: true,
                cwd: root,
            }),
            mode: 'interactive',
        });
        await new SessionStore(home).update(run.id, {
            native_session_id: 'native-fixture',
        });
        await writeFile(join(path, 'instructions.md'), 'Remote upgrade');
        const changed = {
            ...remote,
            revision: 'b'.repeat(40),
            files: await new WorkbenchPackage(workbench).files(),
        };
        await expect(
            catalog.addRemote({ alias: 'expert', workbench: changed })
        ).rejects.toThrow('wb upgrade expert');
        await expect(
            catalog.addRemote({
                alias: 'expert',
                workbench: { ...remote, source: 'https://github.com/other/project' },
            })
        ).rejects.toThrow('--as');
        await catalog.upgrade('expert', changed);
        await catalog.remove('expert');
        const resumed = await new SessionResolver(home).resolve(run.id);
        expect(
            await readFile(resumed.resolved.workbench.instructionsPath, 'utf8')
        ).toBe('Original instructions');
    });

    test('publish submits saved current bytes and reports pending review without claiming a release', async () => {
        const { root, home, path } = await fixture('repo-engineer');
        await new SavedWorkbenchCatalog(home).addLocal({
            alias: 'local-expert',
            workbench: await Workbench.load(path),
        });
        await writeFile(join(path, 'instructions.md'), 'Current publication bytes');
        const files = await new WorkbenchPackage(await Workbench.load(path)).files();
        const digest = WorkbenchPackage.digest(files).slice('sha256:'.length);
        const requests: string[] = [];
        let submitted: unknown;
        const server = Bun.serve({
            port: 0,
            hostname: '127.0.0.1',
            async fetch(request) {
                const pathname = new URL(request.url).pathname;
                requests.push(pathname);
                if (pathname === '/v1/profile')
                    return Response.json({
                        user: { id: 'user', email: 'fixture@example.test' },
                        publishers: [
                            { id: 'publisher-id', slug: 'example', name: 'Example' },
                        ],
                    });
                if (pathname === '/v1/submissions') {
                    submitted = await request.json();
                    return Response.json({
                        submissions: [
                            {
                                id: 'submission-id',
                                status: 'pending',
                                publisher_slug: 'example',
                                slug: 'repo-engineer',
                                version: '0.1.0',
                                digest,
                                dashboard_url:
                                    'https://registry.example/submissions/submission-id',
                                latest_approved_version: '0.0.1',
                            },
                        ],
                    });
                }
                return new Response('unexpected', { status: 500 });
            },
        });
        try {
            await new RegistryAccountStore({
                home,
                client: new RegistryClient({ apiUrl: server.url.origin }),
            }).save({
                url: server.url.origin,
                token: 'fixture-token',
                tokenId: 'token-id',
                email: 'fixture@example.test',
                expiresAt: '2099-01-01T00:00:00Z',
            });
            const result = await cli(
                home,
                ['publish', 'local-expert', '--api-url', server.url.origin],
                root
            );
            expect(result.code).toBe(0);
            expect(result.stdout).toContain('submitted\texample/repo-engineer\t0.1.0');
            expect(result.stdout).toContain('pending');
            expect(result.stdout).toContain(
                'https://registry.example/submissions/submission-id'
            );
            expect(result.stdout).not.toContain('published\t');
            expect(requests).toEqual(['/v1/profile', '/v1/submissions']);
            expect(submitted).toMatchObject({
                organization_id: 'publisher-id',
                slug: 'repo-engineer',
                package: {
                    format: 1,
                    files: expect.arrayContaining([
                        {
                            path: 'instructions.md',
                            content: Buffer.from('Current publication bytes').toString(
                                'base64'
                            ),
                            executable: false,
                        },
                    ]),
                },
            });
        } finally {
            server.stop(true);
        }
    });

    test('publish requires a local registry login before calling the API', async () => {
        const { root, home, path } = await fixture('repo-engineer');
        await new SavedWorkbenchCatalog(home).addLocal({
            alias: 'local-expert',
            workbench: await Workbench.load(path),
        });
        const result = await cli(
            home,
            ['publish', 'local-expert', '--api-url', 'http://127.0.0.1:57499'],
            root
        );
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('Sign in first with wb login');
    });

    test('publish requires an explicit publisher when more than one is available', async () => {
        const { root, home, path } = await fixture('repo-engineer');
        await new SavedWorkbenchCatalog(home).addLocal({
            alias: 'local-expert',
            workbench: await Workbench.load(path),
        });
        const requests: string[] = [];
        let submitted: unknown;
        const server = Bun.serve({
            port: 0,
            hostname: '127.0.0.1',
            async fetch(request) {
                const pathname = new URL(request.url).pathname;
                requests.push(pathname);
                if (pathname === '/v1/profile')
                    return Response.json({
                        user: { id: 'user', email: 'fixture@example.test' },
                        publishers: [
                            { id: 'first-id', slug: 'first', name: 'First' },
                            { id: 'second-id', slug: 'second', name: 'Second' },
                        ],
                    });
                if (pathname === '/v1/submissions') {
                    submitted = await request.json();
                    return Response.json({
                        submissions: [
                            {
                                id: 'submission-id',
                                status: 'pending',
                                publisher_slug: 'second',
                                slug: 'repo-engineer',
                                version: '0.1.0',
                                digest: WorkbenchPackage.digest(
                                    await new WorkbenchPackage(
                                        await Workbench.load(path)
                                    ).files()
                                ).slice('sha256:'.length),
                                dashboard_url:
                                    'https://registry.example/submissions/submission-id',
                                latest_approved_version: null,
                            },
                        ],
                    });
                }
                return new Response('unexpected', { status: 500 });
            },
        });
        try {
            await new RegistryAccountStore({
                home,
                client: new RegistryClient({ apiUrl: server.url.origin }),
            }).save({
                url: server.url.origin,
                token: 'fixture-token',
                tokenId: 'token-id',
                email: 'fixture@example.test',
                expiresAt: '2099-01-01T00:00:00Z',
            });
            const ambiguous = await cli(
                home,
                ['publish', 'local-expert', '--api-url', server.url.origin],
                root
            );
            expect(ambiguous.code).toBe(1);
            expect(ambiguous.stderr).toContain('Choose a publisher with --publisher');
            expect(requests).toEqual(['/v1/profile']);

            const selected = await cli(
                home,
                [
                    'publish',
                    'local-expert',
                    '--publisher',
                    'second',
                    '--api-url',
                    server.url.origin,
                ],
                root
            );
            expect(selected.code).toBe(0);
            expect(selected.stdout).toContain('submitted\tsecond/repo-engineer\t0.1.0');
            expect(submitted).toMatchObject({
                organization_id: 'second-id',
                slug: 'repo-engineer',
            });
        } finally {
            server.stop(true);
        }
    });
});

async function fixture(name = 'expert') {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'acquisition-')));
    roots.push(root);
    const home = join(root, 'home');
    await mkdir(home);
    return { root, home, path: await packageAt(root, 'core', name) };
}

async function packageAt(root: string, selector: string, name: string) {
    const path = join(root, '.workbenches', selector);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'instructions.md'), 'Original instructions');
    await writeFile(
        join(path, 'workbench.yml'),
        Bun.YAML.stringify({
            spec: 0,
            version: '0.1.0',
            name,
            runner: 'opencode',
            model: { id: 'openai/gpt-5.6-terra' },
            instructions: './instructions.md',
            skills: [],
            tools: [],
            mcps: [],
            env: {},
            runtime: 'local',
        })
    );
    return path;
}

async function cli(home: string, args: string[], cwd: string) {
    await seedModelCatalogFixture(home);
    const child = Bun.spawn(
        [process.execPath, resolve(import.meta.dir, '../src/cli.ts'), ...args],
        {
            cwd,
            env: { ...process.env, WORKBENCH_HOME: home },
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
        }
    );
    const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
}
