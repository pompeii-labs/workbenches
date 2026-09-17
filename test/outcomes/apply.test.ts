import { afterEach, describe, expect, test } from 'bun:test';
import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readlink,
    rm,
    stat,
    symlink,
    unlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    OutcomeApplier,
    OutcomeExporter,
    OutcomeStore,
    type RunOutcome,
    WorkspaceSnapshot,
} from '../../src/outcomes/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-outcome-apply-'));
    temporaryDirectories.push(directory);
    return directory;
}

async function pendingOutcome(): Promise<{
    root: string;
    home: string;
    store: OutcomeStore;
    outcome: RunOutcome;
}> {
    const root = await temporaryDirectory();
    const home = await temporaryDirectory();
    await writeFile(join(root, 'modify.txt'), 'before\n');
    await writeFile(join(root, 'delete.txt'), 'delete\n');
    await writeFile(join(root, 'mode.sh'), '#!/bin/sh\n');
    await chmod(join(root, 'mode.sh'), 0o644);
    const snapshot = await WorkspaceSnapshot.create(root, {
        workspace: { kind: 'primary' },
    });
    const store = new OutcomeStore(home);
    try {
        await writeFile(join(root, 'modify.txt'), 'after\n');
        await writeFile(join(root, 'added.txt'), 'added\n');
        await unlink(join(root, 'delete.txt'));
        await chmod(join(root, 'mode.sh'), 0o755);
        await symlink('added.txt', join(root, 'link'));
        const changeset = await snapshot.collect(store);
        if (!changeset) throw new Error('Expected a changeset');
        const outcome: RunOutcome = {
            version: 1,
            id: 'wbo_1234567890abcdefghij',
            run_id: 'wb_1234567890abcdefghij',
            created_at: '2026-09-15T12:00:00.000Z',
            completeness: 'complete',
            changesets: [changeset],
            artifacts: [],
            links: [],
            warnings: [],
        };
        await store.commit(outcome, 'pending');
        await writeFile(join(root, 'modify.txt'), 'before\n');
        await rm(join(root, 'added.txt'), { force: true });
        await writeFile(join(root, 'delete.txt'), 'delete\n');
        await chmod(join(root, 'mode.sh'), 0o644);
        await rm(join(root, 'link'), { force: true });
        return { root, home, store, outcome };
    } finally {
        await snapshot.cleanup();
    }
}

describe('OutcomeApplier', () => {
    test('applies an isolated changeset and records the receipt', async () => {
        const { root, store, outcome } = await pendingOutcome();
        const result = await new OutcomeApplier(store).apply(outcome, {
            primary: root,
        });
        expect(result).toEqual({ applied: 5, unchanged: 0 });
        expect(await readFile(join(root, 'modify.txt'), 'utf8')).toBe('after\n');
        expect(await readFile(join(root, 'added.txt'), 'utf8')).toBe('added\n');
        expect(
            await lstat(join(root, 'delete.txt')).catch(() => undefined)
        ).toBeUndefined();
        expect((await stat(join(root, 'mode.sh'))).mode & 0o777).toBe(0o755);
        expect(await readlink(join(root, 'link'))).toBe('added.txt');
        expect((await store.receipt(outcome.id)).state).toBe('applied');

        expect(
            await new OutcomeApplier(store).apply(outcome, { primary: root })
        ).toEqual({ applied: 0, unchanged: 5 });
    });

    test('detects conflicts before changing any file', async () => {
        const { root, store, outcome } = await pendingOutcome();
        await writeFile(join(root, 'modify.txt'), 'local conflict\n');
        await expect(
            new OutcomeApplier(store).apply(outcome, { primary: root })
        ).rejects.toThrow('modify.txt');
        expect(await readFile(join(root, 'modify.txt'), 'utf8')).toBe(
            'local conflict\n'
        );
        expect(await readFile(join(root, 'delete.txt'), 'utf8')).toBe('delete\n');
        expect(
            await lstat(join(root, 'added.txt')).catch(() => undefined)
        ).toBeUndefined();
        expect((await store.receipt(outcome.id)).state).toBe('pending');
    });

    test('rolls back every installed path when receipt storage is full', async () => {
        const { root, home, store, outcome } = await pendingOutcome();
        const limited = new OutcomeStore(home, {
            maximumStoreBytes: await store.size(outcome.id),
        });
        await expect(
            new OutcomeApplier(limited).apply(outcome, { primary: root })
        ).rejects.toThrow('quota exceeded');
        expect(await readFile(join(root, 'modify.txt'), 'utf8')).toBe('before\n');
        expect(await readFile(join(root, 'delete.txt'), 'utf8')).toBe('delete\n');
        expect((await stat(join(root, 'mode.sh'))).mode & 0o777).toBe(0o644);
        for (const path of ['added.txt', 'link']) {
            expect(
                await lstat(join(root, path)).catch(() => undefined)
            ).toBeUndefined();
        }
        expect((await store.receipt(outcome.id)).state).toBe('pending');
        expect(await store.read(outcome.id)).toEqual(outcome);
        // A later retry with capacity uses the same immutable result.
        expect(
            await new OutcomeApplier(store).apply(outcome, { primary: root })
        ).toEqual({
            applied: 5,
            unchanged: 0,
        });
    });

    test('rechecks applied receipts against the actual target', async () => {
        const { root, store, outcome } = await pendingOutcome();
        await new OutcomeApplier(store).apply(outcome, { primary: root });
        await writeFile(join(root, 'modify.txt'), 'subsequent edit\n');
        await expect(
            new OutcomeApplier(store).apply(outcome, { primary: root })
        ).rejects.toThrow('modify.txt');
        expect(await readFile(join(root, 'modify.txt'), 'utf8')).toBe(
            'subsequent edit\n'
        );
    });

    test('serializes simultaneous applications and checks the installed content', async () => {
        const { root, store, outcome } = await pendingOutcome();
        const results = await Promise.all([
            new OutcomeApplier(store).apply(outcome, { primary: root }),
            new OutcomeApplier(store).apply(outcome, { primary: root }),
        ]);
        expect(results.map((result) => result.applied).toSorted()).toEqual([0, 5]);
        expect(await readFile(join(root, 'modify.txt'), 'utf8')).toBe('after\n');
    });

    test('does not overwrite edits made during installation and rolls back other paths', async () => {
        const { root, store, outcome } = await pendingOutcome();
        const originalBlob = store.blob.bind(store);
        const after = outcome.changesets[0]?.entries.find(
            (entry) => entry.path === 'modify.txt'
        )?.after;
        store.blob = async (descriptor) => {
            if (after?.kind === 'file' && descriptor.digest === after.content.digest) {
                await writeFile(join(root, 'modify.txt'), 'concurrent edit\n');
            }
            return originalBlob(descriptor);
        };
        await expect(
            new OutcomeApplier(store).apply(outcome, { primary: root })
        ).rejects.toThrow('Workspace changed during');
        expect(await readFile(join(root, 'modify.txt'), 'utf8')).toBe(
            'concurrent edit\n'
        );
        expect(await readFile(join(root, 'delete.txt'), 'utf8')).toBe('delete\n');
        expect(
            await lstat(join(root, 'added.txt')).catch(() => undefined)
        ).toBeUndefined();
        expect((await store.receipt(outcome.id)).state).toBe('pending');
    });

    test('rejects unsafe destination parents', async () => {
        const { root, store, outcome } = await pendingOutcome();
        await mkdir(join(root, 'outside'));
        await symlink('outside', join(root, 'src'));
        const changeset = outcome.changesets[0];
        if (!changeset) throw new Error('Expected changeset');
        changeset.entries.push({
            path: 'src/escape.txt',
            operation: 'add',
            after: changeset.entries.find((entry) => entry.path === 'added.txt')?.after,
        } as RunOutcome['changesets'][number]['entries'][number]);
        changeset.stats.additions += 1;
        await expect(
            new OutcomeApplier(store).apply(outcome, { primary: root })
        ).rejects.toThrow('unsafe parent');
    });
});

describe('OutcomeExporter', () => {
    test('preserves a destination created while export content is being prepared', async () => {
        const { root, store, outcome } = await pendingOutcome();
        const destination = join(root, 'concurrent-destination');
        let created = false;
        const exporter = new OutcomeExporter({
            blob: async (content) => {
                if (!created) {
                    created = true;
                    await mkdir(destination);
                }
                return store.blob(content);
            },
        });
        await expect(exporter.export(outcome, destination)).rejects.toThrow(
            'already exists'
        );
        expect(await lstat(destination)).toBeDefined();
        expect(
            await lstat(join(destination, 'outcome.json')).catch(() => undefined)
        ).toBeUndefined();
    });

    test('only one concurrent exporter can claim a destination', async () => {
        const { root, store, outcome } = await pendingOutcome();
        const destination = join(root, 'concurrent-export');
        const results = await Promise.allSettled([
            new OutcomeExporter(store).export(outcome, destination),
            new OutcomeExporter(store).export(outcome, destination),
        ]);
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(
            1
        );
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(
            1
        );
        expect(await readFile(join(destination, 'outcome.json'), 'utf8')).toContain(
            outcome.id
        );
    });

    test('exports a self-contained review bundle without overwriting', async () => {
        const { root, store, outcome } = await pendingOutcome();
        const artifact = await store.putBytes('<h1>Report</h1>', 'text/html');
        outcome.artifacts.push({
            id: 'artifact_report',
            name: '../Research Report.html',
            content: artifact,
        });
        await store.remove(outcome.id);
        await store.commit(outcome, 'pending');
        const destination = join(root, 'exported');
        expect(await new OutcomeExporter(store).export(outcome, destination)).toBe(
            destination
        );
        expect(await readFile(join(destination, 'outcome.json'), 'utf8')).toContain(
            outcome.id
        );
        expect(
            await readFile(
                join(destination, 'artifacts', 'Research-Report.html'),
                'utf8'
            )
        ).toBe('<h1>Report</h1>');
        expect(
            await readFile(
                join(destination, 'changesets', 'change_primary', 'changes.diff'),
                'utf8'
            )
        ).toContain('diff --git');
        await expect(
            new OutcomeExporter(store).export(outcome, destination)
        ).rejects.toThrow('already exists');
    });
});
