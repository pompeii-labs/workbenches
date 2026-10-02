import { afterEach, describe, expect, test } from 'bun:test';
import {
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
import { nativeCredentialPaths } from '../../../../src/connections/index.js';
import { SandboxArchive } from '../../../../src/runtimes/remote/disk/archive.js';
import { DiskAssetSnapshot } from '../../../../src/runtimes/remote/disk/snapshot.js';
import { StateStore } from '../../../../src/runtimes/remote/disk/state.js';
import { DiskAssetSource } from '../../../../src/runtimes/staging/disk.js';
import { TransferRules } from '../../../../src/runtimes/staging/rules.js';

const diskAssetSource = new DiskAssetSource();
const rules = new TransferRules('E2B');
const archives = new SandboxArchive(rules);
const sources = { assets: diskAssetSource, local: diskAssetSource, rules };

const directories: string[] = [];
const snapshots: DiskAssetSnapshot[] = [];
afterEach(async () => {
    await Promise.all(snapshots.splice(0).map((snapshot) => snapshot.cleanup()));
    await Promise.all(
        directories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});
async function directory(): Promise<string> {
    const value = await mkdtemp(join(tmpdir(), 'workbench-state-test-'));
    directories.push(value);
    return value;
}
async function archive(content: string, noise?: string): Promise<string> {
    const root = await directory();
    await mkdir(join(root, 'opencode'));
    await writeFile(join(root, 'opencode', 'auth.json'), content);
    if (noise) await writeFile(join(root, 'opencode', 'opencode.db'), noise);
    const snapshot = await DiskAssetSnapshot.create(
        {
            hostPath: root,
            runtimePath: '/state',
            access: 'read-write',
            kind: 'outcome',
            excludedHostPaths: [],
        },
        1_024,
        undefined,
        sources
    );
    snapshots.push(snapshot);
    return snapshot.archive;
}

describe('E2B managed native state', () => {
    test('round-trips agent Git metadata separately from the engine checkout', async () => {
        const root = await directory();
        await mkdir(join(root, 'objects'));
        await writeFile(join(root, 'HEAD'), 'ref: refs/heads/initial\n');
        const input = await DiskAssetSnapshot.create(
            {
                hostPath: root,
                runtimePath: '/workspace/.git',
                access: 'read-write',
                kind: 'git',
                excludedHostPaths: [],
            },
            1_024,
            undefined,
            sources
        );
        snapshots.push(input);
        expect([...input.entries.keys()]).toEqual(['HEAD']);
        const remote = await directory();
        await writeFile(join(remote, 'HEAD'), 'ref: refs/heads/feature\n');
        const result = await DiskAssetSnapshot.create(
            {
                hostPath: remote,
                runtimePath: '/workspace/.git',
                access: 'read-write',
                kind: 'git',
                excludedHostPaths: [],
            },
            1_024,
            undefined,
            sources
        );
        snapshots.push(result);
        const store = new StateStore(archives, root);
        await store.install(result.archive, (await store.source()).version, 1_024);
        expect(await readFile(join(root, 'HEAD'), 'utf8')).toBe(
            'ref: refs/heads/initial\n'
        );
        const resumed = await DiskAssetSnapshot.create(
            {
                hostPath: root,
                runtimePath: '/workspace/.git',
                access: 'read-write',
                kind: 'git',
                excludedHostPaths: [],
            },
            1_024,
            undefined,
            sources
        );
        snapshots.push(resumed);
        expect([...resumed.entries.keys()]).toEqual(['HEAD']);
        expect(
            await readFile(join((await store.source()).directory, 'HEAD'), 'utf8')
        ).toBe('ref: refs/heads/feature\n');
    });
    test('stages only auth files and ignores concurrent session caches in legacy credential generations', async () => {
        const root = await directory();
        const legacy = new StateStore(archives, root);
        await legacy.install(
            await archive('auth', 'old cache'),
            (await legacy.source()).version,
            1_024
        );
        const store = new StateStore(archives, root, nativeCredentialPaths);
        const baseline = await store.source();
        await writeFile(
            join(baseline.directory, 'opencode', 'opencode.db'),
            'changed cache'
        );
        expect((await store.source()).version).toBe(baseline.version);
        await Promise.all([
            store.install(
                await archive('auth', 'first remote cache'),
                baseline.version,
                1_024
            ),
            store.install(
                await archive('auth', 'second remote cache'),
                baseline.version,
                1_024
            ),
        ]);
        expect(await store.source()).toEqual(baseline);
        const snapshot = await DiskAssetSnapshot.create(
            {
                hostPath: root,
                runtimePath: '/credentials',
                access: 'read-write',
                kind: 'credentials',
                excludedHostPaths: [],
            },
            1_024,
            undefined,
            sources
        );
        snapshots.push(snapshot);
        expect([...snapshot.entries.keys()]).toEqual(['opencode/auth.json']);
    });

    test('persists auth alone while still rejecting conflicting credential refreshes', async () => {
        const root = await directory();
        const store = new StateStore(archives, root, nativeCredentialPaths);
        const baseline = await store.source();
        await store.install(
            await archive('first auth', 'cache'),
            baseline.version,
            1_024
        );
        const current = await store.source();
        expect(
            await readFile(join(current.directory, 'opencode', 'auth.json'), 'utf8')
        ).toBe('first auth');
        expect(
            await stat(join(current.directory, 'opencode', 'opencode.db')).catch(
                () => undefined
            )
        ).toBeUndefined();
        await expect(
            store.install(
                await archive('conflicting auth', 'cache'),
                baseline.version,
                1_024
            )
        ).rejects.toThrow('changed during this run');
        expect(await store.source()).toEqual(current);
        await store.install(await archive('second auth'), current.version, 1_024);
        await store.install(
            await archive('third auth'),
            (await store.source()).version,
            1_024
        );
        expect(
            await readdir(join(root, '.workbench-state', 'generations'))
        ).toHaveLength(2);
    });

    test('refuses symlinked credential parents rather than reading outside the store', async () => {
        const root = await directory();
        const outside = await directory();
        await writeFile(join(outside, 'auth.json'), 'outside');
        await symlink(outside, join(root, 'opencode'));
        await expect(
            new StateStore(archives, root, nativeCredentialPaths).source()
        ).rejects.toThrow('non-regular file');
    });

    test('retries an already activated archive after interrupted progress journaling', async () => {
        const root = await directory();
        const store = new StateStore(archives, root);
        const baseline = await store.source();
        const incoming = await archive('refreshed');
        await store.install(incoming, baseline.version, 1_024);
        const current = await store.source();
        expect(await store.install(incoming, baseline.version, 1_024)).toBe(9);
        expect(await store.source()).toEqual(current);
        expect(
            await readdir(join(root, '.workbench-state', 'generations'))
        ).toHaveLength(1);
    });

    test('activates exact private auth bytes without overwriting original host state', async () => {
        const root = await directory();
        await mkdir(join(root, 'opencode'));
        await writeFile(join(root, 'opencode', 'auth.json'), 'original');
        const store = new StateStore(archives, root);
        const baseline = await store.source();
        expect(
            await store.install(await archive('refreshed'), baseline.version, 1_024)
        ).toBe(9);
        const source = await store.source();
        expect(source.directory).not.toBe(root);
        expect(
            await readFile(join(source.directory, 'opencode', 'auth.json'), 'utf8')
        ).toBe('refreshed');
        expect(await readFile(join(root, 'opencode', 'auth.json'), 'utf8')).toBe(
            'original'
        );
        expect(
            (await stat(join(source.directory, 'opencode', 'auth.json'))).mode & 0o777
        ).toBe(0o600);
        const next = await DiskAssetSnapshot.create(
            {
                hostPath: root,
                runtimePath: '/state',
                access: 'read-write',
                kind: 'credentials',
                excludedHostPaths: [],
            },
            1_024,
            undefined,
            sources
        );
        snapshots.push(next);
        expect([...next.entries.keys()]).toEqual(['opencode/auth.json']);
        expect(next.entries.get('opencode/auth.json')?.size).toBe(9);
    });

    test('detects concurrent updates and preserves the activated generation', async () => {
        const root = await directory();
        const store = new StateStore(archives, root);
        const baseline = await store.source();
        await store.install(await archive('first'), baseline.version, 1_024);
        const activated = await store.source();
        await expect(
            store.install(await archive('second'), baseline.version, 1_024)
        ).rejects.toThrow('changed during this run');
        expect(await store.source()).toEqual(activated);
    });

    test('detects original input changed during a run before activating remote credentials', async () => {
        const root = await directory();
        await writeFile(join(root, 'auth.json'), 'before');
        const store = new StateStore(archives, root);
        const baseline = await store.source();
        await writeFile(join(root, 'auth.json'), 'user changed');
        await expect(
            store.install(await archive('remote'), baseline.version, 1_024)
        ).rejects.toThrow('changed during this run');
        expect((await store.source()).directory).toBe(root);
        expect(await readFile(join(root, 'auth.json'), 'utf8')).toBe('user changed');
    });

    test('bounds generations and refuses oversized or symlinked state', async () => {
        const root = await directory();
        const store = new StateStore(archives, root);
        for (const content of ['first', 'second', 'third', 'fourth']) {
            await store.install(
                await archive(content),
                (await store.source()).version,
                1_024
            );
        }
        expect(
            await readdir(join(root, '.workbench-state', 'generations'))
        ).toHaveLength(2);
        const current = await store.source();
        await expect(
            store.install(await archive('oversized'), current.version, 2)
        ).rejects.toThrow('safety limit');
        expect(await store.source()).toEqual(current);
        const malicious = await directory();
        await symlink(root, join(malicious, '.workbench-state'));
        await expect(new StateStore(archives, malicious).source()).rejects.toThrow(
            'real directories'
        );
    });
});
