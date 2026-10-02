import { describe, expect, test } from 'bun:test';

import type { OutcomeChangeset } from '../../../../src/outcomes/contracts.js';
import { MemoryOutcomeSink } from '../../../../src/outcomes/memory.js';
import { MemoryAssetSnapshot } from '../../../../src/runtimes/staging/memory/snapshot.js';
import { MemoryAssetSource } from '../../../../src/runtimes/staging/memory/source.js';
import { TransferRules } from '../../../../src/runtimes/staging/rules.js';
import { TarArchive, type TarEntry } from '../../../../src/runtimes/staging/tar.js';
import type { AssetBinding } from '../../../../src/runtimes/staging/transfer.js';

const rules = new TransferRules('Daytona');
const binding: AssetBinding = {
    hostPath: '/ws',
    runtimePath: '/workspace',
    access: 'read-write',
    excludedHostPaths: [],
    kind: 'workspace',
};
const text = (value: string) => new TextEncoder().encode(value);
const file = (name: string, content: string, mode = 0o644): TarEntry => ({
    name,
    type: 'file',
    mode,
    content: text(content),
});
const directory = (name: string): TarEntry => ({
    name,
    type: 'directory',
    mode: 0o755,
    content: new Uint8Array(),
});
const link = (name: string, target: string): TarEntry => ({
    name,
    type: 'symlink',
    mode: 0o777,
    content: new Uint8Array(),
    link: target,
});

function workspace(): MemoryAssetSource {
    return new MemoryAssetSource()
        .file('/ws/keep.txt', 'keep')
        .file('/ws/edit.txt', 'before')
        .file('/ws/gone.txt', 'bye')
        .file('/ws/dir/one.txt', '1')
        .file('/ws/dir/two.txt', '2')
        .file('/ws/target/inner.txt', 'inner')
        .link('/ws/alias', 'target');
}

interface Run {
    deletions?: string[];
    maximumBytes?: number;
}

/** Stages the workspace, then reads back what a sandbox returned. */
async function outcome(entries: TarEntry[], run: Run = {}) {
    const snapshot = await MemoryAssetSnapshot.create(
        workspace(),
        rules,
        binding,
        1_048_576
    );
    const capture = await snapshot.prepareOutcome({
        archive: await TarArchive.pack(entries).gzip(),
        deletions: run.deletions ?? [],
        workspace: { kind: 'primary' },
        ...(run.maximumBytes === undefined ? {} : { maximumBytes: run.maximumBytes }),
    });
    const sink = new MemoryOutcomeSink();
    return { changeset: await capture.collect(sink), sink };
}

const operations = (changeset: OutcomeChangeset | undefined) =>
    (changeset?.entries ?? []).map((entry) => `${entry.operation}:${entry.path}`);

describe('MemoryAssetSnapshot outcomes', () => {
    test('reports an added file with its content', async () => {
        const { changeset, sink } = await outcome([file('new.txt', 'fresh')]);
        expect(operations(changeset)).toEqual(['add:new.txt']);
        const after = changeset?.entries[0]?.after;
        expect(after?.kind === 'file' && sink.get(after.content)).toEqual(
            text('fresh')
        );
    });

    test('reports a modified file, and nothing for an unchanged one', async () => {
        const { changeset } = await outcome([
            file('edit.txt', 'after'),
            file('keep.txt', 'keep'),
        ]);
        expect(operations(changeset)).toEqual(['modify:edit.txt']);
        expect((await outcome([file('keep.txt', 'keep')])).changeset).toBeUndefined();
    });

    test('reports a deleted file', async () => {
        const { changeset } = await outcome([], { deletions: ['gone.txt'] });
        expect(operations(changeset)).toEqual(['delete:gone.txt']);
    });

    test('a deleted directory deletes the files beneath it', async () => {
        const { changeset } = await outcome([], { deletions: ['dir'] });
        expect(operations(changeset)).toEqual([
            'delete:dir/one.txt',
            'delete:dir/two.txt',
        ]);
    });

    test('refuses a deletion that leaves the workspace', async () => {
        for (const path of ['../outside', 'dir/../../outside', '/etc/passwd']) {
            await expect(outcome([], { deletions: [path] })).rejects.toThrow(
                `Unsafe Daytona archive path: ${path}`
            );
        }
    });

    test('leaves out credentials but keeps example environment files', async () => {
        const { changeset } = await outcome([
            file('.env', 'SECRET=1'),
            file('.env.local', 'SECRET=2'),
            file('.env.example', 'SECRET='),
            file('deploy/key.pem', 'key'),
            file('new.txt', 'x'),
        ]);
        expect(operations(changeset)).toEqual(['add:.env.example', 'add:new.txt']);
    });

    test('refuses a symlink that escapes the workspace or points at an absolute path', async () => {
        await expect(outcome([link('evil', '../../outside')])).rejects.toThrow(
            'Escaping symlink is not allowed in Daytona transfer: evil'
        );
        await expect(outcome([link('evil', '/etc/passwd')])).rejects.toThrow(
            'Absolute symlink is not allowed in Daytona transfer: evil'
        );
        const { changeset } = await outcome([link('ok', 'keep.txt')]);
        expect(operations(changeset)).toEqual(['add:ok']);
    });
});

describe('MemoryAssetSnapshot archive parents', () => {
    test('refuses an entry beneath a link that the baseline holds', async () => {
        await expect(outcome([file('alias/evil.txt', 'x')])).rejects.toThrow(
            'Unsafe Daytona archive parent: alias/evil.txt'
        );
    });

    test('refuses an entry beneath a regular file that the baseline holds', async () => {
        await expect(outcome([file('keep.txt/child', 'x')])).rejects.toThrow(
            'Unsafe Daytona archive parent: keep.txt/child'
        );
    });

    test('refuses an entry beneath a link or file that an earlier entry created', async () => {
        await expect(
            outcome([link('made', 'keep.txt'), file('made/inner', 'x')])
        ).rejects.toThrow('Unsafe Daytona archive parent: made/inner');
        await expect(
            outcome([file('made', 'x'), file('made/inner', 'x')])
        ).rejects.toThrow('Unsafe Daytona archive parent: made/inner');
    });

    test('allows a parent the run deleted and replaced with a directory', async () => {
        const { changeset } = await outcome([file('gone.txt/inner', 'x')], {
            deletions: ['gone.txt'],
        });
        expect(operations(changeset)).toEqual([
            'delete:gone.txt',
            'add:gone.txt/inner',
        ]);
    });

    test('refuses a file where the baseline holds a directory the run kept', async () => {
        await expect(outcome([file('dir', 'now a file')])).rejects.toThrow(
            'Unsafe Daytona archive parent: dir'
        );
        const { changeset } = await outcome([file('dir', 'now a file')], {
            deletions: ['dir/one.txt', 'dir/two.txt'],
        });
        expect(operations(changeset)).toEqual([
            'add:dir',
            'delete:dir/one.txt',
            'delete:dir/two.txt',
        ]);
    });

    test('refuses one path listed as both a file and a directory', async () => {
        await expect(outcome([directory('made/'), file('made', 'x')])).rejects.toThrow(
            'Unsafe Daytona archive path: made'
        );
        await expect(outcome([file('made', 'x'), directory('made/')])).rejects.toThrow(
            'Unsafe Daytona archive path: made'
        );
    });

    test('a dot segment names the path it stands in, not a second one', async () => {
        const { changeset } = await outcome([file('./dir/./one.txt', 'changed')], {
            deletions: ['dir/./two.txt'],
        });
        expect(operations(changeset)).toEqual([
            'modify:dir/one.txt',
            'delete:dir/two.txt',
        ]);
    });
});

describe('MemoryAssetSnapshot limits', () => {
    test('refuses a baseline larger than the limit', async () => {
        await expect(
            MemoryAssetSnapshot.create(workspace(), rules, binding, 10)
        ).rejects.toThrow('Daytona transfer exceeds the 10 B safety limit: /ws is');
        const snapshot = await MemoryAssetSnapshot.create(
            workspace(),
            rules,
            binding,
            1_048_576
        );
        expect(snapshot.bytes).toBe(
            'keep'.length + 'before'.length + 'bye'.length + 2 + 'inner'.length
        );
    });

    test('refuses a limit that is not a positive integer', async () => {
        for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
            await expect(
                MemoryAssetSnapshot.create(workspace(), rules, binding, limit)
            ).rejects.toThrow(
                'Daytona transfer maximumBytes must be a positive integer'
            );
        }
    });

    test('refuses returned content larger than the limit', async () => {
        await expect(
            outcome([file('big.txt', 'x'.repeat(100))], { maximumBytes: 50 })
        ).rejects.toThrow('Daytona output exceeds the 50 B transfer safety limit');
    });
});
