import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import packageMetadata from '../package.json' with { type: 'json' };
import { resolveReleaseTarget, verifyReleaseTag } from '../scripts/release-support.js';

const binary = process.env.WORKBENCH_TEST_BINARY;
const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { recursive: true }))
    );
});

describe('release contract', () => {
    test('maps every supported native build target to a stable artifact name', () => {
        expect(resolveReleaseTarget('darwin', 'arm64').name).toBe(
            'workbench-darwin-arm64'
        );
        expect(resolveReleaseTarget('darwin', 'x64').name).toBe('workbench-darwin-x64');
        expect(resolveReleaseTarget('linux', 'arm64').name).toBe(
            'workbench-linux-arm64'
        );
        expect(resolveReleaseTarget('linux', 'x64').name).toBe('workbench-linux-x64');
    });

    test('rejects unsupported operating systems and architectures', () => {
        expect(() => resolveReleaseTarget('win32', 'x64')).toThrow(
            'Unsupported release operating system'
        );
        expect(() => resolveReleaseTarget('linux', 'ia32')).toThrow(
            'Unsupported release architecture'
        );
    });

    test('requires an exact non-development package version tag', () => {
        expect(() => verifyReleaseTag('v0.1.0-alpha.1', '0.1.0-alpha.1')).not.toThrow();
        expect(() => verifyReleaseTag('v0.1.0', '0.1.1')).toThrow(
            'does not match package version'
        );
        expect(() => verifyReleaseTag('v0.0.0', '0.0.0')).toThrow(
            'development-only version'
        );
    });
});

describe.skipIf(!binary)('compiled release startup', () => {
    test('does not execute repository-defined Bun preloads', async () => {
        const directory = await fixture();
        await writeFile(join(directory, 'bunfig.toml'), 'preload = ["./preload.ts"]\n');
        await writeFile(
            join(directory, 'preload.ts'),
            'throw new Error("Repository-defined preload executed on the host");\n'
        );

        const version = await execute(directory, ['--version']);
        expect(version.code).toBe(0);
        expect(version.stdout.trim()).toBe(packageMetadata.version);
        expect(version.stderr).toBe('');

        const help = await execute(directory, ['--help']);
        expect(help.code).toBe(0);
        expect(help.stdout).toContain('USAGE');
        expect(help.stderr).toBe('');
    });

    test('does not automatically load repository dotenv files', async () => {
        const directory = await fixture();
        await writeFile(join(directory, '.env'), 'WB_TELEMETRY_DISABLED=1\n');

        const result = await execute(directory, ['telemetry', 'status']);
        expect(result.code).toBe(0);
        expect(result.stdout.trim()).toBe('anonymous run reporting: on');
        expect(result.stderr).toBe('');
    });

    test('continues to honor explicitly inherited environment', async () => {
        const directory = await fixture();
        await writeFile(join(directory, '.env'), 'WB_TELEMETRY_DISABLED=0\n');

        const result = await execute(directory, ['telemetry', 'status'], {
            WB_TELEMETRY_DISABLED: '1',
        });
        expect(result.code).toBe(0);
        expect(result.stdout.trim()).toBe('anonymous run reporting: off');
        expect(result.stderr).toBe('');
    });
});

async function fixture(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-binary-'));
    directories.push(directory);
    return directory;
}

async function execute(
    directory: string,
    args: string[],
    environment: Record<string, string> = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
    if (!binary) throw new Error('WORKBENCH_TEST_BINARY is required');
    const child = Bun.spawn([resolve(binary), ...args], {
        cwd: directory,
        env: {
            PATH: process.env.PATH ?? '',
            TERM: 'dumb',
            NO_COLOR: '1',
            WORKBENCH_HOME: join(directory, 'engine'),
            ...environment,
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
}
