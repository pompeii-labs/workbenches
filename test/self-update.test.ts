import { afterEach, describe, expect, test } from 'bun:test';
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    type CliRelease,
    CliUpdater,
    ReleaseTarget,
    SemanticVersion,
} from '../src/releases/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('CLI self-update', () => {
    test('orders stable, prerelease, and build versions', () => {
        expect(SemanticVersion.compare('1.0.0', '1.0.0-alpha.9')).toBe(1);
        expect(SemanticVersion.compare('1.0.0-alpha.10', '1.0.0-alpha.2')).toBe(1);
        expect(SemanticVersion.compare('1.2.0', '1.1.99')).toBe(1);
        expect(SemanticVersion.compare('1.0.0+build.2', '1.0.0+build.1')).toBe(0);
        expect(() => SemanticVersion.compare('latest', '1.0.0')).toThrow(
            'Cannot compare CLI versions'
        );
    });

    test('finds prereleases for prerelease users and excludes them for stable users', async () => {
        const releases = [
            releaseResponse('v1.1.0-beta.1', true),
            releaseResponse('v1.0.1', false),
            releaseResponse('v1.0.0', false),
        ];
        const fetcher = async () => Response.json(releases);

        expect(
            (await new CliUpdater({ fetch: fetcher }).available('1.0.0-alpha.2'))
                ?.version
        ).toBe('1.1.0-beta.1');
        const updater = new CliUpdater({ fetch: fetcher });
        expect((await updater.available('1.0.0'))?.version).toBe('1.0.1');
        expect(await updater.available('1.1.0')).toBeUndefined();
    });

    test('rejects failed and malformed release responses', async () => {
        await expect(
            new CliUpdater({
                fetch: async () => {
                    throw new Error('network unavailable');
                },
            }).available('1.0.0')
        ).rejects.toThrow('network unavailable');
        await expect(
            new CliUpdater({
                fetch: async () => new Response('rate limited', { status: 403 }),
            }).available('1.0.0')
        ).rejects.toThrow('HTTP 403');
        await expect(
            new CliUpdater({
                fetch: async () => Response.json({ releases: [] }),
            }).available('1.0.0')
        ).rejects.toThrow('malformed data');
    });

    test('rejects unsupported release targets', () => {
        expect(() => ReleaseTarget.from('win32', 'x64')).toThrow(
            'Unsupported release operating system'
        );
        expect(() => ReleaseTarget.from('linux', 'riscv64')).toThrow(
            'Unsupported release architecture'
        );
    });

    test('verifies and atomically replaces an installed executable', async () => {
        const fixture = await releaseFixture();
        const target = join(await temporaryDirectory('workbench-update-target-'), 'wb');
        await executableFile(target, '#!/bin/sh\necho old\n');

        const installed = await new CliUpdater({
            executable: target,
            fetch: fixture.fetch,
        }).install(fixture.release);

        expect(installed).toBe(await realpath(target));
        expect(await readFile(target, 'utf8')).toContain('echo updated');
        expect((await stat(target)).mode & 0o111).not.toBe(0);
    });

    test('leaves the installed executable untouched after a checksum failure', async () => {
        const fixture = await releaseFixture({ invalidChecksum: true });
        const target = join(await temporaryDirectory('workbench-update-safe-'), 'wb');
        const original = '#!/bin/sh\necho original\n';
        await executableFile(target, original);

        await expect(
            new CliUpdater({
                executable: target,
                fetch: fixture.fetch,
            }).install(fixture.release)
        ).rejects.toThrow('Checksum verification failed');
        expect(await readFile(target, 'utf8')).toBe(original);
    });

    test('fails before mutation when the release lacks this platform', async () => {
        const target = join(
            await temporaryDirectory('workbench-update-missing-'),
            'wb'
        );
        await executableFile(target, '#!/bin/sh\necho original\n');
        await expect(
            new CliUpdater({ executable: target }).install({
                version: '1.0.0',
                tag: 'v1.0.0',
                prerelease: false,
                assets: [],
            })
        ).rejects.toThrow('does not support this platform');
    });
});

async function releaseFixture(options: { invalidChecksum?: boolean } = {}) {
    const root = await temporaryDirectory('workbench-self-update-release-');
    const targetName = ReleaseTarget.from(process.platform, process.arch).name;
    const packageDirectory = join(root, targetName);
    const archiveName = `${targetName}.tar.gz`;
    const archive = join(root, archiveName);
    await mkdir(packageDirectory, { recursive: true });
    await executableFile(
        join(packageDirectory, 'workbench'),
        '#!/bin/sh\necho updated\n'
    );
    const code = await Bun.spawn(['tar', '-czf', archive, '-C', root, targetName], {
        stdout: 'ignore',
        stderr: 'inherit',
    }).exited;
    if (code !== 0) throw new Error(`tar exited with code ${code}`);
    const archiveBytes = new Uint8Array(await Bun.file(archive).arrayBuffer());
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(archiveBytes);
    const checksum = options.invalidChecksum ? '0'.repeat(64) : hasher.digest('hex');
    const archiveUrl = `https://github.com/pompeii-labs/workbenches/releases/download/v1.2.3/${archiveName}`;
    const checksumsUrl =
        'https://github.com/pompeii-labs/workbenches/releases/download/v1.2.3/checksums.txt';
    const release: CliRelease = {
        version: '1.2.3',
        tag: 'v1.2.3',
        prerelease: false,
        assets: [
            { name: archiveName, url: archiveUrl },
            { name: 'checksums.txt', url: checksumsUrl },
        ],
    };
    return {
        release,
        fetch: async (input: string | URL | Request) => {
            const url = String(input);
            if (url === archiveUrl) return new Response(archiveBytes);
            if (url === checksumsUrl) {
                return new Response(`${checksum}  ${archiveName}\n`);
            }
            return new Response('not found', { status: 404 });
        },
    };
}

function releaseResponse(tag: string, prerelease: boolean) {
    return { tag_name: tag, draft: false, prerelease, assets: [] };
}

async function executableFile(path: string, contents: string) {
    await writeFile(path, contents);
    await chmod(path, 0o755);
}

async function temporaryDirectory(prefix: string) {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}
