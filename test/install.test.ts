import { afterEach, describe, expect, test } from 'bun:test';
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    readlink,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import packageMetadata from '../package.json' with { type: 'json' };
import { resolveReleaseTarget } from '../scripts/release-support.js';

const projectDirectory = resolve(import.meta.dir, '..');
const installer = join(projectDirectory, 'install.sh');
const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('release installer', () => {
    test('verifies and installs the current native artifact without sudo', async () => {
        const fixture = await releaseFixture();
        const installation = await temporaryDirectory('workbench-install-destination-');
        const result = await runInstaller(fixture.release, installation);

        expect(result.code).toBe(0);
        expect(result.stdout).toContain('Installed Workbench');
        expect(await Bun.file(join(installation, 'workbench')).text()).toContain(
            'fixture workbench'
        );
        expect(await readlink(join(installation, 'wb'))).toBe('workbench');
    });

    test('rejects an artifact whose checksum does not match', async () => {
        const fixture = await releaseFixture();
        const installation = await temporaryDirectory('workbench-install-failure-');
        await writeFile(
            join(fixture.release, 'checksums.txt'),
            `${'0'.repeat(64)}  ${fixture.archive}\n`
        );

        const result = await runInstaller(fixture.release, installation);

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('checksum verification failed');
        expect(await Bun.file(join(installation, 'workbench')).exists()).toBe(false);
    });

    test('selects an explicitly versioned GitHub release URL', async () => {
        const stubs = await temporaryDirectory('workbench-install-stubs-');
        const log = join(stubs, 'urls.log');
        await executableFile(
            join(stubs, 'curl'),
            '#!/bin/sh\nfor argument do url="$argument"; done\nprintf "%s\\n" "$url" >> "$WORKBENCH_TEST_URL_LOG"\nexit 22\n'
        );

        const result = await runInstaller('', '', ['--version', '1.2.3'], {
            PATH: `${stubs}:${process.env.PATH ?? ''}`,
            WORKBENCH_TEST_URL_LOG: log,
        });

        expect(result.code).not.toBe(0);
        expect(await readFile(log, 'utf8')).toContain(
            `https://github.com/pompeii-labs/workbenches/releases/download/v1.2.3/${resolveReleaseTarget().name}.tar.gz`
        );
    });

    test('defaults to the prerelease matching the package version', async () => {
        const stubs = await temporaryDirectory('workbench-install-default-');
        const log = join(stubs, 'urls.log');
        await executableFile(
            join(stubs, 'curl'),
            '#!/bin/sh\nfor argument do url="$argument"; done\nprintf "%s\\n" "$url" >> "$WORKBENCH_TEST_URL_LOG"\nexit 22\n'
        );

        const result = await runInstaller('', '', [], {
            PATH: `${stubs}:${process.env.PATH ?? ''}`,
            WORKBENCH_TEST_URL_LOG: log,
        });

        expect(result.code).not.toBe(0);
        expect(await readFile(log, 'utf8')).toContain(
            `https://github.com/pompeii-labs/workbenches/releases/download/v${packageMetadata.version}/${resolveReleaseTarget().name}.tar.gz`
        );
    });

    test('fails clearly on an unsupported operating system', async () => {
        const stubs = await temporaryDirectory('workbench-install-platform-');
        await executableFile(join(stubs, 'uname'), '#!/bin/sh\necho Plan9\n');

        const result = await runInstaller('', '', [], {
            PATH: `${stubs}:${process.env.PATH ?? ''}`,
        });

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('unsupported operating system: Plan9');
    });
});

async function releaseFixture() {
    const root = await temporaryDirectory('workbench-release-fixture-');
    const release = join(root, 'release');
    const target = resolveReleaseTarget().name;
    const packageDirectory = join(root, target);
    const executable = join(packageDirectory, 'workbench');
    const archive = `${target}.tar.gz`;
    await mkdir(packageDirectory, { recursive: true });
    await mkdir(release, { recursive: true });
    await executableFile(executable, '#!/bin/sh\necho "fixture workbench"\n');
    await run(['tar', '-czf', join(release, archive), '-C', root, target]);
    const digest = new Bun.CryptoHasher('sha256');
    digest.update(await Bun.file(join(release, archive)).arrayBuffer());
    await writeFile(
        join(release, 'checksums.txt'),
        `${digest.digest('hex')}  ${archive}\n`
    );
    return { archive, release };
}

async function runInstaller(
    release: string,
    installation: string,
    arguments_: string[] = [],
    environment: Record<string, string> = {}
) {
    const argumentsWithDestination = installation
        ? ['--bin-dir', installation, ...arguments_]
        : arguments_;
    const child = Bun.spawn(['sh', installer, ...argumentsWithDestination], {
        cwd: projectDirectory,
        env: {
            ...process.env,
            ...(release
                ? {
                      WORKBENCH_ALLOW_INSECURE: '1',
                      WORKBENCH_DOWNLOAD_ROOT: `file://${release}`,
                  }
                : {}),
            ...environment,
        },
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    return { code, stderr, stdout };
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

async function run(command: string[]): Promise<void> {
    const code = await Bun.spawn(command, {
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'inherit',
    }).exited;
    if (code !== 0) throw new Error(`Command exited with code ${code}`);
}
