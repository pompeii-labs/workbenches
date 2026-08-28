import { afterEach, describe, expect, test } from 'bun:test';
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SavedWorkbenchCatalog } from '../src/catalog/index.js';
import { GitHubWorkbenchSource } from '../src/sources/index.js';
import { workbenchHome } from '../src/storage.js';
import {
    Workbench,
    WorkbenchResolver,
    WorkbenchSource,
} from '../src/workbench/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('sources and saved catalog', () => {
    test('parses source selectors without confusing ordinary sources', () => {
        const source = new WorkbenchSource();
        expect(source.parse('lux-db/lux')).toEqual({ source: 'lux-db/lux' });
        expect(source.parse('lux-db/lux#migrations')).toEqual({
            source: 'lux-db/lux',
            selector: 'migrations',
        });
        expect(() => source.parse('#migrations')).toThrow(
            'Invalid Workbench reference'
        );
        expect(new GitHubWorkbenchSource().repository('lux-db/lux')).toMatchObject({
            owner: 'lux-db',
            repo: 'lux',
        });
        expect(source.remote('https://github.com/lux-db/lux.git')).toMatchObject({
            owner: 'lux-db',
            repo: 'lux',
        });
        expect(() => source.remote('not-a-source')).toThrow(
            'Workbench source does not exist'
        );
    });

    test('discovers and selects repository Workbenches deterministically', async () => {
        const fixture = await createRepository(['zeta', 'alpha']);
        const workbenchSource = new WorkbenchSource();
        const source = await workbenchSource.local(fixture.root);
        expect(source).toBeDefined();
        const discovered = await workbenchSource.discover(source?.directory as string);

        expect(discovered.map((workbench) => workbench.manifest.name)).toEqual([
            'alpha',
            'zeta',
        ]);
        expect(
            (await workbenchSource.select(source?.directory as string, 'zeta')).manifest
                .name
        ).toBe('zeta');
        await expect(
            workbenchSource.select(source?.directory as string)
        ).rejects.toThrow('Workbench selector required. Available: alpha, zeta');
    });

    test('distinguishes missing local paths from GitHub slugs without materializing', async () => {
        const source = new WorkbenchSource();
        expect(await source.local('lux-db/lux')).toBeUndefined();
        expect(await source.local('https://github.com/lux-db/lux')).toBeUndefined();
        await expect(source.local('./definitely-missing')).rejects.toThrow(
            'Workbench path does not exist'
        );
    });

    test('accepts a direct manifest and reports empty or missing selections', async () => {
        const fixture = await createRepository(['core']);
        const source = new WorkbenchSource();
        const manifest = join(fixture.packages.core as string, 'workbench.yml');
        expect(
            (await source.discover(manifest)).map((entry) => entry.manifest.name)
        ).toEqual(['core']);
        await expect(source.select(fixture.root, 'missing')).rejects.toThrow(
            'Workbench not found: missing'
        );

        const empty = await temporaryDirectory('workbench-empty-source-');
        expect(await source.discover(empty)).toEqual([]);
        await expect(source.select(empty)).rejects.toThrow('No Workbenches found');
    });

    test('saves content-addressed packages, reuses snapshots, and removes safely', async () => {
        const fixture = await createRepository(['core']);
        const home = await temporaryDirectory('workbench-catalog-');
        const catalog = new SavedWorkbenchCatalog(home);
        const workbench = await Workbench.load(fixture.packages.core as string);

        const first = await catalog.add({
            alias: 'fixture-core',
            source: fixture.root,
            workbench,
        });
        const second = await catalog.add({
            alias: 'fixture-copy',
            source: fixture.root,
            workbench,
        });

        expect(first.digest).toBe(second.digest);
        expect(first.packagePath).toBe(second.packagePath);
        expect(await readFile(join(first.packagePath, 'instructions.md'), 'utf8')).toBe(
            '# core\n'
        );
        expect((await catalog.list()).map((entry) => entry.alias)).toEqual([
            'fixture-core',
            'fixture-copy',
        ]);
        expect(await catalog.find('fixture-core')).toEqual(first);

        await catalog.remove('fixture-core');
        expect((await stat(first.packagePath)).isDirectory()).toBeTrue();
        await catalog.remove('fixture-copy');
        await expect(stat(first.packagePath)).rejects.toThrow();
        await expect(catalog.remove('missing')).rejects.toThrow('does not exist');
    });

    test('resolves saved and local Workbench references without changing their workspace', async () => {
        const fixture = await createRepository(['core']);
        const home = await temporaryDirectory('workbench-reference-');
        const catalog = new SavedWorkbenchCatalog(home);
        const workspace = await temporaryDirectory('workbench-workspace-');
        const workbench = await Workbench.load(fixture.packages.core as string);
        const saved = await catalog.add({
            alias: 'fixture-core',
            source: fixture.root,
            workbench,
        });
        const registry = {
            url: 'https://workbenches.dev',
            publisher: 'example',
            workbench: 'core',
            version_id: '018f1e48-7fb2-7a12-a4dd-0123456789ab',
        };
        await writeFile(
            join(home, 'catalog.json'),
            `${JSON.stringify({ version: 1, entries: [{ ...saved, registry }] })}\n`
        );

        const resolver = new WorkbenchResolver();
        const savedReference = await resolver.resolve('fixture-core', {
            home,
            workspaceDirectory: workspace,
        });
        expect(savedReference.workbench.manifest.name).toBe('core');
        expect(savedReference.workspaceDirectory).toBe(workspace);
        expect(savedReference.registry).toEqual(registry);
        await savedReference.cleanup();

        const localReference = await resolver.resolve(`${fixture.root}#core`, {
            home,
        });
        expect(localReference.workbench.manifest.name).toBe('core');
        expect(localReference.workspaceDirectory).toBe(fixture.root);
        expect(localReference.registry).toBeUndefined();
        await localReference.cleanup();
    });

    test('requires remote Workbenches to cross the explicit save boundary', async () => {
        const home = await temporaryDirectory('workbench-remote-reference-');
        await expect(
            new WorkbenchResolver().resolve('example/project#core', { home })
        ).rejects.toThrow('Remote Workbenches must be saved before running');
    });

    test('rejects duplicate aliases, invalid aliases, and package symlinks', async () => {
        const fixture = await createRepository(['core']);
        const home = await temporaryDirectory('workbench-catalog-invalid-');
        const catalog = new SavedWorkbenchCatalog(home);
        const packageDirectory = fixture.packages.core as string;
        const workbench = await Workbench.load(packageDirectory);
        await catalog.add({
            alias: 'fixture-core',
            source: fixture.root,
            workbench,
        });

        await expect(
            catalog.add({
                alias: 'fixture-core',
                source: fixture.root,
                workbench,
            })
        ).rejects.toThrow('already exists');
        await expect(
            catalog.add({ alias: 'Bad Alias', source: fixture.root, workbench })
        ).rejects.toThrow('Invalid saved Workbench alias');

        await symlink('/tmp', join(packageDirectory, 'escape'));
        await expect(
            catalog.add({ alias: 'with-link', source: fixture.root, workbench })
        ).rejects.toThrow('may not contain symlinks');
    });

    test('rejects registry packages whose downloaded contents do not match', async () => {
        const home = await temporaryDirectory('workbench-registry-digest-');
        const catalog = new SavedWorkbenchCatalog(home);
        await expect(
            catalog.addRemote({
                alias: 'registry-core',
                expectedDigest: `sha256:${'0'.repeat(64)}`,
                registry: {
                    url: 'https://workbenches.dev',
                    publisher: 'pompeii-labs',
                    workbench: 'core',
                    version_id: '018f1e48-7fb2-7a12-a4dd-0123456789ab',
                },
                workbench: {
                    source: 'https://github.com/pompeii-labs/workbenches',
                    revision: 'a'.repeat(40),
                    selector: 'core',
                    manifest: {
                        spec: 0,
                        version: '0.1.0',
                        name: 'core',
                        runner: 'opencode',
                        model: { id: 'openai/gpt-5.6-terra' },
                        instructions: './instructions.md',
                        skills: [],
                        tools: [],
                        mcps: [],
                        env: {},
                        runtime: 'local',
                    },
                    files: [
                        {
                            path: 'workbench.yml',
                            bytes: new TextEncoder().encode('spec: 0\n'),
                            executable: false,
                        },
                    ],
                },
            })
        ).rejects.toThrow('Registry package digest mismatch');
        expect(await catalog.list()).toEqual([]);
    });

    test('rejects malformed catalogs and non-portable package references', async () => {
        const home = await temporaryDirectory('workbench-catalog-malformed-');
        const catalog = new SavedWorkbenchCatalog(home);
        await writeFile(join(home, 'catalog.json'), '{"version":2,"entries":[]}\n');
        await expect(catalog.list()).rejects.toThrow('Unsupported Workbench catalog');

        const fixture = await createRepository(['core']);
        await writeFile(join(fixture.root, 'shared.md'), '# Shared\n');
        const manifest = join(fixture.packages.core as string, 'workbench.yml');
        await writeFile(
            manifest,
            (await readFile(manifest, 'utf8')).replace(
                './instructions.md',
                '../../shared.md'
            )
        );
        const workbench = await Workbench.load(fixture.packages.core as string);
        const portableHome = await temporaryDirectory('workbench-portable-');
        await expect(
            new SavedWorkbenchCatalog(portableHome).add({
                alias: 'external-reference',
                source: fixture.root,
                workbench,
            })
        ).rejects.toThrow('must keep instructions and skills inside the package');
    });

    test('keeps the storage override separate from the process home', () => {
        expect(workbenchHome({ WORKBENCH_HOME: './fixture-home' })).toEndWith(
            '/fixture-home'
        );
    });
});

async function createRepository(names: string[]) {
    const root = await temporaryDirectory('workbench-source-fixture-');
    const packages: Record<string, string> = {};
    for (const name of names) {
        const directory = join(root, '.workbenches', name);
        packages[name] = directory;
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'instructions.md'), `# ${name}\n`);
        await writeFile(
            join(directory, 'workbench.yml'),
            [
                'spec: 0',
                'version: 0.1.0',
                `name: ${name}`,
                'runner: opencode',
                'model:',
                '  id: openai/gpt-5.6-terra',
                'instructions: ./instructions.md',
                'skills: []',
                'tools: []',
                'mcps: []',
                'env: {}',
                'runtime: local',
                '',
            ].join('\n')
        );
    }
    return { root, packages };
}

async function temporaryDirectory(prefix: string) {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}
