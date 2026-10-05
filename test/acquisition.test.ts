import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AuthoringOperation } from '../src/authoring/index.js';
import { SavedWorkbenchCatalog, WorkbenchPackage } from '../src/catalog/index.js';
import { CliPresenter } from '../src/commands/presenter.js';
import { presentPushed } from '../src/commands/push.js';
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

    test('org list, use, whoami, and logout manage held organizations', async () => {
        const { root, home } = await fixture();
        const deleted: string[] = [];
        const server = Bun.serve({
            port: 0,
            hostname: '127.0.0.1',
            fetch(request) {
                const url = new URL(request.url);
                if (request.method === 'DELETE') {
                    deleted.push(url.pathname);
                    return Response.json({ ok: true });
                }
                const slug = request.headers
                    .get('authorization')
                    ?.slice('Bearer wb_'.length);
                return Response.json({
                    organization: {
                        id: `${slug}-id`,
                        slug,
                        name: slug,
                        personal: false,
                    },
                    user: { id: 'user-1', email: 'person@example.test' },
                    scopes: ['catalog:read', 'packages:write'],
                    key: {
                        id: `${slug}-key`,
                        label: null,
                        expires_at: '2099-01-01T00:00:00Z',
                    },
                });
            },
        });
        try {
            const accounts = new RegistryAccountStore({
                home,
                client: new RegistryClient({ apiUrl: server.url.origin }),
            });
            await accounts.save(orgKey('first'));
            await accounts.save(orgKey('second'));
            const api = ['--api-url', server.url.origin];

            const listed = await cli(home, ['org', 'list', ...api], root);
            expect(listed.stdout).toContain('org\tfirst\tdefault');
            expect(listed.stdout).toContain('org\tsecond\t\t');
            expect((await cli(home, ['org', 'use', 'second', ...api], root)).code).toBe(
                0
            );
            expect((await cli(home, ['org', 'use', 'nope', ...api], root)).code).toBe(
                1
            );

            const who = await cli(home, ['whoami', ...api], root);
            expect(who.code).toBe(0);
            const text = `${who.stdout}${who.stderr}`;
            expect(text).toContain('second');
            expect(text).toContain('person@example.test');
            expect(text).toContain('catalog:read, packages:write');
            expect(text).toContain('first');

            const out = await cli(home, ['logout', ...api], root);
            expect(out.code).toBe(0);
            expect(deleted).toEqual(['/v1/keys/second-key']);
            expect((await accounts.list()).defaultSlug).toBe('first');
            await cli(home, ['logout', '--org', 'first', ...api], root);
            expect(deleted).toEqual(['/v1/keys/second-key', '/v1/keys/first-key']);
            expect((await accounts.list()).organizations).toEqual([]);
        } finally {
            server.stop(true);
        }
    });
});

describe('private organization workbenches', () => {
    test('add saves an internal workbench with the matching key and records visibility', async () => {
        const { root, home, path } = await fixture('repo-engineer');
        const registry = await privateRegistry(path);
        try {
            await hold(home, registry.server.url.origin, ['other', 'example']);
            const api = ['--api-url', registry.server.url.origin];

            const added = await cli(
                home,
                ['add', 'example/repo-engineer', ...api],
                root
            );
            expect(added.code).toBe(0);
            expect(added.stdout).toContain('saved\trepo-engineer');
            expect(registry.seen).toEqual([
                { path: '/v1/resolutions', authorization: 'Bearer wb_example' },
                { path: '/v1/artifacts/version', authorization: 'Bearer wb_example' },
            ]);

            const entry = await new SavedWorkbenchCatalog(home).find('repo-engineer');
            expect(entry?.registry?.visibility).toBe('private');
            const listed = await cli(home, ['list', '--saved'], root);
            expect(listed.stdout).toMatch(/^repo-engineer\t.*\tinternal$/m);
            expect(listed.stdout).not.toContain('private');
            const viewed = await cli(home, ['view', 'repo-engineer', '--json'], root);
            expect(JSON.parse(viewed.stdout).origin.visibility).toBe('private');
            const rendered = await cli(home, ['view', 'repo-engineer'], root);
            expect(rendered.stdout).toMatch(/^Visibility\s+internal$/m);

            registry.seen.length = 0;
            const upgraded = await cli(
                home,
                ['upgrade', 'repo-engineer', ...api],
                root
            );
            expect(upgraded.code).toBe(0);
            expect(registry.seen.map((request) => request.authorization)).toEqual([
                'Bearer wb_example',
                'Bearer wb_example',
            ]);
        } finally {
            registry.server.stop(true);
        }
    });

    test('add without the organization key fails with a sign-in hint', async () => {
        const { root, home, path } = await fixture('repo-engineer');
        const registry = await privateRegistry(path);
        try {
            const api = ['--api-url', registry.server.url.origin];
            const anonymous = await cli(
                home,
                ['add', 'example/repo-engineer', ...api],
                root
            );
            expect(anonymous.code).toBe(1);
            expect(anonymous.stderr).toContain('wb login --org example');

            await hold(home, registry.server.url.origin, ['other']);
            const other = await cli(
                home,
                ['add', 'example/repo-engineer', ...api],
                root
            );
            expect(other.code).toBe(1);
            expect(other.stderr).toContain('wb login --org example');
            expect(registry.seen).toEqual([
                { path: '/v1/resolutions', authorization: '' },
                { path: '/v1/resolutions', authorization: 'Bearer wb_other' },
            ]);
            expect(await new SavedWorkbenchCatalog(home).list()).toEqual([]);
        } finally {
            registry.server.stop(true);
        }
    });
});

describe('push, publish, and unpublish', () => {
    test('push stores an internal version with the default organization and --org', async () => {
        const { root, home, path } = await fixture('repo-engineer');
        await writeFile(join(path, 'instructions.md'), 'Current package bytes');
        const registry = await lifecycleRegistry(path);
        try {
            await hold(home, registry.server.url.origin, ['first', 'second']);
            const api = ['--api-url', registry.server.url.origin];
            const digest = registry.digest;

            const fallback = await cli(home, ['push', '.#core', ...api], root);
            expect(fallback.code).toBe(0);
            expect(fallback.stdout).toBe(
                `push\tfirst/repo-engineer\t0.1.0\tsha256:${digest}\n`
            );

            const selected = await cli(
                home,
                ['push', '.#core', '--org', 'second', ...api],
                root
            );
            expect(selected.code).toBe(0);
            expect(selected.stdout).toContain('push\tsecond/repo-engineer\t0.1.0');

            const renamed = await cli(
                home,
                ['push', '.#core', '--as', 'other-name', ...api],
                root
            );
            expect(renamed.stdout).toContain('push\tfirst/other-name\t');

            expect(registry.requests.map((request) => request.path)).toEqual([
                '/v1/versions',
                '/v1/versions',
                '/v1/versions',
            ]);
            expect(registry.requests[0]?.authorization).toBe('Bearer wb_first');
            expect(registry.requests[1]?.authorization).toBe('Bearer wb_second');
            expect(registry.requests[0]?.body).toMatchObject({
                organization_id: 'first-id',
                slug: 'repo-engineer',
                package: {
                    format: 1,
                    files: expect.arrayContaining([
                        {
                            path: 'instructions.md',
                            content: Buffer.from('Current package bytes').toString(
                                'base64'
                            ),
                            executable: false,
                        },
                    ]),
                },
            });
            expect(registry.requests[1]?.body).toMatchObject({
                organization_id: 'second-id',
            });
            expect(registry.requests[0]?.body).not.toHaveProperty('visibility');

            const unheld = await cli(
                home,
                ['push', '.#core', '--org', 'third', ...api],
                root
            );
            expect(unheld.code).toBe(1);
            expect(unheld.stderr).toContain('Not signed in to organization third');
            expect(registry.requests).toHaveLength(3);

            const removed = await cli(
                home,
                ['push', '.#core', '--publisher', 'second', ...api],
                root
            );
            expect(removed.code).toBe(1);
            expect(removed.stderr).toContain('Use --org <slug>');
        } finally {
            registry.server.stop(true);
        }
    });

    test('push accepts a saved alias and requires a login before calling the API', async () => {
        const { root, home, path } = await fixture('repo-engineer');
        await new SavedWorkbenchCatalog(home).addLocal({
            alias: 'local-expert',
            workbench: await Workbench.load(path),
        });
        const result = await cli(
            home,
            ['push', 'local-expert', '--api-url', 'http://127.0.0.1:57499'],
            root
        );
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('Sign in first with wb login');

        const registry = await lifecycleRegistry(path);
        try {
            await hold(home, registry.server.url.origin, ['first']);
            const pushed = await cli(
                home,
                ['push', 'local-expert', '--api-url', registry.server.url.origin],
                root
            );
            expect(pushed.code).toBe(0);
            expect(pushed.stdout).toContain('push\tfirst/repo-engineer\t0.1.0');
        } finally {
            registry.server.stop(true);
        }
    });

    test('push prints the registry conflict message unchanged', async () => {
        const { root, home, path } = await fixture('repo-engineer');
        const registry = await lifecycleRegistry(path);
        try {
            await hold(home, registry.server.url.origin, ['first']);
            const api = ['--api-url', registry.server.url.origin];

            registry.versionConflict =
                'Version 0.1.0 must be greater than the latest stored version 0.1.0';
            const stale = await cli(home, ['push', '.#core', ...api], root);
            expect(stale.code).toBe(1);
            expect(stale.stderr).toContain(registry.versionConflict);

            registry.versionConflict =
                'repo-engineer is public. Publish new versions with wb publish';
            const isPublic = await cli(home, ['push', '.#core', ...api], root);
            expect(isPublic.code).toBe(1);
            expect(isPublic.stderr).toContain(registry.versionConflict);
        } finally {
            registry.server.stop(true);
        }
    });

    test('push renders the internal wording for people', () => {
        const lines: string[] = [];
        const output = new CliPresenter({
            interactive: true,
            color: false,
            stdout: (value) => lines.push(value),
        });
        presentPushed(output, {
            reference: { publisher: 'acme', workbench: 'ios-expert' },
            workbenchId: 'wb-id',
            visibility: 'private',
            versionId: 'version-id',
            version: '1.2.0',
            digest: `sha256:${'a'.repeat(64)}`,
        });
        expect(lines.join('')).toContain('Pushed acme/ios-expert@1.2.0 (internal)');
    });

    test('publish by reference submits the latest stored version id', async () => {
        const { root, home, path } = await fixture('repo-engineer');
        const registry = await lifecycleRegistry(path);
        try {
            await hold(home, registry.server.url.origin, ['example']);
            const api = ['--api-url', registry.server.url.origin];

            const result = await cli(
                home,
                ['publish', 'example/repo-engineer', ...api],
                root
            );
            expect(result.code).toBe(0);
            expect(result.stdout).toContain('submitted\texample/repo-engineer\t0.1.0');
            expect(result.stdout).toContain('pending');
            expect(result.stdout).toContain('https://registry.example/submissions/id');
            expect(result.stdout).not.toContain('push\t');
            expect(registry.requests.map((request) => request.path)).toEqual([
                '/v1/resolutions',
                '/v1/submissions',
            ]);
            expect(registry.requests[1]?.body).toEqual({ version_id: 'version-id' });
            expect(registry.requests[1]?.authorization).toBe('Bearer wb_example');

            const latest = await cli(
                home,
                ['publish', 'example/repo-engineer', '--version', '0.1.0', ...api],
                root
            );
            expect(latest.code).toBe(0);

            const older = await cli(
                home,
                ['publish', 'example/repo-engineer', '--version', '0.0.9', ...api],
                root
            );
            expect(older.code).toBe(1);
            expect(older.stderr).toContain('Only the latest version can be published');

            const mismatched = await cli(
                home,
                ['publish', 'example/repo-engineer', '--org', 'other', ...api],
                root
            );
            expect(mismatched.code).toBe(1);
            expect(mismatched.stderr).toContain('does not match example/repo-engineer');

            const unheld = await cli(
                home,
                ['publish', 'nobody/repo-engineer', ...api],
                root
            );
            expect(unheld.code).toBe(1);
            expect(unheld.stderr).toContain('Not signed in to organization nobody');
        } finally {
            registry.server.stop(true);
        }
    });

    test('publish with a local source submits the package directly', async () => {
        const { root, home, path } = await fixture('repo-engineer');
        const registry = await lifecycleRegistry(path);
        try {
            await hold(home, registry.server.url.origin, ['first', 'second']);
            const api = ['--api-url', registry.server.url.origin];

            const result = await cli(
                home,
                ['publish', '.#core', '--org', 'second', ...api],
                root
            );
            expect(result.code).toBe(0);
            expect(result.stdout.trim()).toContain(
                'submitted\tsecond/repo-engineer\t0.1.0'
            );
            // No push first: a public workbench refuses pushes, so its new
            // versions can only arrive as a package submission.
            expect(registry.requests.map((request) => request.path)).toEqual([
                '/v1/submissions',
            ]);
            const body = registry.requests[0]?.body as {
                organization_id: string;
                slug: string;
                package: { format: number; files: unknown[] };
                version_id?: string;
            };
            expect(body.organization_id).toBe('second-id');
            expect(body.slug).toBe('repo-engineer');
            expect(body.package.format).toBe(1);
            expect(body.package.files.length).toBeGreaterThan(0);
            expect(body.version_id).toBeUndefined();
            expect(registry.requests[0]?.authorization).toBe('Bearer wb_second');

            const versioned = await cli(
                home,
                ['publish', '.#core', '--version', '0.1.0', ...api],
                root
            );
            expect(versioned.code).toBe(1);
            expect(versioned.stderr).toContain('--version applies to a registry');
            expect(registry.requests).toHaveLength(1);

            registry.versionConflict = 'Version 0.1.0 must be greater';
            const stale = await cli(home, ['publish', '.#core', ...api], root);
            expect(stale.code).toBe(1);
            expect(stale.stderr).toContain('Version 0.1.0 must be greater');
        } finally {
            registry.server.stop(true);
        }
    });

    test('unpublish resolves the workbench and deletes its publication', async () => {
        const { root, home, path } = await fixture('repo-engineer');
        const registry = await lifecycleRegistry(path);
        try {
            await hold(home, registry.server.url.origin, ['example']);
            const api = ['--api-url', registry.server.url.origin];

            const result = await cli(
                home,
                ['unpublish', 'example/repo-engineer', ...api],
                root
            );
            expect(result.code).toBe(0);
            expect(result.stdout).toBe(
                'unpublished\texample/repo-engineer\tinternal\n'
            );
            expect(
                registry.requests.map((request) => `${request.method} ${request.path}`)
            ).toEqual(['POST /v1/resolutions', 'DELETE /v1/publications/wb-id']);
            expect(registry.requests[1]?.authorization).toBe('Bearer wb_example');

            const local = await cli(home, ['unpublish', '.#core', ...api], root);
            expect(local.code).toBe(1);
            expect(local.stderr).toContain('registry org/name');
        } finally {
            registry.server.stop(true);
        }
    });

    test('--private is rejected on push and publish', async () => {
        const { root, home } = await fixture('repo-engineer');
        const api = ['--api-url', 'http://127.0.0.1:57499'];
        for (const command of ['push', 'publish']) {
            const result = await cli(
                home,
                [command, '.#core', '--private', ...api],
                root
            );
            expect(result.code).toBe(1);
            expect(result.stderr).toContain('Unknown option --private');
        }
        const help = await cli(home, ['publish', '--help'], root);
        expect(help.stdout).not.toContain('--private');
    });
});

/** A registry that stores versions, resolves them, and accepts submissions. */
async function lifecycleRegistry(packagePath: string) {
    const files = await new WorkbenchPackage(await Workbench.load(packagePath)).files();
    const digest = WorkbenchPackage.digest(files).slice('sha256:'.length);
    const state = {
        digest,
        versionConflict: undefined as string | undefined,
        requests: [] as Array<{
            method: string;
            path: string;
            authorization: string;
            body: unknown;
        }>,
        server: undefined as unknown as ReturnType<typeof Bun.serve>,
    };
    state.server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        async fetch(request) {
            const pathname = new URL(request.url).pathname;
            if (pathname === '/v1/events') return Response.json({ ok: true });
            const body = request.method === 'DELETE' ? null : await request.json();
            state.requests.push({
                method: request.method,
                path: pathname,
                authorization: request.headers.get('authorization') ?? '',
                body,
            });
            if (pathname === '/v1/versions') {
                if (state.versionConflict) {
                    return Response.json(
                        { error: { message: state.versionConflict } },
                        { status: 409 }
                    );
                }
                const organization = (body as { organization_id: string })
                    .organization_id;
                return Response.json(
                    {
                        workbench: {
                            id: 'wb-id',
                            slug: (body as { slug: string }).slug,
                            organization_slug: organization.replace('-id', ''),
                            visibility: 'private',
                        },
                        version: { id: 'version-id', version: '0.1.0', digest },
                    },
                    { status: 201 }
                );
            }
            if (pathname === '/v1/resolutions') {
                return Response.json({
                    workbench_id: 'wb-id',
                    visibility: 'private',
                    source_path: 'workbench.yml',
                    repository: null,
                    latest_version: {
                        id: 'version-id',
                        version: '0.1.0',
                        digest,
                        source_commit: 'a'.repeat(40),
                        artifact_url: null,
                    },
                });
            }
            if (pathname === '/v1/submissions') {
                if (state.versionConflict) {
                    return Response.json(
                        { error: { message: state.versionConflict } },
                        { status: 409 }
                    );
                }
                const key = request.headers.get('authorization') ?? '';
                return Response.json({
                    submissions: [
                        {
                            id: 'submission-id',
                            status: 'pending',
                            publisher_slug: key.replace('Bearer wb_', ''),
                            slug: 'repo-engineer',
                            version: '0.1.0',
                            digest,
                            dashboard_url: 'https://registry.example/submissions/id',
                            latest_approved_version: null,
                        },
                    ],
                });
            }
            if (pathname === '/v1/publications/wb-id') {
                return Response.json({ unpublished: true });
            }
            return new Response('unexpected', { status: 500 });
        },
    });
    return state;
}

/** A registry whose only workbench is private to the organization `example`. */
async function privateRegistry(packagePath: string) {
    const files = await new WorkbenchPackage(await Workbench.load(packagePath)).files();
    const digest = WorkbenchPackage.digest(files).slice('sha256:'.length);
    const seen: Array<{ path: string; authorization: string }> = [];
    const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch(request) {
            const pathname = new URL(request.url).pathname;
            const authorization = request.headers.get('authorization') ?? '';
            // Save telemetry is anonymous by design and not part of key selection.
            if (pathname === '/v1/events') return Response.json({ ok: true });
            seen.push({ path: pathname, authorization });
            if (authorization !== 'Bearer wb_example')
                return new Response('missing', { status: 404 });
            if (pathname === '/v1/resolutions') {
                return Response.json({
                    visibility: 'private',
                    source_path: 'workbench.yml',
                    repository: null,
                    latest_version: {
                        id: 'version',
                        version: '0.1.0',
                        digest,
                        source_commit: 'a'.repeat(40),
                        artifact_url: `${new URL(request.url).origin}/v1/artifacts/version`,
                    },
                });
            }
            if (pathname === '/v1/artifacts/version') {
                return Response.json({
                    format: 1,
                    files: files.map((file) => ({
                        path: file.path,
                        content: Buffer.from(file.bytes).toString('base64'),
                        executable: file.executable,
                    })),
                });
            }
            return new Response('unexpected', { status: 500 });
        },
    });
    return { server, seen };
}

async function hold(home: string, apiUrl: string, slugs: string[]) {
    const accounts = new RegistryAccountStore({
        home,
        client: new RegistryClient({ apiUrl }),
    });
    for (const slug of slugs) await accounts.save(orgKey(slug));
}

function orgKey(slug: string) {
    return {
        organizationId: `${slug}-id`,
        slug,
        name: slug,
        personal: false,
        token: `wb_${slug}`,
        keyId: `${slug}-key`,
        scopes: ['catalog:read', 'packages:write'],
        expiresAt: '2099-01-01T00:00:00Z',
    };
}

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
