import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveReleaseTarget } from '../scripts/release-support.js';

const root = resolve(import.meta.dir, '..');
const installer = join(root, 'install.ps1');
const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe.skipIf(process.platform !== 'win32')('Windows release installer', () => {
    test('verifies and installs the native executable and wb launcher', async () => {
        const fixture = await releaseFixture();
        const destination = await temporaryDirectory('workbench-windows-install-');

        const result = await runInstaller(fixture.release, destination);

        expect(result).toEqual({ code: 0, stderr: '' });
        expect(await readFile(join(destination, 'workbench.exe'), 'utf8')).toBe(
            'fixture workbench'
        );
        expect(await readFile(join(destination, 'wb.cmd'), 'utf8')).toContain(
            '"%~dp0workbench.exe" %*'
        );
    });

    test('leaves the destination untouched when checksum verification fails', async () => {
        const fixture = await releaseFixture(true);
        const destination = await temporaryDirectory('workbench-windows-failure-');

        const result = await runInstaller(fixture.release, destination);

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('checksum verification failed');
        expect(await Bun.file(join(destination, 'workbench.exe')).exists()).toBe(false);
    });
});

async function releaseFixture(invalidChecksum = false) {
    const directory = await temporaryDirectory('workbench-windows-release-');
    const release = join(directory, 'release');
    const target = resolveReleaseTarget('win32', process.arch).name;
    const packageDirectory = join(directory, target);
    const archiveName = `${target}.tar.gz`;
    const archive = join(release, archiveName);
    await mkdir(packageDirectory, { recursive: true });
    await mkdir(release, { recursive: true });
    await writeFile(join(packageDirectory, 'workbench.exe'), 'fixture workbench');
    const code = await Bun.spawn(
        ['tar.exe', '-czf', archive, '-C', directory, target],
        { stdout: 'ignore', stderr: 'inherit' }
    ).exited;
    if (code !== 0) throw new Error(`tar exited with code ${code}`);
    const digest = new Bun.CryptoHasher('sha256');
    digest.update(await Bun.file(archive).arrayBuffer());
    await writeFile(
        join(release, 'checksums.txt'),
        `${invalidChecksum ? '0'.repeat(64) : digest.digest('hex')}  ${archiveName}\n`
    );
    return { release };
}

async function runInstaller(release: string, destination: string) {
    const child = Bun.spawn(
        [
            'powershell.exe',
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            installer,
            '-BinDir',
            destination,
        ],
        {
            cwd: root,
            env: {
                ...process.env,
                WORKBENCH_ALLOW_INSECURE: '1',
                WORKBENCH_DOWNLOAD_ROOT: pathToFileURL(release).href,
            },
            stdout: 'ignore',
            stderr: 'pipe',
        }
    );
    const [code, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
    ]);
    return { code, stderr };
}

async function temporaryDirectory(prefix: string) {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}
