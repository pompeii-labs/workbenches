import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replaceWindowsExecutable } from '../src/releases/windows.js';
import { RunnerContextStaging } from '../src/runners/context/stage.js';
import { DiskRunnerFiles } from '../src/runners/files/disk.js';
import { PiConfigStaging } from '../src/runners/pi/config.js';
import type { ResolvedWorkbench } from '../src/types.js';

const directories: string[] = [];
afterEach(async () => {
    for (const root of directories.splice(0))
        await rm(root, { recursive: true, force: true });
});
async function directory() {
    const root = await mkdtemp(join(tmpdir(), 'wb-windows-native-'));
    directories.push(root);
    return root;
}

describe.skipIf(process.platform !== 'win32')('Windows native storage', () => {
    test('self-update keeps both installer aliases on the same version', async () => {
        const root = await directory();
        const wb = join(root, 'wb.exe');
        const workbench = join(root, 'workbench.exe');
        const source = join(root, 'new.exe');
        await writeFile(wb, 'old');
        await writeFile(workbench, 'old');
        await writeFile(source, 'new');
        await replaceWindowsExecutable(source, wb);
        expect(await readFile(wb, 'utf8')).toBe('new');
        expect(await readFile(workbench, 'utf8')).toBe('new');
    });
    test('self-update preserves an unrelated sibling executable', async () => {
        const root = await directory();
        await writeFile(join(root, 'wb.exe'), 'old');
        await writeFile(join(root, 'workbench.exe'), 'unrelated');
        await writeFile(join(root, 'new.exe'), 'new');
        await replaceWindowsExecutable(join(root, 'new.exe'), join(root, 'wb.exe'));
        expect(await readFile(join(root, 'workbench.exe'), 'utf8')).toBe('unrelated');
    });
    for (const conflict of [false, true]) {
        test(`Pi refreshes native credentials without symlinks, concurrent refresh=${conflict}`, async () => {
            const root = await directory();
            const native = join(root, '.pi', 'agent');
            await mkdir(native, { recursive: true });
            const source = join(native, 'auth.json');
            await writeFile(source, 'original');
            const instructions = join(root, 'instructions.md');
            await writeFile(instructions, 'Test instructions');
            const files = new DiskRunnerFiles();
            const staging = new PiConfigStaging(files, new RunnerContextStaging(files));
            const config = await staging.stage(
                {
                    instructionsPath: instructions,
                    skills: [],
                    manifest: { name: 'probe', version: '0.1.0' },
                } as unknown as ResolvedWorkbench,
                { USERPROFILE: root },
                {}
            );
            expect((await files.lstat(join(config.directory, 'auth.json')))?.kind).toBe(
                'file'
            );
            await writeFile(join(config.directory, 'auth.json'), 'refreshed');
            if (conflict) {
                await writeFile(source, 'concurrent');
                await expect(config.cleanup()).rejects.toThrow('credentials changed');
                expect(await readFile(source, 'utf8')).toBe('concurrent');
            } else {
                await config.cleanup();
                expect(await readFile(source, 'utf8')).toBe('refreshed');
            }
            expect(await files.lstat(config.directory)).toBeUndefined();
        });
    }
});
