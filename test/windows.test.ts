import { describe, expect, test } from 'bun:test';
import { launchEnvironment } from '../src/platform/environment.js';
import { stopWindowsTree } from '../src/platform/process.js';
import { RepositoryInstructions } from '../src/runners/claude-code/instructions.js';
import { isOutboxPermission } from '../src/runners/opencode/outbox.js';
import { isWindowsPath, windowsInvocation } from '../src/runners/windows.js';
import { MemoryAssetSource } from '../src/runtimes/staging/memory/source.js';

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
