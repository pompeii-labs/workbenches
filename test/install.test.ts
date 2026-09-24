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

    test('discovers the most recently published release including prereleases and pins both downloads', async () => {
        const fixture = await releaseFixture();
        const installation = await temporaryDirectory('workbench-install-latest-');
        const discovery = await discoveryFixture([
            release('v9.0.0', '2026-09-21T10:00:00Z'),
            { ...release('v10.0.0', null), draft: true },
            {
                ...release('v0.1.0-alpha.8', '2026-09-24T10:00:00Z'),
                prerelease: true,
                body: 'Notes with "tag_name": "v999.0.0", braces {} and \\ escapes\n',
                assets: [
                    { tag_name: 'v999.0.0', published_at: '2099-01-01T00:00:00Z' },
                ],
            },
        ]);
        const result = await runInstaller('', installation, [], {
            ...discovery.environment,
            WORKBENCH_TEST_RELEASE: fixture.release,
        });

        expect(result.code).toBe(0);
        expect(await discovery.urls()).toEqual([
            'https://api.github.com/repos/pompeii-labs/workbenches/releases?per_page=100',
            `https://github.com/pompeii-labs/workbenches/releases/download/v0.1.0-alpha.8/${fixture.archive}`,
            'https://github.com/pompeii-labs/workbenches/releases/download/v0.1.0-alpha.8/checksums.txt',
        ]);
        expect(await readlink(join(installation, 'wb'))).toBe('workbench');
    });

    test('explicit latest and a custom repository discover through that repository', async () => {
        const discovery = await discoveryFixture([
            release('v1.2.3', '2026-09-24T10:00:00Z'),
        ]);
        const result = await runInstaller(
            '',
            '',
            ['--version', 'latest', '--repository', 'example/cli'],
            discovery.environment
        );
        expect(result.code).not.toBe(0); // The fixture deliberately has no archive.
        expect(await discovery.urls()).toEqual([
            'https://api.github.com/repos/example/cli/releases?per_page=100',
            `https://github.com/example/cli/releases/download/v1.2.3/${resolveReleaseTarget().name}.tar.gz`,
        ]);
    });

    test('environment version and command-line override bypass discovery', async () => {
        for (const args of [[], ['--version', '2.0.0']]) {
            const discovery = await discoveryFixture([]);
            await runInstaller('', '', args, {
                ...discovery.environment,
                WORKBENCH_VERSION: 'v1.2.3',
            });
            expect(await discovery.urls()).toEqual([
                `https://github.com/pompeii-labs/workbenches/releases/download/${args.length ? 'v2.0.0' : 'v1.2.3'}/${resolveReleaseTarget().name}.tar.gz`,
            ]);
        }
    });

    test('a mirror bypasses discovery even when latest is selected', async () => {
        const discovery = await discoveryFixture([]);
        await runInstaller('', '', [], {
            ...discovery.environment,
            WORKBENCH_DOWNLOAD_ROOT: 'https://mirror.example/releases/',
        });
        expect(await discovery.urls()).toEqual([
            `https://mirror.example/releases/${resolveReleaseTarget().name}.tar.gz`,
        ]);
    });

    test('discovery HTTP failures stop before any artifact download', async () => {
        const discovery = await discoveryFixture([
            release('v1.2.3', '2026-09-24T10:00:00Z'),
        ]);
        const result = await runInstaller('', '', [], {
            ...discovery.environment,
            WORKBENCH_TEST_DISCOVERY_STATUS: '22',
        });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('could not discover the latest release');
        expect(await discovery.urls()).toHaveLength(1);
    });

    test.each([
        ['empty list', '[]'],
        ['invalid JSON', '<html>unavailable</html>'],
        ['truncated JSON', '[{"tag_name":"v1.2.3"'],
        ['wrong root', '{"tag_name":"v1.2.3"}'],
        [
            'trailing garbage',
            `${JSON.stringify([release('v1.2.3', '2026-09-24T10:00:00Z')])}garbage`,
        ],
        ['missing publication fields', '[{"tag_name":"v1.2.3"}]'],
        [
            'wrong draft type',
            JSON.stringify([
                { ...release('v1.2.3', '2026-09-24T10:00:00Z'), draft: 'false' },
            ]),
        ],
        [
            'duplicate tag',
            '[{"tag_name":"v1.2.3","tag_name":"v2.0.0","draft":false,"published_at":"2026-09-24T10:00:00Z"}]',
        ],
        [
            'unsafe tag',
            JSON.stringify([release('v1.2.3/../../other', '2026-09-24T10:00:00Z')]),
        ],
        [
            'escaped tag',
            '[{"tag_name":"v1.2.\\u0033","draft":false,"published_at":"2026-09-24T10:00:00Z"}]',
        ],
        [
            'unpublished only',
            JSON.stringify([{ ...release('v1.2.3', null), draft: true }]),
        ],
        ['invalid date', JSON.stringify([release('v1.2.3', 'tomorrow')])],
    ])(
        'rejects %s discovery metadata without downloading artifacts',
        async (_name, metadata) => {
            const discovery = await discoveryFixture(metadata);
            const result = await runInstaller('', '', [], discovery.environment);
            expect(result.code).toBe(1);
            expect(result.stderr).toContain(
                'latest release metadata is missing or invalid'
            );
            expect(await discovery.urls()).toHaveLength(1);
        }
    );

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
            WORKBENCH_VERSION: '',
            WORKBENCH_REPOSITORY: '',
            WORKBENCH_DOWNLOAD_ROOT: '',
            WORKBENCH_ALLOW_INSECURE: '0',
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

function release(tag: string, published: string | null) {
    return { tag_name: tag, draft: false, published_at: published };
}

async function discoveryFixture(metadata: unknown) {
    const directory = await temporaryDirectory('workbench-install-discovery-');
    const response = join(directory, 'response.json');
    const log = join(directory, 'urls.log');
    await writeFile(
        response,
        typeof metadata === 'string' ? metadata : JSON.stringify(metadata)
    );
    await executableFile(
        join(directory, 'curl'),
        `#!/bin/sh
output=''
while [ "$#" -gt 0 ]; do
    if [ "$1" = '-o' ]; then output="$2"; shift 2; else url="$1"; shift; fi
done
printf '%s\\n' "$url" >> "$WORKBENCH_TEST_URL_LOG"
case "$url" in
    https://api.github.com/*)
        [ "\${WORKBENCH_TEST_DISCOVERY_STATUS:-0}" = '0' ] || exit "$WORKBENCH_TEST_DISCOVERY_STATUS"
        cat "$WORKBENCH_TEST_RESPONSE"
        ;;
    *)
        [ -n "\${WORKBENCH_TEST_RELEASE:-}" ] || exit 22
        cp "$WORKBENCH_TEST_RELEASE/\${url##*/}" "$output"
        ;;
esac
`
    );
    return {
        environment: {
            PATH: `${directory}:${process.env.PATH ?? ''}`,
            WORKBENCH_TEST_URL_LOG: log,
            WORKBENCH_TEST_RESPONSE: response,
            WORKBENCH_TEST_DISCOVERY_STATUS: '0',
            WORKBENCH_TEST_RELEASE: '',
        },
        urls: async () => (await readFile(log, 'utf8')).trim().split('\n'),
    };
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
