import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { E2BAssetBinding } from '../src/runtimes/e2b/paths.js';
import { E2BAssetSnapshot } from '../src/runtimes/e2b/snapshot.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('E2B workspace snapshots', () => {
    test('excludes ignored files, repository metadata, and common secrets', async () => {
        const directory = await temporaryDirectory();
        await writeFile(join(directory, '.gitignore'), 'ignored.txt\n');
        await writeFile(join(directory, 'visible.txt'), 'visible');
        await writeFile(join(directory, 'ignored.txt'), 'ignored');
        await writeFile(join(directory, '.env'), 'SECRET=value');
        await writeFile(join(directory, '.env.example'), 'SECRET=example');
        await run(['git', 'init', '-q'], directory);
        await run(
            ['git', 'add', '.gitignore', 'visible.txt', '.env.example'],
            directory
        );
        await run(['git', 'add', '-f', '.env'], directory);

        const snapshot = await E2BAssetSnapshot.create(binding(directory), 1024 * 1024);
        try {
            expect([...snapshot.entries.keys()]).toEqual([
                '.env.example',
                '.gitignore',
                'visible.txt',
            ]);
            expect(snapshot.entries.has('ignored.txt')).toBeFalse();
            expect(snapshot.entries.has('.env')).toBeFalse();
            expect(snapshot.excludedPaths).toContain('.env');
        } finally {
            await snapshot.cleanup();
        }
    });

    test('excludes nested repositories reported as directory entries by git', async () => {
        const directory = await temporaryDirectory();
        const nested = join(directory, '.codex', 'worktrees', 'other');
        await mkdir(nested, { recursive: true });
        await writeFile(join(directory, 'visible.txt'), 'visible');
        await writeFile(join(nested, 'large-checkout-file.txt'), 'do not transfer');
        await run(['git', 'init', '-q'], directory);
        await run(['git', 'init', '-q'], nested);

        const snapshot = await E2BAssetSnapshot.create(binding(directory), 1024);
        try {
            expect([...snapshot.entries.keys()]).toEqual(['visible.txt']);
            expect(snapshot.excludedPaths).toEqual(['.codex/worktrees/other']);
        } finally {
            await snapshot.cleanup();
        }
    });

    test('does not expand tracked Git submodules into the workspace snapshot', async () => {
        const directory = await temporaryDirectory();
        const nested = join(directory, 'vendor', 'module');
        await mkdir(nested, { recursive: true });
        await writeFile(join(directory, 'visible.txt'), 'visible');
        await writeFile(join(nested, 'tracked.txt'), 'nested content');
        await writeFile(join(nested, '.env'), 'SECRET=do-not-transfer');
        await run(['git', 'init', '-q'], directory);
        await run(['git', 'init', '-q'], nested);
        await run(['git', 'add', 'tracked.txt'], nested);
        await run(
            [
                'git',
                '-c',
                'user.name=Workbench',
                '-c',
                'user.email=workbench@localhost',
                'commit',
                '-q',
                '-m',
                'nested fixture',
            ],
            nested
        );
        const nestedHead = await output(['git', 'rev-parse', 'HEAD'], nested);
        await run(
            [
                'git',
                'update-index',
                '--add',
                '--cacheinfo',
                `160000,${nestedHead.trim()},vendor/module`,
            ],
            directory
        );

        const snapshot = await E2BAssetSnapshot.create(binding(directory), 1024);
        try {
            expect([...snapshot.entries.keys()]).toEqual(['visible.txt']);
            expect(snapshot.excludedPaths).toEqual(['vendor/module']);
        } finally {
            await snapshot.cleanup();
        }
    });

    test('enforces the uncompressed transfer cap before upload', async () => {
        const directory = await temporaryDirectory();
        await writeFile(join(directory, 'large.txt'), '123456789');
        await expect(E2BAssetSnapshot.create(binding(directory), 8)).rejects.toThrow(
            'E2B transfer exceeds the 8 B safety limit'
        );
    });

    test('rejects symlinks that escape the transferred root', async () => {
        const directory = await temporaryDirectory();
        await symlink('../outside', join(directory, 'escape'));
        await expect(
            E2BAssetSnapshot.create(binding(directory, 'asset'), 1024)
        ).rejects.toThrow('Escaping symlink is not allowed in E2B transfer');
    });

    test('excludes a separately staged child asset from its writable parent', async () => {
        const directory = await temporaryDirectory();
        const child = join(directory, '.workbenches', 'current');
        await mkdir(child, { recursive: true });
        await writeFile(join(directory, 'visible.txt'), 'visible');
        await writeFile(join(child, 'instructions.md'), 'read only');
        const remote = await temporaryDirectory();
        const remoteChild = join(remote, '.workbenches', 'current');
        await mkdir(remoteChild, { recursive: true });
        await writeFile(join(remote, 'visible.txt'), 'changed');
        await writeFile(join(remoteChild, 'instructions.md'), 'tampered');
        const snapshot = await E2BAssetSnapshot.create(
            {
                ...binding(directory),
                excludedHostPaths: [child],
            },
            1024 * 1024
        );
        const output = await E2BAssetSnapshot.create(
            binding(remote, 'asset'),
            1024 * 1024
        );
        try {
            expect([...snapshot.entries.keys()]).toEqual(['visible.txt']);
            expect(snapshot.syncExcludedPaths).toEqual(['.workbenches/current']);
            await snapshot.apply(output.archive, []);
            expect(await readFile(join(directory, 'visible.txt'), 'utf8')).toBe(
                'changed'
            );
            expect(await readFile(join(child, 'instructions.md'), 'utf8')).toBe(
                'read only'
            );
        } finally {
            await snapshot.cleanup();
            await output.cleanup();
        }
    });

    test('applies remote edits, additions, and deletions', async () => {
        const local = await temporaryDirectory();
        const remote = await temporaryDirectory();
        await writeFile(join(local, 'edited.txt'), 'before');
        await writeFile(join(local, 'deleted.txt'), 'delete me');
        await writeFile(join(remote, 'edited.txt'), 'after');
        await writeFile(join(remote, 'added.txt'), 'new');
        const baseline = await E2BAssetSnapshot.create(binding(local), 1024 * 1024);
        const output = await E2BAssetSnapshot.create(
            binding(remote, 'asset'),
            1024 * 1024
        );
        try {
            await baseline.apply(output.archive, ['deleted.txt']);
            expect(await readFile(join(local, 'edited.txt'), 'utf8')).toBe('after');
            expect(await readFile(join(local, 'added.txt'), 'utf8')).toBe('new');
            await expect(readFile(join(local, 'deleted.txt'))).rejects.toMatchObject({
                code: 'ENOENT',
            });
        } finally {
            await baseline.cleanup();
            await output.cleanup();
        }
    });

    test('rejects oversized uncompressed output before applying it', async () => {
        const local = await temporaryDirectory();
        const remote = await temporaryDirectory();
        await writeFile(join(local, 'unchanged.txt'), 'baseline');
        await writeFile(join(remote, 'large.txt'), '123456789');
        const baseline = await E2BAssetSnapshot.create(binding(local), 1024);
        const output = await E2BAssetSnapshot.create(binding(remote, 'asset'), 1024);
        try {
            await expect(
                baseline.prepareApplication(output.archive, [], 8)
            ).rejects.toThrow('E2B output exceeds the 8 B transfer safety limit');
            expect(await readFile(join(local, 'unchanged.txt'), 'utf8')).toBe(
                'baseline'
            );
            await expect(readFile(join(local, 'large.txt'))).rejects.toMatchObject({
                code: 'ENOENT',
            });
        } finally {
            await baseline.cleanup();
            await output.cleanup();
        }
    });

    test('detects concurrent host edits before applying any remote change', async () => {
        const local = await temporaryDirectory();
        const remote = await temporaryDirectory();
        await writeFile(join(local, 'conflict.txt'), 'baseline');
        await writeFile(join(local, 'safe.txt'), 'baseline');
        const baseline = await E2BAssetSnapshot.create(binding(local), 1024 * 1024);
        await writeFile(join(local, 'conflict.txt'), 'host edit');
        await writeFile(join(remote, 'conflict.txt'), 'remote edit');
        await writeFile(join(remote, 'safe.txt'), 'remote safe edit');
        const output = await E2BAssetSnapshot.create(
            binding(remote, 'asset'),
            1024 * 1024
        );
        try {
            await expect(baseline.apply(output.archive, [])).rejects.toThrow(
                'workspace changed locally during the run'
            );
            expect(await readFile(join(local, 'conflict.txt'), 'utf8')).toBe(
                'host edit'
            );
            expect(await readFile(join(local, 'safe.txt'), 'utf8')).toBe('baseline');
        } finally {
            await baseline.cleanup();
            await output.cleanup();
        }
    });

    test('rejects a host parent replaced by a symlink before applying output', async () => {
        const local = await temporaryDirectory();
        const remote = await temporaryDirectory();
        const outside = await temporaryDirectory();
        await mkdir(join(local, 'nested'));
        await mkdir(join(remote, 'nested'));
        await writeFile(join(local, 'nested', 'value.txt'), 'baseline');
        await writeFile(join(remote, 'nested', 'value.txt'), 'remote edit');
        await writeFile(join(outside, 'value.txt'), 'outside');
        const baseline = await E2BAssetSnapshot.create(binding(local), 1024 * 1024);
        const output = await E2BAssetSnapshot.create(
            binding(remote, 'asset'),
            1024 * 1024
        );
        await rm(join(local, 'nested'), { recursive: true });
        await symlink(outside, join(local, 'nested'));
        try {
            await expect(baseline.apply(output.archive, [])).rejects.toThrow(
                'workspace destination has an unsafe parent'
            );
            expect(await readFile(join(outside, 'value.txt'), 'utf8')).toBe('outside');
        } finally {
            await baseline.cleanup();
            await output.cleanup();
        }
    });
});

function binding(
    hostPath: string,
    kind: E2BAssetBinding['kind'] = 'workspace'
): E2BAssetBinding {
    return {
        hostPath,
        runtimePath: '/workspace',
        access: 'read-write',
        excludedHostPaths: [],
        kind,
    };
}

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-e2b-test-'));
    temporaryDirectories.push(directory);
    await mkdir(directory, { recursive: true });
    return directory;
}

async function run(command: string[], cwd: string): Promise<void> {
    const process = Bun.spawn(command, {
        cwd,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'pipe',
    });
    if ((await process.exited) !== 0) {
        throw new Error(await new Response(process.stderr).text());
    }
}

async function output(command: string[], cwd: string): Promise<string> {
    const process = Bun.spawn(command, {
        cwd,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
    ]);
    if (code !== 0) throw new Error(stderr);
    return stdout;
}
