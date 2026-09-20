import { afterEach, describe, expect, test } from 'bun:test';
import {
    chmod,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rename,
    rm,
    symlink,
    truncate,
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
    test('uses Git objects instead of copying a clean local baseline', async () => {
        const root = await repository();
        const snapshot = await WorkspaceSnapshot.create(root, {
            workspace: { kind: 'primary' },
            baseline: 'git',
        });
        const baseline = (snapshot as unknown as { baselineRoot: string }).baselineRoot;
        const store = new OutcomeStore(await temporaryDirectory());
        try {
            expect(await readdir(baseline)).toEqual([]);
            await writeFile(join(root, 'modify.txt'), 'after run\n');
            await unlink(join(root, 'delete.txt'));
            // The captured object stays available even if the index changes mid-run.
            await git(root, 'add', '-A');
            const changeset = await snapshot.collect(store);
            expect(changeset?.entries.map((entry) => entry.path)).toEqual([
                'delete.txt',
                'modify.txt',
            ]);
            expect(await readFile(join(baseline, 'modify.txt'), 'utf8')).toBe(
                'committed\n'
            );
            expect(await readFile(join(baseline, 'delete.txt'), 'utf8')).toBe(
                'delete me\n'
            );
            const review = changeset?.review;
            if (!review) throw new Error('Missing review diff');
            expect(await readFile(await store.blob(review), 'utf8')).toContain(
                '-committed'
            );
        } finally {
            await snapshot.cleanup();
            await store.close();
        }
    });

    test('retains only dirty and untracked local baseline bytes', async () => {
        const root = await repository();
        await writeFile(join(root, 'modify.txt'), 'staged before run\n');
        await git(root, 'add', 'modify.txt');
        await writeFile(join(root, 'delete.txt'), 'unstaged before run\n');
        await writeFile(join(root, 'preexisting.txt'), 'untracked before run\n');
        const snapshot = await WorkspaceSnapshot.create(root, {
            workspace: { kind: 'primary' },
            baseline: 'git',
        });
        const baseline = (snapshot as unknown as { baselineRoot: string }).baselineRoot;
        const store = new OutcomeStore(await temporaryDirectory());
        try {
            expect((await readdir(baseline)).toSorted()).toEqual([
                'delete.txt',
                'preexisting.txt',
            ]);
            await writeFile(join(root, 'modify.txt'), 'changed staged file\n');
            await unlink(join(root, 'delete.txt'));
            await writeFile(join(root, 'preexisting.txt'), 'changed untracked file\n');
            const changeset = await snapshot.collect(store);
            expect(changeset?.entries.map((entry) => entry.path)).toEqual([
                'delete.txt',
                'modify.txt',
                'preexisting.txt',
            ]);
            expect(await readFile(join(baseline, 'modify.txt'), 'utf8')).toBe(
                'staged before run\n'
            );
            const review = changeset?.review;
            if (!review) throw new Error('Missing review diff');
            const patch = await readFile(await store.blob(review), 'utf8');
            expect(patch).toContain('-unstaged before run');
            expect(patch).toContain('-untracked before run');
            expect(patch).toContain('-staged before run');
        } finally {
            await snapshot.cleanup();
            await store.close();
        }
    });

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

    test('skips unsafe links without following them or losing unrelated changes', async () => {
        const root = await repository();
        await symlink('../outside', join(root, 'escape'));
        await symlink('/usr/bin/env', join(root, 'absolute'));
        await symlink('escape/file.txt', join(root, 'indirect'));
        await symlink('loop', join(root, 'loop'));
        const snapshot = await WorkspaceSnapshot.create(root, {
            workspace: { kind: 'primary' },
        });
        const store = new OutcomeStore(await temporaryDirectory());
        try {
            expect(snapshot.warnings[0]?.code).toBe('workspace_paths_excluded');
            expect(snapshot.warnings[0]?.message).toContain('4 unsafe');
            await writeFile(join(root, 'added.txt'), 'a valid result\n');
            await unlink(join(root, 'modify.txt'));
            await symlink('../outside', join(root, 'modify.txt'));
            await symlink('../outside', join(root, 'new-escape'));
            const result = await snapshot.collect(store);
            expect(result?.entries.map((entry) => entry.path)).toEqual(['added.txt']);
            expect(snapshot.warnings[0]?.message).toContain('6 unsafe');
            await unlink(join(root, 'escape'));
            await writeFile(join(root, 'escape'), 'still excluded for this capture\n');
            expect(
                (await snapshot.collect(store))?.entries.map((entry) => entry.path)
            ).toEqual(['added.txt']);
        } finally {
            await snapshot.cleanup();
            await store.close();
        }
    });

    test('does not traverse tracked children through a replaced directory symlink', async () => {
        const root = await repository();
        const outside = await temporaryDirectory();
        await mkdir(join(root, 'tracked'));
        await writeFile(join(root, 'tracked', 'file.txt'), 'before\n');
        await git(root, 'add', 'tracked');
        const snapshot = await WorkspaceSnapshot.create(root, {
            workspace: { kind: 'primary' },
        });
        const store = new OutcomeStore(await temporaryDirectory());
        try {
            await rename(join(root, 'tracked'), join(outside, 'original'));
            await writeFile(join(outside, 'file.txt'), 'not a result\n');
            await symlink(outside, join(root, 'tracked'));
            expect(await snapshot.collect(store)).toBeUndefined();
            expect(snapshot.warnings[0]?.code).toBe('workspace_paths_excluded');
        } finally {
            await snapshot.cleanup();
            await store.close();
        }
    });

    test('still rejects oversized snapshots', async () => {
        const root = await repository();
        await expect(
            WorkspaceSnapshot.create(root, {
                workspace: { kind: 'primary' },
                maximumBytes: 1,
            })
        ).rejects.toThrow('safety limit');
    });

    test('measures an oversized sparse workspace before reading file contents', async () => {
        const root = await repository();
        await writeFile(join(root, 'oversized.bin'), '');
        await truncate(join(root, 'oversized.bin'), 16 * 1_024 * 1_024 * 1_024);
        await expect(
            WorkspaceSnapshot.create(root, {
                workspace: { kind: 'primary' },
                maximumBytes: 1_024,
            })
        ).rejects.toThrow('16 GiB');
    }, 2_000);
});
