import { afterEach, describe, expect, test } from 'bun:test';
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    symlink,
    unlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OutcomeStore, WorkspaceSnapshot } from '../../src/outcomes/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-outcome-workspace-'));
    temporaryDirectories.push(directory);
    return directory;
}

async function git(root: string, ...args: string[]): Promise<string> {
    const child = Bun.spawn(['git', ...args], {
        cwd: root,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(stderr);
    return stdout.trim();
}

async function repository(): Promise<string> {
    const root = await temporaryDirectory();
    await git(root, 'init', '-q');
    await git(root, 'config', 'user.email', 'workbench@localhost');
    await git(root, 'config', 'user.name', 'Workbench');
    await writeFile(join(root, '.gitignore'), 'ignored.txt\nnode_modules/\n');
    await writeFile(join(root, 'modify.txt'), 'committed\n');
    await writeFile(join(root, 'delete.txt'), 'delete me\n');
    await writeFile(join(root, 'mode.sh'), '#!/bin/sh\nexit 0\n');
    await chmod(join(root, 'mode.sh'), 0o644);
    await git(root, 'add', '.');
    await git(root, 'commit', '-q', '-m', 'baseline');
    return root;
}

describe('WorkspaceSnapshot', () => {
    test('isolates changes made after a dirty workspace baseline', async () => {
        const root = await repository();
        await writeFile(join(root, 'modify.txt'), 'dirty before run\n');
        await writeFile(join(root, 'preexisting.txt'), 'already here\n');
        const snapshot = await WorkspaceSnapshot.create(root, {
            workspace: { kind: 'primary' },
        });
        const store = new OutcomeStore(await temporaryDirectory());
        try {
            await writeFile(join(root, 'modify.txt'), 'changed by run\n');
            await writeFile(join(root, 'added.txt'), 'new from run\n');
            await unlink(join(root, 'delete.txt'));
            await chmod(join(root, 'mode.sh'), 0o755);
            await writeFile(join(root, 'binary.bin'), new Uint8Array([0, 1, 2, 3]));
            await symlink('added.txt', join(root, 'result-link'));
            await writeFile(join(root, 'ignored.txt'), 'not an outcome\n');
            await mkdir(join(root, 'node_modules'));
            await writeFile(join(root, 'node_modules', 'package.js'), 'ignored\n');
            await writeFile(join(root, '.env'), 'SECRET=nope\n');

            const changeset = await snapshot.collect(store);
            expect(changeset?.entries.map((entry) => entry.path)).toEqual([
                'added.txt',
                'binary.bin',
                'delete.txt',
                'mode.sh',
                'modify.txt',
                'result-link',
            ]);
            expect(changeset?.stats).toEqual({
                additions: 3,
                modifications: 2,
                deletions: 1,
                binary_files: 1,
            });
            const modified = changeset?.entries.find(
                (entry) => entry.path === 'modify.txt'
            );
            expect(modified?.operation).toBe('modify');
            if (modified?.before?.kind !== 'file') {
                throw new Error('Expected a file fingerprint');
            }
            expect(modified.before.digest).not.toBe(`sha256:${'0'.repeat(64)}`);
            if (modified.after?.kind !== 'file') {
                throw new Error('Expected a file outcome state');
            }
            expect(
                await readFile(await store.blob(modified.after.content), 'utf8')
            ).toBe('changed by run\n');
            expect(changeset?.review).toBeDefined();
            if (changeset?.review) {
                const review = await readFile(
                    await store.blob(changeset.review),
                    'utf8'
                );
                expect(review).toContain('diff --git a/modify.txt b/modify.txt');
                expect(review).toContain('-dirty before run');
                expect(review).toContain('+changed by run');
            }
        } finally {
            await snapshot.cleanup();
        }
    });

    test('returns no changeset when the workspace is unchanged', async () => {
        const root = await repository();
        const snapshot = await WorkspaceSnapshot.create(root, {
            workspace: { kind: 'primary' },
        });
        try {
            expect(
                await snapshot.collect(new OutcomeStore(await temporaryDirectory()))
            ).toBeUndefined();
        } finally {
            await snapshot.cleanup();
        }
    });

    test('excludes nested workspace roots from a parent snapshot', async () => {
        const root = await repository();
        const nested = join(root, 'nested');
        await mkdir(nested);
        await writeFile(join(nested, 'file.txt'), 'before\n');
        const snapshot = await WorkspaceSnapshot.create(root, {
            workspace: { kind: 'primary' },
            excludedPaths: [nested],
        });
        try {
            await writeFile(join(nested, 'file.txt'), 'after\n');
            expect(
                await snapshot.collect(new OutcomeStore(await temporaryDirectory()))
            ).toBeUndefined();
        } finally {
            await snapshot.cleanup();
        }
    });

    test('rejects escaping symlinks and oversized snapshots', async () => {
        const root = await repository();
        await symlink('../outside', join(root, 'escape'));
        await expect(
            WorkspaceSnapshot.create(root, {
                workspace: { kind: 'primary' },
            })
        ).rejects.toThrow('Escaping symlink');
        await unlink(join(root, 'escape'));
        await expect(
            WorkspaceSnapshot.create(root, {
                workspace: { kind: 'primary' },
                maximumBytes: 1,
            })
        ).rejects.toThrow('safety limit');
    });
});
