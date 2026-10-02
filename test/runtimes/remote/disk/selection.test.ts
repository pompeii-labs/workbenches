import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateSelection } from '../../../../src/runtimes/remote/disk/selection.js';

const directories: string[] = [];
afterEach(async () => {
    await Promise.all(
        directories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});
async function directory(): Promise<string> {
    const value = await mkdtemp(join(tmpdir(), 'workbench-selection-test-'));
    directories.push(value);
    return value;
}

describe('StateSelection', () => {
    test('returns the selected files that exist, sorted', async () => {
        const root = await directory();
        await mkdir(join(root, 'nested'));
        await writeFile(join(root, 'nested', 'b.json'), '{}');
        await writeFile(join(root, 'a.json'), '{}');
        await writeFile(join(root, 'other.json'), '{}');
        const selection = new StateSelection(
            root,
            ['nested/b.json', 'a.json', 'missing.json', 'nested/missing.json'],
            'E2B'
        );
        expect(await selection.existing()).toEqual(['a.json', 'nested/b.json']);
    });

    test('refuses a selected path that is a symlink', async () => {
        const root = await directory();
        await writeFile(join(root, 'real.json'), '{}');
        await symlink(join(root, 'real.json'), join(root, 'a.json'));
        await expect(
            new StateSelection(root, ['a.json'], 'E2B').existing()
        ).rejects.toThrow('E2B native state selection contains a non-regular file');
    });
});
