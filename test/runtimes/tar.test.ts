import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    gunzip,
    packTar,
    packTarGzip,
    readTar,
    type TarEntry,
} from '../../src/runtimes/staging/tar.js';
import { readArchive } from './memory-assets.js';

const text = (value: string) => new TextEncoder().encode(value);

function file(name: string, content: string, mode = 0o644): TarEntry {
    return { name, type: 'file', mode, content: text(content) };
}

describe('byte-array tar', () => {
    test('round trips files, links, and modes', () => {
        const entries: TarEntry[] = [
            file('a.txt', 'alpha'),
            file('bin/run.sh', '#!/bin/sh\n', 0o755),
            file('empty', ''),
            {
                name: 'alias',
                type: 'symlink',
                mode: 0o777,
                content: new Uint8Array(),
                link: 'a.txt',
            },
        ];
        const read = readTar(packTar(entries));
        expect(read.map((entry) => entry.name)).toEqual([
            'a.txt',
            'bin/run.sh',
            'empty',
            'alias',
        ]);
        expect(new TextDecoder().decode(read[0]?.content)).toBe('alpha');
        expect(read[1]?.mode).toBe(0o755);
        expect(read[3]).toMatchObject({ type: 'symlink', link: 'a.txt' });
    });

    test('carries names and links longer than a header field through pax', () => {
        const name = `${'deep/'.repeat(40)}file.txt`;
        const link = `${'../'.repeat(10)}${'t'.repeat(150)}`;
        const read = readTar(
            packTar([
                file(name, 'x'),
                {
                    name: 'l',
                    type: 'symlink',
                    mode: 0o777,
                    content: new Uint8Array(),
                    link,
                },
            ])
        );
        expect(read[0]?.name).toBe(name);
        expect(read[1]?.link).toBe(link);
    });

    test('pads contents that end on a block boundary and ones that do not', () => {
        const read = readTar(
            packTar([
                file('a', 'x'.repeat(512)),
                file('b', 'y'.repeat(513)),
                file('c', 'z'),
            ])
        );
        expect(read.map((entry) => entry.content.byteLength)).toEqual([512, 513, 1]);
    });

    test('rejects a corrupt header and a truncated archive', () => {
        const archive = packTar([file('a', 'hello')]);
        const corrupt = archive.slice();
        corrupt[10] = 0x7a;
        expect(() => readTar(corrupt)).toThrow('checksum');
        expect(() => readTar(archive.subarray(0, 515))).toThrow('truncated');
    });

    test('enforces the size limit across entries', () => {
        const archive = packTar([file('a', '12345'), file('b', '67890')]);
        expect(() =>
            readTar(archive, { maximumBytes: 8, limitMessage: () => 'too large' })
        ).toThrow('too large');
        expect(readTar(archive, { maximumBytes: 10 })).toHaveLength(2);
    });

    test('gzip round trips and stops a stream that expands past the limit', async () => {
        const source = text('x'.repeat(100_000));
        const zipped = await packTarGzip([file('big', 'x'.repeat(100_000))]);
        expect(zipped.byteLength).toBeLessThan(source.byteLength);
        const tarBytes = await gunzip(zipped);
        expect(readTar(tarBytes)[0]?.content.byteLength).toBe(100_000);
        await expect(gunzip(zipped, 1_000, () => 'expands too far')).rejects.toThrow(
            'expands too far'
        );
    });

    test('writes archives the tar-stream reader and the system tar accept', async () => {
        const name = `${'long/'.repeat(30)}f.txt`;
        const archive = await packTarGzip([
            file('plain.txt', 'plain'),
            file(name, 'long'),
            {
                name: 'alias',
                type: 'symlink',
                mode: 0o777,
                content: new Uint8Array(),
                link: 'plain.txt',
            },
        ]);
        expect(await readArchive(archive)).toEqual({
            'plain.txt': 'plain',
            [name]: 'long',
            alias: { link: 'plain.txt' },
        });
        const directory = await mkdtemp(join(tmpdir(), 'workbench-tar-'));
        try {
            await writeFile(join(directory, 'in.tar.gz'), archive);
            await mkdir(join(directory, 'out'));
            const extracted = Bun.spawn(
                [
                    'tar',
                    '-xzf',
                    join(directory, 'in.tar.gz'),
                    '-C',
                    join(directory, 'out'),
                ],
                { stdout: 'pipe', stderr: 'pipe' }
            );
            expect(await extracted.exited).toBe(0);
            expect(await readFile(join(directory, 'out', 'plain.txt'), 'utf8')).toBe(
                'plain'
            );
            expect(await readFile(join(directory, 'out', name), 'utf8')).toBe('long');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test('reads a GNU long name record', () => {
        const longName = `${'gnu/'.repeat(40)}file.txt`;
        const headerFor = (name: string, size: number, type: string): Uint8Array => {
            const header = new Uint8Array(512);
            const put = (offset: number, value: string) =>
                header.set(new TextEncoder().encode(value), offset);
            put(0, name);
            put(100, '0000644\0');
            put(124, `${size.toString(8).padStart(11, '0')}\0`);
            put(156, type);
            put(257, 'ustar  \0');
            header.fill(0x20, 148, 156);
            const sum = header.reduce((total, byte) => total + byte, 0);
            put(148, `${sum.toString(8).padStart(6, '0')}\0 `);
            return header;
        };
        const pad = (bytes: Uint8Array) => {
            const out = new Uint8Array(Math.ceil(bytes.byteLength / 512) * 512);
            out.set(bytes);
            return out;
        };
        const nameBytes = new TextEncoder().encode(`${longName}\0`);
        const archive = new Uint8Array([
            ...headerFor('././@LongLink', nameBytes.byteLength, 'L'),
            ...pad(nameBytes),
            ...headerFor(longName.slice(0, 99), 2, '0'),
            ...pad(new TextEncoder().encode('ok')),
            ...new Uint8Array(1024),
        ]);
        const [entry] = readTar(archive);
        expect(entry?.name).toBe(longName);
        expect(new TextDecoder().decode(entry?.content)).toBe('ok');
    });

    test('reads what the system tar writes, including long names and links', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'workbench-tar-read-'));
        try {
            const nested = join(
                directory,
                'src',
                ...Array.from({ length: 12 }, () => 'segment')
            );
            await mkdir(nested, { recursive: true });
            await writeFile(join(nested, 'leaf.txt'), 'leaf');
            await writeFile(join(directory, 'src', 'top.txt'), 'top');
            await symlink('top.txt', join(directory, 'src', 'link'));
            const created = Bun.spawn(
                ['tar', '-C', directory, '-czf', join(directory, 'out.tar.gz'), 'src'],
                { stdout: 'pipe', stderr: 'pipe' }
            );
            expect(await created.exited).toBe(0);
            const entries = readTar(
                await gunzip(
                    new Uint8Array(await readFile(join(directory, 'out.tar.gz')))
                )
            );
            const byName = new Map(
                entries.map((entry) => [entry.name.replace(/\/$/, ''), entry])
            );
            const leaf = `src/${Array.from({ length: 12 }, () => 'segment').join('/')}/leaf.txt`;
            expect(new TextDecoder().decode(byName.get(leaf)?.content)).toBe('leaf');
            expect(byName.get('src/link')).toMatchObject({
                type: 'symlink',
                link: 'top.txt',
            });
            expect(byName.get('src')?.type).toBe('directory');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
