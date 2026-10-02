import { describe, expect, test } from 'bun:test';

import { MemoryArchive } from '../../../../src/runtimes/staging/memory/archive.js';
import { TransferRules } from '../../../../src/runtimes/staging/rules.js';
import { TarArchive, type TarEntry } from '../../../../src/runtimes/staging/tar.js';

const text = (value: string) => new TextEncoder().encode(value);
const directory = (name: string): TarEntry => ({
    name,
    type: 'directory',
    mode: 0o755,
    content: new Uint8Array(),
});
const file = (name: string): TarEntry => ({
    name,
    type: 'file',
    mode: 0o644,
    content: text('x'),
});

async function read(entries: TarEntry[]) {
    return new MemoryArchive(new TransferRules('Daytona')).unpack(
        await TarArchive.pack(entries).gzip(),
        1024,
        1024
    );
}

describe('MemoryArchive parent conflicts', () => {
    test('accepts a file beneath a directory', async () => {
        const { changed } = await read([directory('a/'), file('a/b')]);
        expect([...changed.keys()]).toEqual(['a/b']);
    });

    test('rejects a child that follows a file at its parent path', async () => {
        await expect(read([file('a'), file('a/b')])).rejects.toThrow(
            'Unsafe Daytona archive parent: a/b'
        );
    });

    test('rejects a file that follows an entry beneath its own path', async () => {
        await expect(read([directory('a/b/'), file('a')])).rejects.toThrow(
            'Unsafe Daytona archive parent: a'
        );
        await expect(read([file('a/b/c'), file('a')])).rejects.toThrow(
            'Unsafe Daytona archive parent: a'
        );
    });
});
