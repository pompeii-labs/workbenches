import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    SavedWorkbenchCatalog,
    SavedWorkbenchUpgrade,
    WorkbenchPackage,
} from '../src/catalog/index.js';
import { Workbench } from '../src/workbench/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('saved Workbench upgrades', () => {
    test('repoints a local alias only after the new snapshot is ready', async () => {
        const fixture = await localFixture('0.1.0');
        const home = await temporaryDirectory('workbench-upgrade-local-');
        const saved = await new SavedWorkbenchCatalog(home).add({
            alias: 'fixture-core',
            source: fixture.root,
            workbench: await Workbench.load(fixture.packageDirectory),
        });

        await fixture.writeVersion('0.2.0', '# updated\n');
        const result = await new SavedWorkbenchUpgrade(home).upgrade('fixture-core');

        expect(result.changed).toBeTrue();
        expect(result.previous.version).toBe('0.1.0');
        expect(result.entry.version).toBe('0.2.0');
        expect(result.entry.addedAt).toBe(saved.addedAt);
        expect(
            await readFile(join(result.entry.packagePath, 'instructions.md'), 'utf8')
        ).toBe('# updated\n');
        await expect(stat(saved.packagePath)).rejects.toThrow();
    });

    test('does not rewrite an alias when its package is already current', async () => {
        const fixture = await localFixture('0.1.0');
        const home = await temporaryDirectory('workbench-upgrade-current-');
        const catalog = new SavedWorkbenchCatalog(home);
        const saved = await catalog.add({
            alias: 'fixture-core',
            source: fixture.root,
            workbench: await Workbench.load(fixture.packageDirectory),
        });

        const result = await new SavedWorkbenchUpgrade(home).upgrade('fixture-core');

        expect(result.changed).toBeFalse();
        expect(result.entry).toEqual(saved);
        expect(await catalog.list()).toEqual([saved]);
    });

    test('keeps shared snapshots until the final alias moves away', async () => {
        const fixture = await localFixture('0.1.0');
        const home = await temporaryDirectory('workbench-upgrade-shared-');
        const catalog = new SavedWorkbenchCatalog(home);
        const workbench = await Workbench.load(fixture.packageDirectory);
        const first = await catalog.add({
            alias: 'fixture-one',
            source: fixture.root,
            workbench,
        });
        await catalog.add({
            alias: 'fixture-two',
            source: fixture.root,
            workbench,
        });
        await fixture.writeVersion('0.2.0', '# updated\n');

        const upgrade = new SavedWorkbenchUpgrade(home);
        await upgrade.upgrade('fixture-one');
        expect((await stat(first.packagePath)).isDirectory()).toBeTrue();
        await upgrade.upgrade('fixture-two');
        await expect(stat(first.packagePath)).rejects.toThrow();
    });

    test('preserves the existing alias when a candidate package is invalid', async () => {
        const fixture = await localFixture('0.1.0');
        const home = await temporaryDirectory('workbench-upgrade-invalid-');
        const catalog = new SavedWorkbenchCatalog(home);
        const saved = await catalog.add({
            alias: 'fixture-core',
            source: fixture.root,
            workbench: await Workbench.load(fixture.packageDirectory),
        });
        await writeFile(join(fixture.packageDirectory, 'workbench.yml'), 'spec: 99\n');

        await expect(
            new SavedWorkbenchUpgrade(home).upgrade('fixture-core')
        ).rejects.toThrow();
        expect(await catalog.list()).toEqual([saved]);
        expect((await stat(saved.packagePath)).isDirectory()).toBeTrue();
    });

    test('resolves and verifies a newer registry artifact', async () => {
        const home = await temporaryDirectory('workbench-upgrade-registry-');
        const catalog = new SavedWorkbenchCatalog(home);
        const initial = remotePackage('0.1.0', 'a'.repeat(40));
        const saved = await catalog.addRemote({
            alias: 'registry-core',
            workbench: initial.workbench,
            registry: {
                url: 'https://registry.example',
                publisher: 'example',
                workbench: 'core',
                version_id: 'version-one',
            },
        });
        const next = remotePackage('0.2.0', 'b'.repeat(40));
        const digest = WorkbenchPackage.digest(next.workbench.files);
        const fetcher = async (input: string | URL | Request) => {
            const url = String(input);
            if (url === 'https://registry.example/v1/resolutions') {
                return Response.json({
                    source_path: 'workbench.yml',
                    repository: null,
                    latest_version: {
                        id: 'version-two',
                        version: '0.2.0',
                        digest: digest.slice('sha256:'.length),
                        source_commit: next.workbench.revision,
                        artifact_url:
                            'https://registry.example/v1/artifacts/version-two',
                    },
                });
            }
            if (url === 'https://registry.example/v1/artifacts/version-two') {
                return Response.json({
                    format: 1,
                    files: next.workbench.files.map((file) => ({
                        path: file.path,
                        content: Buffer.from(file.bytes).toString('base64'),
                        executable: file.executable,
                    })),
                });
            }
            return new Response('not found', { status: 404 });
        };

        const result = await new SavedWorkbenchUpgrade(home, {
            fetch: fetcher,
        }).upgrade('registry-core');

        expect(result.changed).toBeTrue();
        expect(result.entry.version).toBe('0.2.0');
        expect(result.entry.registry?.version_id).toBe('version-two');
        expect(result.entry.digest).toBe(digest);
        await expect(stat(saved.packagePath)).rejects.toThrow();
    });

    test('refreshes a GitHub-backed snapshot from the default branch', async () => {
        const home = await temporaryDirectory('workbench-upgrade-github-');
        const catalog = new SavedWorkbenchCatalog(home);
        const initial = remotePackage('0.1.0', 'a'.repeat(40));
        await catalog.addRemote({
            alias: 'github-core',
            workbench: initial.workbench,
        });
        const next = remotePackage('0.2.0', 'b'.repeat(40));
        const blobs = new Map(
            next.workbench.files.map((file, index) => [`blob-${index}`, file])
        );
        const tree = [...blobs.entries()].map(([sha, file]) => ({
            path: `.workbenches/core/${file.path}`,
            mode: file.executable ? '100755' : '100644',
            type: 'blob',
            sha,
            size: file.bytes.byteLength,
        }));
        const fetcher = async (input: string | URL | Request) => {
            const url = String(input);
            if (url === 'https://api.github.com/repos/example/core') {
                return Response.json({ default_branch: 'main' });
            }
            if (url === 'https://api.github.com/repos/example/core/commits/main') {
                return Response.json({ sha: next.workbench.revision });
            }
            if (
                url ===
                `https://api.github.com/repos/example/core/git/trees/${next.workbench.revision}?recursive=1`
            ) {
                return Response.json({ truncated: false, tree });
            }
            const match = url.match(/\/git\/blobs\/(blob-\d+)$/);
            const file = match?.[1] ? blobs.get(match[1]) : undefined;
            if (file) {
                return Response.json({
                    encoding: 'base64',
                    content: Buffer.from(file.bytes).toString('base64'),
                    size: file.bytes.byteLength,
                });
            }
            return new Response('not found', { status: 404 });
        };

        const result = await new SavedWorkbenchUpgrade(home, {
            fetch: fetcher,
        }).upgrade('github-core');

        expect(result.changed).toBeTrue();
        expect(result.entry.version).toBe('0.2.0');
        expect(result.entry.revision).toBe(next.workbench.revision);
    });
});

async function localFixture(version: string) {
    const root = await temporaryDirectory('workbench-upgrade-source-');
    const packageDirectory = join(root, '.workbenches', 'core');
    await mkdir(packageDirectory, { recursive: true });
    const writeVersion = async (nextVersion: string, instructions: string) => {
        await writeFile(join(packageDirectory, 'instructions.md'), instructions);
        await writeFile(join(packageDirectory, 'workbench.yml'), manifest(nextVersion));
    };
    await writeVersion(version, '# initial\n');
    return { root, packageDirectory, writeVersion };
}

function remotePackage(version: string, revision: string) {
    const instructions = new TextEncoder().encode(`# ${version}\n`);
    const manifestBytes = new TextEncoder().encode(manifest(version));
    return {
        workbench: {
            source: 'example/core',
            revision,
            selector: 'core',
            manifest: {
                spec: 0 as const,
                version,
                name: 'fixture-core',
                runner: 'opencode' as const,
                model: { id: 'openai/gpt-5.6-terra' },
                instructions: './instructions.md',
                skills: [],
                tools: [],
                mcps: [],
                env: {},
                runtime: 'local' as const,
            },
            files: [
                { path: 'instructions.md', bytes: instructions, executable: false },
                { path: 'workbench.yml', bytes: manifestBytes, executable: false },
            ],
        },
    };
}

function manifest(version: string): string {
    return [
        'spec: 0',
        `version: ${version}`,
        'name: fixture-core',
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
    ].join('\n');
}

async function temporaryDirectory(prefix: string) {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}
