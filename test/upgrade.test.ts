import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SavedWorkbenchUpgrade, WorkbenchPackage } from '../src/catalog/index.js';
import { Connection } from '../src/database/connection.js';
import { RunnerRegistry } from '../src/runners/index.js';
import { Workbench } from '../src/workbench/index.js';
import { Services } from '../src/workbench/services.js';

const runners = RunnerRegistry.standard();
const temporaryDirectories: string[] = [];
const connections: Connection[] = [];

function services(home: string): Services {
    const connection = Connection.open(home);
    connections.push(connection);
    return new Services(home, connection);
}

afterEach(async () => {
    for (const connection of connections.splice(0)) connection.close();
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('saved Workbench upgrades', () => {
    test('keeps legacy local aliases frozen until explicitly re-added', async () => {
        const fixture = await localFixture('0.1.0');
        const home = await temporaryDirectory('workbench-upgrade-local-');
        const { catalog, writer } = services(home);
        const saved = await writer.add({
            alias: 'fixture-core',
            source: fixture.root,
            workbench: await Workbench.load(fixture.packageDirectory, runners),
        });

        await fixture.writeVersion('0.2.0', '# updated\n');
        await expect(
            new SavedWorkbenchUpgrade(home, catalog, writer).upgrade('fixture-core')
        ).rejects.toThrow('Local Workbenches are not upgraded');
        expect(await catalog.find('fixture-core')).toEqual(saved);
        const live = await catalog.addLocal({
            alias: 'fixture-core',
            workbench: await Workbench.load(fixture.packageDirectory, runners),
        });
        expect(live.localPath).toBe(fixture.packageDirectory);
        expect(live.version).toBe('0.2.0');
    });

    test('does not rewrite an alias when its package is already current', async () => {
        const fixture = await localFixture('0.1.0');
        const home = await temporaryDirectory('workbench-upgrade-current-');
        const { catalog, writer } = services(home);
        const saved = await writer.add({
            alias: 'fixture-core',
            source: fixture.root,
            workbench: await Workbench.load(fixture.packageDirectory, runners),
        });

        const result = await writer.upgrade('fixture-core', {
            source: fixture.root,
            selector: 'core',
            manifest: (await Workbench.load(fixture.packageDirectory, runners))
                .manifest,
            files: await new WorkbenchPackage(
                await Workbench.load(fixture.packageDirectory, runners)
            ).files(),
        });

        expect(result.changed).toBeFalse();
        expect(result.entry).toEqual(saved);
        expect(await catalog.list()).toEqual([saved]);
    });

    test('keeps shared snapshots until the final alias moves away', async () => {
        const fixture = await localFixture('0.1.0');
        const home = await temporaryDirectory('workbench-upgrade-shared-');
        const { writer } = services(home);
        const workbench = await Workbench.load(fixture.packageDirectory, runners);
        const first = await writer.add({
            alias: 'fixture-one',
            source: fixture.root,
            workbench,
        });
        await writer.add({
            alias: 'fixture-two',
            source: fixture.root,
            workbench,
        });
        await fixture.writeVersion('0.2.0', '# updated\n');

        const candidate = await Workbench.load(fixture.packageDirectory, runners);
        const upgrade = {
            source: fixture.root,
            selector: 'core',
            manifest: candidate.manifest,
            files: await new WorkbenchPackage(candidate).files(),
        };
        await writer.upgrade('fixture-one', upgrade);
        expect((await stat(first.packagePath)).isDirectory()).toBeTrue();
        await writer.upgrade('fixture-two', upgrade);
        await expect(stat(first.packagePath)).rejects.toThrow();
    });

    test('preserves the existing alias when a candidate package is invalid', async () => {
        const fixture = await localFixture('0.1.0');
        const home = await temporaryDirectory('workbench-upgrade-invalid-');
        const { catalog, writer } = services(home);
        const saved = await writer.add({
            alias: 'fixture-core',
            source: fixture.root,
            workbench: await Workbench.load(fixture.packageDirectory, runners),
        });
        await writeFile(join(fixture.packageDirectory, 'workbench.yml'), 'spec: 99\n');

        await expect(
            new SavedWorkbenchUpgrade(home, catalog, writer).upgrade('fixture-core')
        ).rejects.toThrow();
        expect(await catalog.list()).toEqual([saved]);
        expect((await stat(saved.packagePath)).isDirectory()).toBeTrue();
    });

    test('resolves and verifies a newer registry artifact', async () => {
        const home = await temporaryDirectory('workbench-upgrade-registry-');
        const { catalog, writer } = services(home);
        const initial = remotePackage('0.1.0', 'a'.repeat(40));
        const saved = await writer.addRemote({
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

        const result = await new SavedWorkbenchUpgrade(home, catalog, writer, {
            fetch: fetcher,
        }).upgrade('registry-core');

        expect(result.changed).toBeTrue();
        expect(result.entry.version).toBe('0.2.0');
        expect(result.entry.registry?.version_id).toBe('version-two');
        expect(result.entry.digest).toBe(digest);
        await expect(stat(saved.packagePath)).rejects.toThrow();
    });

    test('keeps a snapshot saved at an exact version on that version', async () => {
        const home = await temporaryDirectory('workbench-upgrade-pinned-');
        const { catalog, writer } = services(home);
        const initial = remotePackage('0.2.0-alpha.1', 'a'.repeat(40));
        await writer.addRemote({
            alias: 'registry-pre',
            workbench: initial.workbench,
            registry: {
                url: 'https://registry.example',
                publisher: 'example',
                workbench: 'core',
                version_id: 'version-pre',
                version: '0.2.0-alpha.1',
            },
        });
        const digest = WorkbenchPackage.digest(initial.workbench.files);
        const asked: unknown[] = [];
        const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);
            if (url === 'https://registry.example/v1/resolutions') {
                asked.push(JSON.parse(String(init?.body)));
                return Response.json({
                    source_path: 'workbench.yml',
                    repository: null,
                    latest_version: {
                        id: 'version-pre',
                        version: '0.2.0-alpha.1',
                        digest: digest.slice('sha256:'.length),
                        source_commit: initial.workbench.revision,
                        artifact_url:
                            'https://registry.example/v1/artifacts/version-pre',
                    },
                });
            }
            if (url === 'https://registry.example/v1/artifacts/version-pre') {
                return Response.json({
                    format: 1,
                    files: initial.workbench.files.map((file) => ({
                        path: file.path,
                        content: Buffer.from(file.bytes).toString('base64'),
                        executable: file.executable,
                    })),
                });
            }
            return new Response('not found', { status: 404 });
        };

        const result = await new SavedWorkbenchUpgrade(home, catalog, writer, {
            fetch: fetcher,
        }).upgrade('registry-pre');

        expect(asked).toEqual([
            { publisher: 'example', workbench: 'core', version: '0.2.0-alpha.1' },
        ]);
        expect(result.changed).toBeFalse();
        expect(result.entry.version).toBe('0.2.0-alpha.1');
        expect(result.entry.registry?.version).toBe('0.2.0-alpha.1');

        // A registry that answers with another version is refused, not saved.
        const wrong = async (input: string | URL | Request, init?: RequestInit) => {
            const answer = await fetcher(input, init);
            if (String(input) !== 'https://registry.example/v1/resolutions')
                return answer;
            const body = (await answer.json()) as {
                latest_version: { version: string };
            };
            body.latest_version.version = '2.0.0';
            return Response.json(body);
        };
        await expect(
            new SavedWorkbenchUpgrade(home, catalog, writer, {
                fetch: wrong,
            }).upgrade('registry-pre')
        ).rejects.toThrow('when 0.2.0-alpha.1 was asked for');
        expect((await catalog.find('registry-pre'))?.registry?.version).toBe(
            '0.2.0-alpha.1'
        );
    });

    test('pins and unpins the same saved bytes to their exact version', async () => {
        const home = await temporaryDirectory('workbench-upgrade-repin-');
        const { catalog, writer } = services(home);
        const saved = remotePackage('1.2.0', 'b'.repeat(40));
        const registry = {
            url: 'https://registry.example',
            publisher: 'example',
            workbench: 'core',
            version_id: 'version-120',
        };
        await writer.addRemote({
            alias: 'registry-core',
            workbench: saved.workbench,
            registry,
        });
        const again = (version?: string) =>
            writer.upgrade('registry-core', {
                source: saved.workbench.source,
                selector: saved.workbench.selector,
                manifest: saved.workbench.manifest,
                files: saved.workbench.files,
                registry: { ...registry, ...(version ? { version } : {}) },
            });

        const pinned = await again('1.2.0');
        expect(pinned.changed).toBeTrue();
        expect((await catalog.find('registry-core'))?.registry?.version).toBe('1.2.0');
        const unpinned = await again();
        expect(unpinned.changed).toBeTrue();
        expect(
            (await catalog.find('registry-core'))?.registry?.version
        ).toBeUndefined();
        expect((await again()).changed).toBeFalse();
    });

    test('refreshes a GitHub-backed snapshot from the default branch', async () => {
        const home = await temporaryDirectory('workbench-upgrade-github-');
        const { catalog, writer } = services(home);
        const initial = remotePackage('0.1.0', 'a'.repeat(40));
        await writer.addRemote({
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

        const result = await new SavedWorkbenchUpgrade(home, catalog, writer, {
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
