import { describe, expect, test } from 'bun:test';

import {
    assembleOutput,
    MemoryOutcomeStore,
    type OutcomeSink,
    parseDeclarationSource,
} from '@pompeii-labs/workbench/outcomes';
import { OutcomeStore } from '@pompeii-labs/workbench/outcomes/disk';

describe('in-memory outcome store', () => {
    test('stores content by digest and returns the same bytes', async () => {
        const store = new MemoryOutcomeStore();
        const first = await store.putBytes('hello', 'text/plain');
        const again = await store.putBytes(
            new TextEncoder().encode('hello'),
            'text/plain'
        );
        expect(first).toEqual(again);
        expect(first.size_bytes).toBe(5);
        expect(first.digest).toBe(
            'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
        );
        expect(new TextDecoder().decode(store.get(first))).toBe('hello');
        expect(store.digests()).toEqual([first.digest]);
    });

    test('returns a copy so callers cannot alter stored content', async () => {
        const store = new MemoryOutcomeStore();
        const descriptor = await store.putBytes(
            new Uint8Array([1, 2, 3]),
            'application/octet-stream'
        );
        store.get(descriptor)[0] = 9;
        expect([...store.get(descriptor)]).toEqual([1, 2, 3]);
    });

    test('refuses content past its limit and unknown descriptors', async () => {
        const store = new MemoryOutcomeStore({ maximumContentBytes: 3 });
        await expect(store.putBytes('four', 'text/plain')).rejects.toThrow('exceeds');
        expect(() =>
            store.get({
                digest: `sha256:${'0'.repeat(64)}`,
                media_type: 'text/plain',
                size_bytes: 1,
            })
        ).toThrow('unavailable');
    });

    test('digests match the disk store', async () => {
        const { mkdtemp, rm } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const home = await mkdtemp(join(tmpdir(), 'workbench-memory-store-'));
        try {
            const disk = new OutcomeStore(home);
            const expected = await disk.putBytes('same bytes', 'text/plain');
            expect(
                await new MemoryOutcomeStore().putBytes('same bytes', 'text/plain')
            ).toEqual(expected);
            await disk.close();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });

    test('assembles declared output from any file listing', async () => {
        const store = new MemoryOutcomeStore();
        const declaration = parseDeclarationSource(
            JSON.stringify({
                version: 1,
                summary: 'Done',
                artifacts: [{ path: 'report.md', name: 'Report' }],
                links: [{ label: 'Preview', uri: 'https://example.com/p' }],
            })
        );
        const files = new Map([
            ['notes.txt', 'notes'],
            ['report.md', '# Report'],
        ]);
        const sink: OutcomeSink = store;
        const output = await assembleOutput({
            declaration,
            paths: [...files.keys()],
            put: (path, mediaType) => sink.putBytes(files.get(path) ?? '', mediaType),
        });
        expect(output.summary).toBe('Done');
        expect(output.artifacts.map((artifact) => artifact.path)).toEqual([
            'notes.txt',
            'report.md',
        ]);
        expect(output.artifacts[1]?.name).toBe('Report');
        expect(output.artifacts[1]?.content.media_type).toBe('text/markdown');
        expect(output.links).toEqual([
            {
                id: 'link_preview_1',
                label: 'Preview',
                uri: 'https://example.com/p',
            },
        ]);
    });

    test('rejects a declared artifact that was not returned', async () => {
        await expect(
            assembleOutput({
                declaration: parseDeclarationSource(
                    JSON.stringify({ version: 1, artifacts: [{ path: 'missing.md' }] })
                ),
                paths: [],
                put: async () => {
                    throw new Error('unreachable');
                },
            })
        ).rejects.toThrow('Declared outcome artifact does not exist: missing.md');
    });
});
