import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const source = join(root, '.workbenches', 'creator', 'skills', 'wb-authoring');
const copy = join(root, 'skills', 'wb-authoring');

async function files(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    return entries
        .filter((entry) => !entry.isDirectory())
        .map((entry) => join(entry.parentPath, entry.name).slice(directory.length + 1))
        .sort();
}

describe('wb-authoring skill', () => {
    test('ships the same files as the creator skill', async () => {
        expect(await files(copy)).toEqual(await files(source));
    });

    test('ships byte-identical file contents', async () => {
        for (const file of await files(source)) {
            const [expected, actual] = await Promise.all([
                readFile(join(source, file)),
                readFile(join(copy, file)),
            ]);
            expect(actual.equals(expected), file).toBe(true);
        }
    });
});
