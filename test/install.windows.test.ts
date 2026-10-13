import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hostEnvironment } from '../src/platform/environment.js';

let root = '';
let archive = '';
let checksum = '';
let serial = 0;
const installer = resolve(import.meta.dir, '../install.ps1');
const stable = (tag: string) => ({
    tag_name: tag,
    draft: false,
    prerelease: false,
    published_at: '2026-10-01T00:00:00Z',
});

beforeAll(async () => {
    if (process.platform !== 'win32') return;
    root = await mkdtemp(join(tmpdir(), 'workbench-windows-installer-'));
    const name = 'workbench-windows-x64';
    await mkdir(join(root, name));
    const source = join(root, 'fixture.ts');
    await writeFile(source, 'console.log("1.2.3");');
    const child = Bun.spawn(
        [
            process.execPath,
            'build',
            '--compile',
            '--outfile',
            join(root, name, 'workbench.exe'),
            source,
        ],
        { stdout: 'ignore', stderr: 'pipe' }
    );
    expect(await child.exited).toBe(0);
    await writeFile(join(root, name, 'LICENSE'), 'fixture license');
    await writeFile(join(root, name, 'NOTICE'), 'fixture notice');
    archive = join(root, `${name}.tar.gz`);
    expect(await Bun.spawn(['tar.exe', '-czf', archive, '-C', root, name]).exited).toBe(
        0
    );
    checksum = new Bun.CryptoHasher('sha256')
        .update(await Bun.file(archive).arrayBuffer())
        .digest('hex');
});
afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
});

async function run(
    options: {
        version?: string;
        badChecksum?: boolean;
        missingChecksum?: boolean;
        releases?: unknown;
        failSecondAlias?: boolean;
    } = {}
) {
    serial += 1;
    const directory = join(root, `install ${serial} café`);
    await mkdir(directory);
    const bin = join(directory, 'bin');
    const log = join(directory, 'urls.txt');
    const harness = join(directory, 'harness.ps1');
    await writeFile(
        harness,
        `
$ErrorActionPreference = 'Stop'
function Invoke-RestMethod { param($Uri, $Headers)
    Add-Content -LiteralPath $env:FIXTURE_LOG -Value $Uri
    return (ConvertFrom-Json $env:FIXTURE_RELEASES)
}
function Invoke-WebRequest { param($Uri, $OutFile, [switch]$UseBasicParsing)
    Add-Content -LiteralPath $env:FIXTURE_LOG -Value $Uri
    if ($OutFile) { Copy-Item -LiteralPath $env:FIXTURE_ARCHIVE -Destination $OutFile; return }
    return @{ Content = $env:FIXTURE_CHECKSUM }
}
function Move-Item { param($LiteralPath, $Destination)
    if ($env:FIXTURE_FAIL_ALIAS -eq '1' -and $LiteralPath -like '*.workbench-install-*wb.exe') { throw 'Fixture installation failure' }
    Microsoft.PowerShell.Management\\Move-Item -LiteralPath $LiteralPath -Destination $Destination
}
try { & $env:FIXTURE_INSTALLER -Version $env:FIXTURE_VERSION -BinDir $env:FIXTURE_BIN; exit 0 }
catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
`
    );
    const child = Bun.spawn(
        ['powershell.exe', '-NoProfile', '-NonInteractive', '-File', harness],
        {
            env: hostEnvironment(process.env, {
                FIXTURE_LOG: log,
                FIXTURE_ARCHIVE: archive,
                FIXTURE_INSTALLER: installer,
                FIXTURE_VERSION: options.version ?? '1.2.3',
                FIXTURE_BIN: bin,
                FIXTURE_RELEASES: JSON.stringify(
                    options.releases ?? [stable('v1.2.3')]
                ),
                FIXTURE_CHECKSUM: options.missingChecksum
                    ? ''
                    : `${options.badChecksum ? '0'.repeat(64) : checksum}  workbench-windows-x64.tar.gz\n`,
                FIXTURE_FAIL_ALIAS: options.failSecondAlias ? '1' : '0',
            }),
            stdout: 'pipe',
            stderr: 'pipe',
        }
    );
    const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
    ]);
    return {
        code,
        stdout,
        stderr,
        bin,
        urls: await readFile(log, 'utf8').catch(() => ''),
    };
}

describe.skipIf(process.platform !== 'win32')('Windows release installer', () => {
    test('verifies and installs both commands in a path with spaces and Unicode', async () => {
        const result = await run();
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toContain('Installed Workbench');
        expect(await Bun.file(join(result.bin, 'workbench.exe')).bytes()).toEqual(
            await Bun.file(join(result.bin, 'wb.exe')).bytes()
        );
        expect(await readFile(join(result.bin, 'LICENSE'), 'utf8')).toBe(
            'fixture license'
        );
    });
    test.each([{ badChecksum: true }, { missingChecksum: true }])(
        'rejects invalid checksums before installing %j',
        async (options) => {
            const result = await run(options);
            expect(result.code).toBe(1);
            expect(result.stderr.toLowerCase()).toContain('checksum');
            expect(await Bun.file(join(result.bin, 'workbench.exe')).exists()).toBe(
                false
            );
        }
    );
    test('pins both downloads to the highest stable version', async () => {
        const result = await run({
            version: 'latest',
            releases: [
                stable('v1.2.3'),
                stable('v1.1.9'),
                { ...stable('v9.0.0'), prerelease: true },
                { ...stable('v8.0.0'), draft: true },
            ],
        });
        expect(result.code, result.stderr).toBe(0);
        expect(result.urls).toContain('/v1.2.3/workbench-windows-x64.tar.gz');
        expect(result.urls).toContain('/v1.2.3/checksums.txt');
        expect(result.urls).not.toContain('/v9.0.0/');
    });
    test('rejects malformed discovery metadata before artifact download', async () => {
        const result = await run({
            version: 'latest',
            releases: [{ tag_name: 'v99.0.0' }],
        });
        expect(result.code).toBe(1);
        expect(result.urls).not.toContain('/releases/download/');
    });
    test('rejects invalid versions before downloading', async () => {
        const result = await run({ version: '../unsafe' });
        expect(result.code).toBe(1);
        expect(result.urls).toBe('');
    });
    test('rolls back an installation when the second alias cannot be installed', async () => {
        const result = await run({ failSecondAlias: true });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('Fixture installation failure');
        expect(await Bun.file(join(result.bin, 'workbench.exe')).exists()).toBe(false);
        expect(await Bun.file(join(result.bin, 'wb.exe')).exists()).toBe(false);
    });
});
