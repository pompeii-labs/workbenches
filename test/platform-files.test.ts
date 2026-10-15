import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rename, retryWindowsFileOperation } from '../src/platform/files.js';

describe('Windows atomic file replacement', () => {
    test.each(['EPERM', 'EACCES', 'EBUSY'])(
        'retries a transient %s without changing the operation',
        async (code) => {
            let calls = 0;
            const result = await retryWindowsFileOperation(async () => {
                if (++calls < 3)
                    throw Object.assign(new Error('Sharing violation'), { code });
                return 'replaced';
            }, 'win32');
            expect(result).toBe('replaced');
            expect(calls).toBe(3);
        }
    );

    test.each(['ENOENT', 'EEXIST'])(
        'does not retry unrelated errors: %s',
        async (code) => {
            let calls = 0;
            const error = Object.assign(new Error('Cannot rename'), { code });
            await expect(
                retryWindowsFileOperation(async () => {
                    calls++;
                    throw error;
                }, 'win32')
            ).rejects.toBe(error);
            expect(calls).toBe(1);
        }
    );

    test('does not retry on other platforms', async () => {
        let calls = 0;
        const error = Object.assign(new Error('Permission denied'), { code: 'EPERM' });
        await expect(
            retryWindowsFileOperation(async () => {
                calls++;
                throw error;
            }, 'linux')
        ).rejects.toBe(error);
        expect(calls).toBe(1);
    });

    test('bounds retries and preserves the original failure', async () => {
        let calls = 0;
        const error = Object.assign(new Error('Still locked'), { code: 'EPERM' });
        await expect(
            retryWindowsFileOperation(async () => {
                calls++;
                throw error;
            }, 'win32')
        ).rejects.toBe(error);
        expect(calls).toBe(9);
    });

    test('replaces the destination without leaving the staged file', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'wb-atomic-replace-'));
        try {
            const source = join(directory, 'pending');
            const target = join(directory, 'current');
            await writeFile(source, 'new');
            await writeFile(target, 'old');
            await rename(source, target);
            expect(await readFile(target, 'utf8')).toBe('new');
            await expect(readFile(source)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test.skipIf(process.platform !== 'win32')(
        'retries replacement while another process briefly holds a Windows sharing lock',
        async () => {
            const directory = await mkdtemp(join(tmpdir(), 'wb-locked-replace-'));
            const source = join(directory, 'pending');
            const target = join(directory, 'current');
            await writeFile(source, 'new');
            await writeFile(target, 'old');
            const script = [
                "$ErrorActionPreference = 'Stop'",
                '$file = [IO.File]::Open($env:WORKBENCH_TEST_LOCK, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)',
                'try { [Console]::WriteLine("locked"); [Threading.Thread]::Sleep(250) } finally { $file.Dispose() }',
            ].join('\n');
            const child = Bun.spawn(
                [
                    'powershell.exe',
                    '-NoProfile',
                    '-NonInteractive',
                    '-InputFormat',
                    'None',
                    '-EncodedCommand',
                    Buffer.from(script, 'utf16le').toString('base64'),
                ],
                {
                    env: { ...process.env, WORKBENCH_TEST_LOCK: target },
                    stdin: 'ignore',
                    stdout: 'pipe',
                    stderr: 'pipe',
                }
            );
            try {
                const reader = child.stdout.getReader();
                const ready = await reader.read();
                reader.releaseLock();
                expect(new TextDecoder().decode(ready.value).trim()).toBe('locked');
                await rename(source, target);
                expect(await readFile(target, 'utf8')).toBe('new');
                expect(await child.exited).toBe(0);
                expect(await new Response(child.stderr).text()).toBe('');
            } finally {
                if (child.exitCode === null) child.kill();
                await child.exited;
                await rm(directory, { recursive: true, force: true });
            }
        }
    );
});
