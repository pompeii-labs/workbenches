import { afterEach, describe, expect, spyOn, test } from 'bun:test';
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
import { OutcomeTransition } from '../../src/outcomes/transitions.js';

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

async function pendingReplacement(direction: string) {
    const root = await temporaryDirectory();
    const home = await temporaryDirectory();
    const path = join(root, 'module');
    const before = async () => {
        if (direction === 'fileToDirectory') await writeFile(path, 'before\n');
        else {
            await mkdir(path);
            await chmod(path, 0o750);
            await writeFile(join(path, 'index.ts'), 'before\n');
        }
    };
    await before();
    const snapshot = await WorkspaceSnapshot.create(root, {
        workspace: { kind: 'primary' },
    });
    const store = new OutcomeStore(home);
    try {
        await rm(path, { recursive: true });
        if (direction === 'fileToDirectory') {
            await mkdir(path);
            await writeFile(join(path, 'index.ts'), 'after\n');
        } else await writeFile(path, 'after\n');
        const changeset = await snapshot.collect(store);
        if (!changeset) throw new Error('Expected replacement changeset');
        const outcome = await store.commit(
            {
                version: 1,
                id: OutcomeStore.createId(),
                run_id: 'wb_1234567890abcdefghij',
                created_at: new Date().toISOString(),
                completeness: 'complete',
                changesets: [changeset],
                artifacts: [],
                links: [],
                warnings: [],
            },
            'pending'
        );
        await rm(path, { recursive: true });
        await before();
        return { root, store, outcome, path };
    } finally {
        await snapshot.cleanup();
    }
}

describe('OutcomeApplier', () => {
    for (const direction of ['fileToDirectory', 'directoryToFile']) {
        test(`applies ${direction} replacements and supports idempotent retry`, async () => {
            const { root, store, outcome, path } = await pendingReplacement(direction);
            try {
                expect(
                    await new OutcomeApplier(store).apply(outcome, { primary: root })
                ).toEqual({ applied: 2, unchanged: 0 });
                const after =
                    direction === 'fileToDirectory' ? join(path, 'index.ts') : path;
                expect(await readFile(after, 'utf8')).toBe('after\n');
                expect((await store.receipt(outcome.id)).state).toBe('applied');
                expect(
                    await new OutcomeApplier(store).apply(outcome, { primary: root })
                ).toEqual({ applied: 0, unchanged: 2 });
            } finally {
                await store.close();
            }
        });
        test(`rolls back the original ${direction} tree when receipt persistence fails`, async () => {
            const { root, store, outcome, path } = await pendingReplacement(direction);
            const mark = store.markApplied.bind(store);
            store.markApplied = async () => {
                throw new Error('Receipt failed');
            };
            try {
                await expect(
                    new OutcomeApplier(store).apply(outcome, { primary: root })
                ).rejects.toThrow('Receipt failed');
                const before =
                    direction === 'fileToDirectory' ? path : join(path, 'index.ts');
                expect(await readFile(before, 'utf8')).toBe('before\n');
                if (direction === 'directoryToFile')
                    expect((await stat(path)).mode & 0o777).toBe(0o750);
                expect((await store.receipt(outcome.id)).state).toBe('pending');
                store.markApplied = mark;
                expect(
                    (await new OutcomeApplier(store).apply(outcome, { primary: root }))
                        .applied
                ).toBe(2);
            } finally {
                await store.close();
            }
        });
        test(`rejects concurrent host edits during ${direction} staging`, async () => {
            const { root, store, outcome, path } = await pendingReplacement(direction);
            const before =
                direction === 'fileToDirectory' ? path : join(path, 'index.ts');
            const blob = store.blob.bind(store);
            store.blob = async (descriptor) => {
                await writeFile(before, 'human edit\n');
                return blob(descriptor);
            };
            try {
                await expect(
                    new OutcomeApplier(store).apply(outcome, { primary: root })
                ).rejects.toThrow('Workspace changed during');
                expect(await readFile(before, 'utf8')).toBe('human edit\n');
                expect((await store.receipt(outcome.id)).state).toBe('pending');
            } finally {
                await store.close();
            }
        });
        test(`restores an edit arriving immediately before the ${direction} rename`, async () => {
            const { root, store, outcome, path } = await pendingReplacement(direction);
            const before =
                direction === 'fileToDirectory' ? path : join(path, 'index.ts');
            const prototype = OutcomeTransition.prototype as unknown as {
                assertBefore(): Promise<void>;
            };
            const check = prototype.assertBefore;
            let calls = 0;
            const hook = spyOn(prototype, 'assertBefore').mockImplementation(
                async function (this: OutcomeTransition) {
                    await check.call(this);
                    if (++calls === 2) await writeFile(before, 'late human edit\n');
                }
            );
            try {
                await expect(
                    new OutcomeApplier(store).apply(outcome, { primary: root })
                ).rejects.toThrow('Workspace changed during');
                expect(await readFile(before, 'utf8')).toBe('late human edit\n');
                expect((await store.receipt(outcome.id)).state).toBe('pending');
            } finally {
                hook.mockRestore();
                await store.close();
            }
        });
        test(`preserves a human destination recreated during ${direction} installation`, async () => {
            const { root, store, outcome, path } = await pendingReplacement(direction);
            const prototype = OutcomeTransition.prototype as unknown as {
                assertOriginal(): Promise<void>;
            };
            const check = prototype.assertOriginal;
            let calls = 0;
            const hook = spyOn(prototype, 'assertOriginal').mockImplementation(
                async function (this: OutcomeTransition) {
                    await check.call(this);
                    if (++calls === 1) await writeFile(path, 'recreated human file\n');
                }
            );
            try {
                const error = await new OutcomeApplier(store)
                    .apply(outcome, { primary: root })
                    .then(
                        () => undefined,
                        (cause: unknown) => cause
                    );
                expect(error).toBeInstanceOf(AggregateError);
                if (!(error instanceof AggregateError))
                    throw new Error('Expected recovery error');
                const recovery = error.message.split('Recovery backups remain at ')[1];
                if (!recovery) throw error;
                temporaryDirectories.push(recovery);
                const record = JSON.parse(
                    await readFile(join(recovery, 'recovery.json'), 'utf8')
                );
                const backup = record.transitions[0].backup as string;
                const original =
                    direction === 'fileToDirectory' ? backup : join(backup, 'index.ts');
                expect(await readFile(path, 'utf8')).toBe('recreated human file\n');
                expect(await readFile(original, 'utf8')).toBe('before\n');
                expect((await store.receipt(outcome.id)).state).toBe('pending');
            } finally {
                hook.mockRestore();
                await store.close();
            }
        });
    }
    test('does not discard uncollected host files when replacing a directory', async () => {
        const { root, store, outcome, path } =
            await pendingReplacement('directoryToFile');
        await writeFile(join(path, '.env'), 'host-only data');
        try {
            await expect(
                new OutcomeApplier(store).apply(outcome, { primary: root })
            ).rejects.toThrow('conflicts');
            expect(await readFile(join(path, '.env'), 'utf8')).toBe('host-only data');
            expect(await readFile(join(path, 'index.ts'), 'utf8')).toBe('before\n');
        } finally {
            await store.close();
        }
    });
    test('does not discard unrecorded empty folders when replacing a directory', async () => {
        const { root, store, outcome, path } =
            await pendingReplacement('directoryToFile');
        const empty = join(path, 'keep-empty');
        await mkdir(empty);
        try {
            await expect(
                new OutcomeApplier(store).apply(outcome, { primary: root })
            ).rejects.toThrow('conflicts');
            expect((await stat(empty)).isDirectory()).toBe(true);
            expect(await readFile(join(path, 'index.ts'), 'utf8')).toBe('before\n');
            expect((await store.receipt(outcome.id)).state).toBe('pending');
        } finally {
            await store.close();
        }
    });
    test('preserves a human file created inside the reserved replacement directory', async () => {
        const { root, store, outcome, path } =
            await pendingReplacement('fileToDirectory');
        const prototype = OutcomeTransition.prototype as unknown as {
            reserveDirectory(): Promise<void>;
        };
        const reserve = prototype.reserveDirectory;
        const hook = spyOn(prototype, 'reserveDirectory').mockImplementation(
            async function (this: OutcomeTransition) {
                await reserve.call(this);
                await writeFile(join(path, 'human.txt'), 'human content\n');
            }
        );
        try {
            const error = await new OutcomeApplier(store)
                .apply(outcome, { primary: root })
                .then(
                    () => undefined,
                    (cause: unknown) => cause
                );
            expect(error).toBeInstanceOf(AggregateError);
            if (!(error instanceof AggregateError))
                throw new Error('Expected recovery error');
            const recovery = error.message.split('Recovery backups remain at ')[1];
            if (!recovery) throw error;
            temporaryDirectories.push(recovery);
            const record = JSON.parse(
                await readFile(join(recovery, 'recovery.json'), 'utf8')
            );
            expect(await readFile(join(path, 'human.txt'), 'utf8')).toBe(
                'human content\n'
            );
            expect(await readFile(record.transitions[0].backup, 'utf8')).toBe(
                'before\n'
            );
            expect((await store.receipt(outcome.id)).state).toBe('pending');
        } finally {
            hook.mockRestore();
            await store.close();
        }
    });
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
    test('rejects SDK symlink aliases that turn a contained target into an escape', async () => {
        const { root, store, outcome } = await pendingOutcome();
        const changeset = outcome.changesets[0];
        if (!changeset) throw new Error('Expected changeset');
        changeset.entries.push(
            {
                path: 'a',
                operation: 'add',
                after: { kind: 'symlink', mode: 0o777, target: '.' },
            },
            {
                path: 'd/link',
                operation: 'add',
                after: { kind: 'symlink', mode: 0o777, target: '../a/../outside' },
            }
        );
        changeset.stats.additions += 2;
        outcome.id = OutcomeStore.createId();
        const target = join(await temporaryDirectory(), 'export');
        try {
            await expect(store.commit(outcome, 'pending')).rejects.toThrow(
                'Escaping symlink'
            );
            await expect(
                new OutcomeExporter(store).export(outcome, target)
            ).rejects.toThrow('Escaping symlink');
            await expect(
                new OutcomeApplier(store).apply(outcome, { primary: root })
            ).rejects.toThrow('Escaping symlink');
            expect(await lstat(target).catch(() => undefined)).toBeUndefined();
            expect(await readFile(join(root, 'modify.txt'), 'utf8')).toBe('before\n');
        } finally {
            await store.close();
        }
    });
    test('checks unchanged host symlink aliases before applying a new link', async () => {
        const { root, store, outcome } = await pendingOutcome();
        const changeset = outcome.changesets[0];
        if (!changeset) throw new Error('Expected changeset');
        changeset.entries = [
            {
                path: 'd/link',
                operation: 'add',
                after: { kind: 'symlink', mode: 0o777, target: '../a/../outside' },
            },
        ];
        changeset.stats = {
            additions: 1,
            modifications: 0,
            deletions: 0,
            binary_files: 0,
        };
        outcome.id = OutcomeStore.createId();
        await store.commit(outcome, 'pending');
        await symlink('.', join(root, 'a'));
        try {
            await expect(
                new OutcomeApplier(store).apply(outcome, { primary: root })
            ).rejects.toThrow('Escaping symlink');
            expect(await lstat(join(root, 'd')).catch(() => undefined)).toBeUndefined();
            expect(await readlink(join(root, 'a'))).toBe('.');
            expect((await store.receipt(outcome.id)).state).toBe('pending');
        } finally {
            await store.close();
        }
    });
    test('preserves contained symlink chains in exported bundles', async () => {
        const { store, outcome } = await pendingOutcome();
        const changeset = outcome.changesets[0];
        const file = changeset?.entries.find(
            (entry) => entry.path === 'added.txt'
        )?.after;
        if (!changeset || file?.kind !== 'file') throw new Error('Expected file state');
        changeset.entries = [
            { path: 'folder/item.txt', operation: 'add', after: file },
            {
                path: 'a',
                operation: 'add',
                after: { kind: 'symlink', mode: 0o777, target: 'folder' },
            },
            {
                path: 'd/link',
                operation: 'add',
                after: { kind: 'symlink', mode: 0o777, target: '../a/item.txt' },
            },
        ];
        changeset.stats = {
            additions: 3,
            modifications: 0,
            deletions: 0,
            binary_files: 0,
        };
        outcome.id = OutcomeStore.createId();
        const target = join(await temporaryDirectory(), 'export');
        try {
            await store.commit(outcome, 'pending');
            await new OutcomeExporter(store).export(outcome, target);
            expect(
                await readFile(
                    join(target, 'changesets', changeset.id, 'files', 'd', 'link'),
                    'utf8'
                )
            ).toBe('added\n');
        } finally {
            await store.close();
        }
    });
    test('rejects escaping SDK symlinks at commit and export before materialization', async () => {
        const { root, store, outcome } = await pendingOutcome();
        const entry = outcome.changesets[0]?.entries.find(
            (entry) => entry.path === 'link'
        );
        if (entry?.after?.kind !== 'symlink') throw new Error('Expected symlink');
        entry.after.target = '../outside';
        try {
            await expect(
                store.commit({ ...outcome, id: OutcomeStore.createId() }, 'pending')
            ).rejects.toThrow('Escaping symlink');
            await expect(
                new OutcomeExporter(store).export(outcome, join(root, 'unsafe-export'))
            ).rejects.toThrow('Escaping symlink');
            expect(
                await lstat(join(root, 'unsafe-export')).catch(() => undefined)
            ).toBeUndefined();
        } finally {
            await store.close();
        }
    });
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
