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

import {
    addRemoteToCatalog,
    addToCatalog,
    findCatalogEntry,
    readCatalog,
    removeFromCatalog,
} from '../src/catalog.js';
import { parseGitHubRepository } from '../src/github.js';
import { resolveWorkbench } from '../src/manifest.js';
import {
    discoverWorkbenches,
    parseWorkbenchReference,
    remoteSource,
    resolveLocalSource,
    selectWorkbench,
} from '../src/source.js';
import { workbenchHome } from '../src/storage.js';

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
        expect(parseWorkbenchReference('lux-db/lux')).toEqual({ source: 'lux-db/lux' });
        expect(parseWorkbenchReference('lux-db/lux#migrations')).toEqual({
            source: 'lux-db/lux',
            selector: 'migrations',
        });
        expect(() => parseWorkbenchReference('#migrations')).toThrow(
            'Invalid Workbench reference'
        );
        expect(parseGitHubRepository('lux-db/lux')).toMatchObject({
            owner: 'lux-db',
            repo: 'lux',
        });
        expect(remoteSource('https://github.com/lux-db/lux.git')).toMatchObject({
            owner: 'lux-db',
            repo: 'lux',
        });
        expect(() => remoteSource('not-a-source')).toThrow(
            'Workbench source does not exist'
        );
    });

    test('discovers and selects repository Workbenches deterministically', async () => {
        const fixture = await createRepository(['zeta', 'alpha']);
        const source = await resolveLocalSource(fixture.root);
        expect(source).toBeDefined();
        const discovered = await discoverWorkbenches(source?.directory as string);

        expect(discovered.map((workbench) => workbench.manifest.name)).toEqual([
            'alpha',
            'zeta',
        ]);
        expect(
            (await selectWorkbench(source?.directory as string, 'zeta')).manifest.name
        ).toBe('zeta');
        await expect(selectWorkbench(source?.directory as string)).rejects.toThrow(
            'Workbench selector required. Available: alpha, zeta'
        );
    });

    test('distinguishes missing local paths from GitHub slugs without materializing', async () => {
        expect(await resolveLocalSource('lux-db/lux')).toBeUndefined();
        expect(
            await resolveLocalSource('https://github.com/lux-db/lux')
        ).toBeUndefined();
        await expect(resolveLocalSource('./definitely-missing')).rejects.toThrow(
            'Workbench path does not exist'
        );
    });

    test('accepts a direct manifest and reports empty or missing selections', async () => {
        const fixture = await createRepository(['core']);
        const manifest = join(fixture.packages.core as string, 'workbench.yml');
        expect(
            (await discoverWorkbenches(manifest)).map((entry) => entry.manifest.name)
        ).toEqual(['core']);
        await expect(selectWorkbench(fixture.root, 'missing')).rejects.toThrow(
            'Workbench not found: missing'
        );

        const empty = await temporaryDirectory('workbench-empty-source-');
        expect(await discoverWorkbenches(empty)).toEqual([]);
        await expect(selectWorkbench(empty)).rejects.toThrow('No Workbenches found');
    });

    test('saves content-addressed packages, reuses snapshots, and removes safely', async () => {
        const fixture = await createRepository(['core']);
        const home = await temporaryDirectory('workbench-catalog-');
        const workbench = await resolveWorkbench(fixture.packages.core as string);

        const first = await addToCatalog({
            home,
            alias: 'fixture-core',
            source: fixture.root,
            workbench,
        });
        const second = await addToCatalog({
            home,
            alias: 'fixture-copy',
            source: fixture.root,
            workbench,
        });

        expect(first.digest).toBe(second.digest);
        expect(first.packagePath).toBe(second.packagePath);
        expect(await readFile(join(first.packagePath, 'instructions.md'), 'utf8')).toBe(
            '# core\n'
        );
        expect((await readCatalog(home)).map((entry) => entry.alias)).toEqual([
            'fixture-core',
            'fixture-copy',
        ]);
        expect(findCatalogEntry(await readCatalog(home), 'fixture-core')).toEqual(
            first
        );

        await removeFromCatalog(home, 'fixture-core');
        expect((await stat(first.packagePath)).isDirectory()).toBeTrue();
        await removeFromCatalog(home, 'fixture-copy');
        await expect(stat(first.packagePath)).rejects.toThrow();
        await expect(removeFromCatalog(home, 'missing')).rejects.toThrow(
            'does not exist'
        );
    });

    test('rejects duplicate aliases, invalid aliases, and package symlinks', async () => {
        const fixture = await createRepository(['core']);
        const home = await temporaryDirectory('workbench-catalog-invalid-');
        const packageDirectory = fixture.packages.core as string;
        const workbench = await resolveWorkbench(packageDirectory);
        await addToCatalog({
            home,
            alias: 'fixture-core',
            source: fixture.root,
            workbench,
        });

        await expect(
            addToCatalog({
                home,
                alias: 'fixture-core',
                source: fixture.root,
                workbench,
            })
        ).rejects.toThrow('already exists');
        await expect(
            addToCatalog({ home, alias: 'Bad Alias', source: fixture.root, workbench })
        ).rejects.toThrow('Invalid saved Workbench alias');

        await symlink('/tmp', join(packageDirectory, 'escape'));
        await expect(
            addToCatalog({ home, alias: 'with-link', source: fixture.root, workbench })
        ).rejects.toThrow('may not contain symlinks');
    });

    test('rejects registry packages whose downloaded contents do not match', async () => {
        const home = await temporaryDirectory('workbench-registry-digest-');
        await expect(
            addRemoteToCatalog({
                home,
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
                        model: 'openrouter/openai/gpt-5.6-terra',
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
        expect(await readCatalog(home)).toEqual([]);
    });

    test('rejects malformed catalogs and non-portable package references', async () => {
        const home = await temporaryDirectory('workbench-catalog-malformed-');
        await writeFile(join(home, 'catalog.json'), '{"version":2,"entries":[]}\n');
        await expect(readCatalog(home)).rejects.toThrow(
            'Unsupported Workbench catalog'
        );

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
        const workbench = await resolveWorkbench(fixture.packages.core as string);
        const portableHome = await temporaryDirectory('workbench-portable-');
        await expect(
            addToCatalog({
                home: portableHome,
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
                'model: openrouter/openai/gpt-5.6-terra',
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
