import { afterEach, describe, expect, test } from 'bun:test';
import {
    chmod,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rm,
    stat,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    type OutcomeContentDescriptor,
    OutcomeStore,
    type RunOutcome,
} from '../src/outcomes/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-outcome-store-'));
    temporaryDirectories.push(directory);
    return directory;
}

function outcome(
    id: string,
    descriptor: OutcomeContentDescriptor,
    runId = 'wb_1234567890abcdefghij'
): RunOutcome {
    return {
        version: 1,
        id,
        run_id: runId,
        created_at: '2026-09-15T12:00:00.000Z',
        completeness: 'complete',
        changesets: [
            {
                id: 'change_primary',
                workspace: { kind: 'primary' },
                base: {
                    snapshot_digest: `sha256:${'0'.repeat(64)}`,
                },
                entries: [
                    {
                        path: 'result.txt',
                        operation: 'add',
                        after: {
                            kind: 'file',
                            mode: 0o644,
                            content: descriptor,
                        },
                    },
                ],
                stats: {
                    additions: 1,
                    modifications: 0,
                    deletions: 0,
                    binary_files: 0,
                },
            },
        ],
        artifacts: [
            {
                id: 'artifact_result',
                name: 'result.txt',
                content: descriptor,
            },
        ],
        links: [],
        warnings: [],
    };
}

describe('OutcomeStore', () => {
    test('refuses symlinked content storage without writing outside its home', async () => {
        const home = await temporaryDirectory();
        const outside = await temporaryDirectory();
        await symlink(outside, join(home, 'blobs'));
        await expect(
            new OutcomeStore(home).putBytes('private', 'text/plain')
        ).rejects.toThrow('real directories');
        expect(
            await stat(join(outside, '.captures')).catch(() => undefined)
        ).toBeUndefined();
        const other = await temporaryDirectory();
        await mkdir(join(other, 'outcomes'));
        await symlink(outside, join(other, 'outcomes', 'wbo_1234567890abcdefghij'));
        await expect(
            new OutcomeStore(other).read('wbo_1234567890abcdefghij')
        ).rejects.toThrow('real directories');
    });

    test('materializes a named file with original bytes and keeps editors separate from shared content', async () => {
        const home = await temporaryDirectory();
        const store = new OutcomeStore(home);
        const original = Buffer.from([0, 1, 255]);
        const descriptor = await store.putBytes(original, 'image/png');
        const candidate = outcome('wbo_1234567890abcdefghij', descriptor);
        const artifact = candidate.artifacts[0];
        if (!artifact) throw new Error('Expected artifact fixture');
        artifact.name = 'Generated image';
        await store.commit(candidate, 'pending');
        const path = await store.artifactPath(candidate.id, 'artifact_result');
        expect(path).toEndWith('Generated-image.png');
        expect(await readFile(path)).toEqual(original);
        await writeFile(path, 'editor changed its own copy');
        expect(await readFile(await store.blob(descriptor))).toEqual(original);
        await store.close();
    });
    test('commits immutable manifests and deduplicated content', async () => {
        const home = await temporaryDirectory();
        const source = join(home, 'result.txt');
        await writeFile(source, 'portable outcome\n');
        const store = new OutcomeStore(home, {
            now: () => new Date('2026-09-15T12:00:00.000Z'),
        });
        const firstDescriptor = await store.putFile(source, 'text/plain');
        const secondDescriptor = await store.putFile(source, 'text/plain');
        expect(secondDescriptor).toEqual(firstDescriptor);

        const id = 'wbo_1234567890abcdefghij';
        await store.commit(outcome(id, firstDescriptor), 'pending');
        expect(await store.read(id)).toEqual(outcome(id, firstDescriptor));
        expect((await store.receipt(id)).state).toBe('pending');
        expect(await readFile(await store.blob(firstDescriptor), 'utf8')).toBe(
            'portable outcome\n'
        );
        await expect(
            store.commit(outcome(id, firstDescriptor), 'pending')
        ).rejects.toThrow('Outcome already exists');
    });

    test('marks pending outcomes applied without mutating the outcome', async () => {
        const home = await temporaryDirectory();
        const store = new OutcomeStore(home, {
            now: () => new Date('2026-09-15T12:00:00.000Z'),
        });
        const descriptor = await store.putBytes('hello', 'text/plain');
        const id = 'wbo_1234567890abcdefghij';
        await store.commit(outcome(id, descriptor), 'pending');
        const before = await store.read(id);
        const receipt = await store.markApplied(id);
        expect(receipt).toEqual({
            version: 1,
            outcome_id: id,
            state: 'applied',
            updated_at: '2026-09-15T12:00:00.000Z',
            applied_at: '2026-09-15T12:00:00.000Z',
        });
        expect(await store.read(id)).toEqual(before);
        expect(await store.markApplied(id)).toEqual(receipt);
    });

    test('does not mark an in-place outcome as newly applied', async () => {
        const home = await temporaryDirectory();
        const store = new OutcomeStore(home);
        const descriptor = await store.putBytes('hello', 'text/plain');
        const id = 'wbo_1234567890abcdefghij';
        await store.commit(outcome(id, descriptor), 'present');
        await expect(store.markApplied(id)).rejects.toThrow('already present');
    });

    test('refuses missing, oversized, and tampered content', async () => {
        const home = await temporaryDirectory();
        const store = new OutcomeStore(home, {
            maximumContentBytes: 5,
            maximumOutcomeBytes: 5,
        });
        await expect(store.putBytes('too large', 'text/plain')).rejects.toThrow(
            'per-file safety limit'
        );

        const descriptor = await store.putBytes('hello', 'text/plain');
        const id = 'wbo_1234567890abcdefghij';
        await writeFile(await store.blob(descriptor), 'jello');
        await expect(store.commit(outcome(id, descriptor), 'pending')).rejects.toThrow(
            'digest does not match'
        );

        const missing = {
            ...descriptor,
            digest: `sha256:${'f'.repeat(64)}` as const,
        };
        await expect(store.commit(outcome(id, missing), 'pending')).rejects.toThrow(
            'content is unavailable'
        );
    });

    test('closing a capture reclaims unused content and retains committed bytes', async () => {
        const home = await temporaryDirectory();
        const store = new OutcomeStore(home);
        const retained = await store.putBytes('retained', 'text/plain');
        const orphan = await store.putBytes('orphaned', 'text/plain');
        const id = 'wbo_1234567890abcdefghij';
        await store.commit(outcome(id, retained), 'pending');
        await store.close();
        await expect(store.blob(orphan)).rejects.toThrow('content is unavailable');

        const report = await store.collectGarbage();
        expect(report).toEqual({
            removed_blobs: 0,
            removed_bytes: 0,
            retained_blobs: 1,
        });
        expect((await stat(await store.blob(retained))).mode & 0o777).toBe(0o600);
    });

    test('the final closing capture reclaims abandoned bytes without disrupting concurrent capture', async () => {
        const home = await temporaryDirectory();
        const first = new OutcomeStore(home);
        const second = new OutcomeStore(home);
        const abandoned = await first.putBytes('abandoned', 'text/plain');
        const retained = await second.putBytes('still preparing', 'text/plain');
        await first.close();
        expect(await readFile(await second.blob(retained), 'utf8')).toBe(
            'still preparing'
        );
        expect(await second.blob(abandoned)).toBeString();
        await second.commit(outcome('wbo_1234567890abcdefghij', retained), 'pending');
        await second.close();
        await expect(second.blob(abandoned)).rejects.toThrow('content is unavailable');
        expect(await second.blob(retained)).toBeString();
        await second.close();
    });

    test('garbage collection fails closed on replaced outcome directories and invalid capture leases', async () => {
        const home = await temporaryDirectory();
        const store = new OutcomeStore(home);
        const descriptor = await store.putBytes('protected bytes', 'text/plain');
        const id = 'wbo_1234567890abcdefghij';
        await store.commit(outcome(id, descriptor), 'pending');
        await store.close();
        const other = await temporaryDirectory();
        await rm(join(home, 'outcomes', id), { recursive: true });
        await symlink(other, join(home, 'outcomes', id));
        await expect(store.collectGarbage()).rejects.toThrow('real directories');
        expect(await store.blob(descriptor)).toBeString();
        await rm(join(home, 'outcomes', id));
        await writeFile(
            join(home, 'blobs', '.captures', `${crypto.randomUUID()}.json`),
            '{"pid":-1}'
        );
        await expect(store.collectGarbage()).rejects.toThrow('capture lease');
        expect(await store.blob(descriptor)).toBeString();
    });

    test('does not collect content while another capture is awaiting commit', async () => {
        const home = await temporaryDirectory();
        const capture = new OutcomeStore(home);
        const descriptor = await capture.putBytes('not committed yet', 'text/plain');
        const collector = new OutcomeStore(home);
        expect((await collector.collectGarbage()).removed_blobs).toBe(0);
        expect(await readFile(await capture.blob(descriptor), 'utf8')).toBe(
            'not committed yet'
        );
        await capture.commit(
            outcome('wbo_1234567890abcdefghij', descriptor),
            'pending'
        );
        await capture.close();
        expect((await collector.collectGarbage()).retained_blobs).toBe(1);
        await collector.remove('wbo_1234567890abcdefghij');
        expect((await collector.collectGarbage()).removed_blobs).toBe(1);
    });

    test('fails closed when a retained manifest is corrupt', async () => {
        const home = await temporaryDirectory();
        const store = new OutcomeStore(home);
        const descriptor = await store.putBytes('retained', 'text/plain');
        const id = 'wbo_1234567890abcdefghij';
        await store.commit(outcome(id, descriptor), 'pending');
        await store.close();
        await writeFile(join(home, 'outcomes', id, 'outcome.json'), '{broken');
        await expect(store.collectGarbage()).rejects.toThrow();
        expect(await store.blob(descriptor)).toBeString();
    });

    test('reclaims only recognized dead-writer temporaries and repairs quota usage', async () => {
        const home = await temporaryDirectory();
        const store = new OutcomeStore(home);
        const descriptor = await store.putBytes('retained', 'text/plain');
        const id = 'wbo_1234567890abcdefghij';
        const committed = outcome(id, descriptor);
        committed.artifacts = [
            { id: 'artifact_report', name: 'Report.txt', content: descriptor },
        ];
        await store.commit(committed, 'pending');
        await store.artifactPath(id, 'artifact_report');
        await store.close();
        const suffix = '.2147483647.012345abcdef.tmp';
        const blob = await store.blob(descriptor);
        const dead = [
            `${blob}${suffix}`,
            join(home, 'blobs', `.usage.json${suffix}`),
            join(home, 'outcomes', id, `application.json${suffix}`),
            join(home, 'outcomes', id, 'files', `Report.txt${suffix}`),
        ];
        for (const path of dead) await writeFile(path, 'dead');
        const directory = join(home, 'outcomes', `wbo_abcdefghijklmnopqrst${suffix}`);
        await mkdir(directory);
        await writeFile(join(directory, 'outcome.json'), 'dead');
        const live = `${blob}.${process.pid}.012345abcdef.tmp`;
        const unknown = join(home, 'blobs', 'unknown.tmp');
        await writeFile(live, 'live');
        await writeFile(unknown, 'unknown');
        const report = await store.collectGarbage();
        expect(report.removed_bytes).toBe(20);
        expect(report.removed_blobs).toBe(0);
        for (const path of [...dead, directory]) {
            expect(await stat(path).catch(() => undefined)).toBeUndefined();
        }
        expect(await readFile(live, 'utf8')).toBe('live');
        expect(await readFile(unknown, 'utf8')).toBe('unknown');
        expect(await store.read(id)).toEqual(committed);
        expect(
            await readFile(await store.artifactPath(id, 'artifact_report'), 'utf8')
        ).toBe('retained');
        const usage = JSON.parse(
            await readFile(join(home, 'blobs', '.usage.json'), 'utf8')
        ) as { bytes: number };
        expect(usage.bytes).toBeGreaterThan(0);
        const limited = new OutcomeStore(home, { maximumStoreBytes: usage.bytes + 1 });
        expect(await limited.putBytes('x', 'text/plain')).toBeDefined();
        await limited.close();
    });

    test('outcome and blob storage is private on disk', async () => {
        const home = await temporaryDirectory();
        await chmod(home, 0o755);
        const store = new OutcomeStore(home);
        const descriptor = await store.putBytes('private', 'text/plain');
        const id = 'wbo_1234567890abcdefghij';
        await store.commit(outcome(id, descriptor), 'pending');
        expect((await stat(join(home, 'outcomes', id))).mode & 0o777).toBe(0o700);
        expect(
            (await stat(join(home, 'outcomes', id, 'outcome.json'))).mode & 0o777
        ).toBe(0o600);
    });

    test('rejects aggregate capture overflow before copying another blob', async () => {
        const home = await temporaryDirectory();
        const store = new OutcomeStore(home, { maximumOutcomeBytes: 5 });
        const first = await store.putBytes('hello', 'text/plain');
        expect(await store.putBytes('hello', 'text/plain')).toEqual(first);
        const source = join(home, 'overflow.txt');
        await writeFile(source, 'other');
        await expect(store.putFile(source)).rejects.toThrow('aggregate safety limit');
        expect((await store.collectGarbage()).retained_blobs).toBe(1);
        await store.close();
        expect((await store.collectGarbage()).removed_blobs).toBe(0);
    });

    test('enforces a shared quota across concurrent captures without charging duplicate blobs', async () => {
        const home = await temporaryDirectory();
        const stores = [
            new OutcomeStore(home, { maximumStoreBytes: 8 }),
            new OutcomeStore(home, { maximumStoreBytes: 8 }),
        ];
        const descriptors = await Promise.all(
            stores.map((store) => store.putBytes('same', 'text/plain'))
        );
        expect(descriptors[0]).toEqual(descriptors[1]);
        const results = await Promise.allSettled(
            stores.map((store, index) =>
                store.putBytes(index === 0 ? 'aaaa' : 'bbbb', 'text/plain')
            )
        );
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(
            1
        );
        const rejected = results.find((result) => result.status === 'rejected');
        expect(rejected).toMatchObject({
            reason: expect.objectContaining({
                message: expect.stringContaining('quota exceeded'),
            }),
        });
        expect((await stores[0]?.collectGarbage())?.retained_blobs).toBe(2);
        await Promise.all(stores.map((store) => store.close()));
    });

    test('quota failures retain committed results and include metadata in the budget', async () => {
        const home = await temporaryDirectory();
        const store = new OutcomeStore(home, { maximumStoreBytes: 4_096 });
        const descriptor = await store.putBytes('retained', 'text/plain');
        const id = 'wbo_1234567890abcdefghij';
        await store.commit(outcome(id, descriptor), 'pending');
        await store.close();
        const limited = new OutcomeStore(home, { maximumStoreBytes: 8 });
        await expect(limited.putBytes('new', 'text/plain')).rejects.toThrow(
            'quota exceeded'
        );
        expect(await limited.read(id)).toEqual(outcome(id, descriptor));
        expect(await readFile(await limited.blob(descriptor), 'utf8')).toBe('retained');
        await limited.close();

        const other = await temporaryDirectory();
        const metadataLimited = new OutcomeStore(other, { maximumStoreBytes: 8 });
        const content = await metadataLimited.putBytes('12345678', 'text/plain');
        await expect(
            metadataLimited.commit(outcome(id, content), 'pending')
        ).rejects.toThrow('quota exceeded');
        await expect(metadataLimited.read(id)).rejects.toThrow('does not exist');
        await metadataLimited.close();
    });

    test('reclaims failed capture capacity for the next run', async () => {
        const home = await temporaryDirectory();
        const store = new OutcomeStore(home, { maximumStoreBytes: 4 });
        await store.putBytes('aaaa', 'text/plain');
        await expect(store.putBytes('bbbb', 'text/plain')).rejects.toThrow(
            'quota exceeded'
        );
        await store.close();
        const next = await store.putBytes('cccc', 'text/plain');
        expect(await readFile(await store.blob(next), 'utf8')).toBe('cccc');
        await store.close();
    });

    test('repairs stale quota reservations from actual retained files', async () => {
        const home = await temporaryDirectory();
        const first = new OutcomeStore(home, { maximumStoreBytes: 8 });
        await first.putBytes('aaaa', 'text/plain');
        await writeFile(
            join(home, 'blobs', '.usage.json'),
            '{"version":1,"bytes":9999}'
        );
        const second = new OutcomeStore(home, { maximumStoreBytes: 8 });
        await second.putBytes('bbbb', 'text/plain');
        expect((await second.collectGarbage()).retained_blobs).toBe(2);
        await Promise.all([first.close(), second.close()]);
    });

    test('bounds artifact materialization and receipt replacement without corrupting retained content', async () => {
        const home = await temporaryDirectory();
        const store = new OutcomeStore(home);
        const descriptor = await store.putBytes('hello', 'text/plain');
        const id = 'wbo_1234567890abcdefghij';
        await store.commit(outcome(id, descriptor), 'pending');
        await store.close();
        const used = await store.size(id);
        const limited = new OutcomeStore(home, { maximumStoreBytes: used });
        await expect(limited.artifactPath(id, 'artifact_result')).rejects.toThrow(
            'quota exceeded'
        );
        await expect(limited.markApplied(id)).rejects.toThrow('quota exceeded');
        expect((await store.receipt(id)).state).toBe('pending');
        expect(await readFile(await store.blob(descriptor), 'utf8')).toBe('hello');
        expect(
            await readFile(await store.artifactPath(id, 'artifact_result'), 'utf8')
        ).toBe('hello');
    });

    test('rejects symlinked quota ledgers without leaving a live capture marker', async () => {
        const home = await temporaryDirectory();
        const outside = join(await temporaryDirectory(), 'ledger.json');
        await writeFile(outside, 'unchanged');
        await mkdir(join(home, 'blobs'));
        await symlink(outside, join(home, 'blobs', '.usage.json'));
        const store = new OutcomeStore(home);
        await expect(store.putBytes('private', 'text/plain')).rejects.toThrow(
            'regular file'
        );
        expect(await readFile(outside, 'utf8')).toBe('unchanged');
        expect(await readdir(join(home, 'blobs', '.captures'))).toEqual([]);
        await store.close();
    });

    test('bounds manifest metadata and requires valid storage limits and initial receipts', async () => {
        for (const options of [
            { maximumStoreBytes: 0 },
            { maximumOutcomeBytes: NaN },
            { maximumContentBytes: -1 },
            { maximumMetadataBytes: 0 },
            { maximumMetadataBytes: 17 * 1_024 * 1_024 },
        ])
            expect(() => new OutcomeStore('/unused', options)).toThrow();
        const home = await temporaryDirectory();
        const store = new OutcomeStore(home, { maximumMetadataBytes: 32 });
        const descriptor = await store.putBytes('hello', 'text/plain');
        await expect(
            store.commit(outcome('wbo_1234567890abcdefghij', descriptor), 'pending')
        ).rejects.toThrow('metadata exceeds');
        await expect(
            store.commit(outcome('wbo_1234567890abcdefghij', descriptor), 'applied')
        ).rejects.toThrow();
        expect(await store.list()).toEqual([]);
        await store.close();
    });
});
