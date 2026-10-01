import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import tar from 'tar-stream';

import { E2BAssetSnapshot } from '../../../src/runtimes/e2b/snapshot.js';
import { DiskAssetSource } from '../../../src/runtimes/staging/disk.js';
import { MemoryAssetSnapshot } from '../../../src/runtimes/staging/memory/snapshot.js';
import { MemoryAssetSource } from '../../../src/runtimes/staging/memory/source.js';
import type {
    SnapshotEntry,
    StreamedRecord,
} from '../../../src/runtimes/staging/plan.js';
import { TransferRules } from '../../../src/runtimes/staging/rules.js';
import type { AssetSource } from '../../../src/runtimes/staging/source.js';
import { ArchiveWriter } from '../../../src/runtimes/staging/writer.js';
import { readArchive } from './archive.js';

const diskAssetSource = new DiskAssetSource();
const rules = new TransferRules('E2B');
const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
});

function binding(hostPath: string) {
    return {
        hostPath,
        runtimePath: '/workspace',
        access: 'read-write' as const,
        excludedHostPaths: [],
        kind: 'workspace' as const,
    };
}

async function tree() {
    const root = await mkdtemp(join(tmpdir(), 'workbench-streaming-'));
    directories.push(root);
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'app.ts'), 'export const a = 1;');
    await writeFile(join(root, 'readme.md'), 'hello');
    await writeFile(join(root, '.npmrc'), 'ignore-scripts=true\n');
    return root;
}

describe('streamed transfer', () => {
    test('reads each disk file once and matches the memory digests', async () => {
        const root = await tree();
        const reads: string[] = [];
        const streams: string[] = [];
        const counted: AssetSource = {
            git: diskAssetSource.git,
            stat: (path) => diskAssetSource.stat(path),
            lstat: (path) => diskAssetSource.lstat(path),
            list: (path) => diskAssetSource.list(path),
            readLink: (path) => diskAssetSource.readLink(path),
            async read(path) {
                reads.push(path);
                return diskAssetSource.read(path);
            },
            stream(path) {
                streams.push(path);
                return diskAssetSource.stream(path);
            },
        };
        const disk = await E2BAssetSnapshot.create(
            binding(root),
            1024 * 1024,
            undefined,
            { assets: counted, local: diskAssetSource, rules }
        );
        try {
            const archive = await readArchive(
                new Uint8Array(await readFile(disk.archive))
            );
            expect(archive['src/app.ts']).toBe('export const a = 1;');
            expect(streams.toSorted()).toEqual([
                join(root, 'readme.md'),
                join(root, 'src/app.ts'),
            ]);
            // Only the small project config is read, to validate it before packing.
            expect(reads.every((path) => path.endsWith('.npmrc'))).toBe(true);
            const memorySource = new MemoryAssetSource()
                .file(`${root}/src/app.ts`, 'export const a = 1;')
                .file(`${root}/readme.md`, 'hello')
                .file(`${root}/.npmrc`, 'ignore-scripts=true\n');
            const memory = await MemoryAssetSnapshot.create(
                memorySource,
                rules,
                binding(root),
                1024 * 1024
            );
            const digests = (entries: Map<string, { digest?: string }>) =>
                Object.fromEntries(
                    [...entries].map(([path, entry]) => [path, entry.digest])
                );
            expect(Object.keys(digests(disk.entries)).length).toBeGreaterThan(0);
            expect(digests(disk.entries)).toEqual(digests(memory.entries));
            expect([...disk.entries.values()].every((entry) => entry.digest)).toBe(
                true
            );
        } finally {
            await disk.cleanup();
        }
    });

    test('refuses a file whose body differs from its recorded size', async () => {
        const root = await tree();
        const lying: AssetSource = {
            git: diskAssetSource.git,
            stat: (path) => diskAssetSource.stat(path),
            lstat: (path) => diskAssetSource.lstat(path),
            list: (path) => diskAssetSource.list(path),
            readLink: (path) => diskAssetSource.readLink(path),
            read: (path) => diskAssetSource.read(path),
            stream: () => new Blob(['short']).stream(),
        };
        await expect(
            E2BAssetSnapshot.create(binding(root), 1024 * 1024, undefined, {
                assets: lying,
                local: diskAssetSource,
                rules,
            })
        ).rejects.toThrow('transfer source changed while reading');
    });

    test('a pack destroyed while the writer waits for room rejects the fill', async () => {
        const pack = tar.pack();
        pack.on('error', () => undefined);
        const size = 4 * 1024 * 1024;
        const chunk = new Uint8Array(64 * 1024);
        let sent = 0;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (sent >= size) {
                    controller.close();
                    return;
                }
                sent += chunk.byteLength;
                controller.enqueue(chunk);
            },
        });
        const entry: SnapshotEntry = { path: 'big', type: 'file', mode: 0o644, size };
        async function* records(): AsyncGenerator<StreamedRecord> {
            yield { type: 'stream', name: 'big', mode: 0o644, size, body, entry };
        }
        // Nothing reads the pack, so the entry fills and the writer waits to drain.
        const writing = new ArchiveWriter(rules).write(pack, records());
        setTimeout(() => pack.destroy(new Error('pack destroyed')), 50);
        const hung = new Promise<string>((resolve) =>
            setTimeout(() => resolve('hung'), 2_000)
        );
        await expect(Promise.race([writing, hung])).rejects.toBeInstanceOf(Error);
        expect(sent).toBeLessThan(size);
    });
});
