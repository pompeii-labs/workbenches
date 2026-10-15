import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { launchEnvironment } from '../src/platform/environment.js';
import { hostCommand, stopWindowsTree } from '../src/platform/process.js';
import { RepositoryInstructions } from '../src/runners/claude-code/instructions.js';
import { buildOpenCodeServerInvocation } from '../src/runners/opencode/invocation.js';
import { isOutboxPermission } from '../src/runners/opencode/outbox.js';
import { isWindowsPath, windowsInvocation } from '../src/runners/windows.js';
import { MemoryAssetSource } from '../src/runtimes/staging/memory/source.js';
import type { ResolvedWorkbench } from '../src/types.js';
import { executableScript } from './platform.js';

describe('runtime path portability', () => {
    test('recognizes drive and UNC paths while preserving remote POSIX paths', () => {
        expect(isWindowsPath('C:\\workspace')).toBe(true);
        expect(isWindowsPath('C:/workspace')).toBe(true);
        expect(isWindowsPath('\\\\server\\share')).toBe(true);
        expect(isWindowsPath('/workspace')).toBe(false);
    });

    test('grants Windows outboxes without widening drive or parent access', () => {
        expect(
            isOutboxPermission(
                'external_directory',
                ['C:/owned/outbox/*'],
                'C:\\owned\\outbox'
            )
        ).toBe(true);
        expect(
            isOutboxPermission(
                'external_directory',
                ['C:/owned/outbox/reports/*'],
                'C:\\owned\\outbox'
            )
        ).toBe(true);
        for (const path of [
            'C:/*',
            'D:/owned/outbox/*',
            'C:/owned/outbox/../private/*',
            'C:/owned/outbox-other/*',
        ])
            expect(
                isOutboxPermission('external_directory', [path], 'C:\\owned\\outbox')
            ).toBe(false);
        expect(isOutboxPermission('external_directory', ['C:/*'], 'C:\\')).toBe(false);
    });

    test('reads POSIX repository instructions on every host', async () => {
        const source = new MemoryAssetSource().file(
            '/repo/CLAUDE.md',
            'Project guidance'
        );
        const result = await new RepositoryInstructions(source).read('/repo');
        expect(result.text).toContain('Project guidance');
        expect(result.warnings).toEqual([]);
    });
});

describe.skipIf(process.platform !== 'win32')('Windows native wrappers', () => {
    test.each([
        ['1.4.0', undefined, 'private-session.db'],
        ['2.0.0', undefined, undefined],
        ['opencode v2.0.0', 'custom-native.db', 'custom-native.db'],
    ])(
        'selects the native OpenCode database for %s',
        async (version, database, expected) => {
            const directory = await mkdtemp(join(tmpdir(), 'wb-opencode-windows-'));
            try {
                const executable = join(directory, 'opencode');
                await writeFile(
                    executable,
                    `if (process.argv.includes('--version')) console.log(${JSON.stringify(version)});\nelse console.log(JSON.stringify({ database: process.env.OPENCODE_DB, args: process.argv.slice(2) }));`
                );
                await executableScript(executable);
                await writeFile(
                    `${executable}.ps1`,
                    "throw 'Do not run npm PowerShell shims'"
                );
                const workbench = {
                    repositoryDirectory: directory,
                    instructionsPath: join(directory, 'instructions.md'),
                    skills: [],
                    manifest: {
                        runner: 'opencode',
                        model: { id: 'openai/test' },
                        env: {},
                        mcps: [],
                    },
                } as unknown as ResolvedWorkbench;
                const invocation = buildOpenCodeServerInvocation(
                    workbench,
                    'test-password',
                    {
                        ...process.env,
                        PATH: `${directory}${delimiter}${process.env.PATH}`,
                        OPENCODE_DB: database,
                    },
                    undefined,
                    directory,
                    'openai/test',
                    undefined,
                    'private-session.db'
                );
                const child = Bun.spawn(
                    hostCommand(invocation.command, invocation.env),
                    {
                        cwd: invocation.cwd,
                        env: launchEnvironment(invocation.env),
                        stdout: 'pipe',
                        stderr: 'pipe',
                    }
                );
                const [stdout, stderr, code] = await Promise.all([
                    new Response(child.stdout).text(),
                    new Response(child.stderr).text(),
                    child.exited,
                ]);
                expect(stderr, stderr).toBe('');
                expect(code).toBe(0);
                expect(JSON.parse(stdout)).toEqual({
                    ...(expected ? { database: expected } : {}),
                    args: ['serve', '--hostname', '127.0.0.1', '--port', '0'],
                });
            } finally {
                await rm(directory, { recursive: true, force: true });
            }
        }
    );

    test('preserves Unicode input and literal shell characters', async () => {
        const input = "Unicode: café 日本語; $env:PATH 'quoted' `literal`";
        const argument = "argument 'with' $shell; characters";
        const invocation = windowsInvocation(
            {
                command: [
                    process.execPath,
                    '-e',
                    'console.log(JSON.stringify({argument: process.argv[1], input: await Bun.stdin.text()}))',
                    argument,
                ],
                cwd: process.cwd(),
                env: {},
            },
            '',
            input
        );
        const child = Bun.spawn(invocation.command, {
            cwd: invocation.cwd,
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'pipe',
        });
        child.stdin.write(invocation.input as string);
        await child.stdin.end();
        const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
        ]);
        expect(stderr).toBe('');
        expect(code).toBe(0);
        expect(JSON.parse(stdout)).toEqual({ argument, input: `${input}\r\n` });
    });

    test('forwards live RPC input through setup without waiting for EOF', async () => {
        const invocation = windowsInvocation(
            {
                command: [
                    process.execPath,
                    '-e',
                    'for await (const chunk of Bun.stdin.stream()) { console.log(new TextDecoder().decode(chunk).trim()); break; }',
                ],
                cwd: process.cwd(),
                env: {},
            },
            ''
        );
        const child = Bun.spawn(invocation.command, {
            env: launchEnvironment(invocation.env),
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'pipe',
            windowsHide: true,
        });
        try {
            child.stdin.write('{"message":"café"}\n');
            await child.stdin.flush();
            const reader = child.stdout.getReader();
            const first = await reader.read();
            expect(new TextDecoder().decode(first.value).trim()).toBe(
                '{"message":"café"}'
            );
            await reader.cancel();
            await child.stdin.end();
            expect(await child.exited).toBe(0);
        } finally {
            if (child.exitCode === null) stopWindowsTree(child.pid);
        }
    });

    test('preserves the native process exit code', async () => {
        const invocation = windowsInvocation(
            {
                command: [process.execPath, '-e', 'process.exit(7)'],
                cwd: process.cwd(),
                env: {},
            },
            ''
        );
        const child = Bun.spawn(invocation.command, { stdout: 'pipe', stderr: 'pipe' });
        expect(await child.exited).toBe(7);
    });
});
