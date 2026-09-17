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
import { E2BAssetSnapshot } from '../../src/runtimes/e2b/snapshot.js';
import { E2BStateStore } from '../../src/runtimes/e2b/state.js';

const directories: string[] = [];
const snapshots: E2BAssetSnapshot[] = [];
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
async function archive(content: string): Promise<string> {
    const root = await directory();
    await mkdir(join(root, 'opencode'));
    await writeFile(join(root, 'opencode', 'auth.json'), content);
    const snapshot = await E2BAssetSnapshot.create(
        {
            hostPath: root,
            runtimePath: '/state',
            access: 'read-write',
            kind: 'outcome',
            excludedHostPaths: [],
        },
        1_024
    );
    snapshots.push(snapshot);
    return snapshot.archive;
}

describe('E2B managed native state', () => {
    test('retries an already activated archive after interrupted progress journaling', async () => {
        const root = await directory();
        const store = new E2BStateStore(root);
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
        const store = new E2BStateStore(root);
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
        const next = await E2BAssetSnapshot.create(
            {
                hostPath: root,
                runtimePath: '/state',
                access: 'read-write',
                kind: 'credentials',
                excludedHostPaths: [],
            },
            1_024
        );
        snapshots.push(next);
        expect([...next.entries.keys()]).toEqual(['opencode/auth.json']);
        expect(next.entries.get('opencode/auth.json')?.size).toBe(9);
    });

    test('detects concurrent updates and preserves the activated generation', async () => {
        const root = await directory();
        const store = new E2BStateStore(root);
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
        const store = new E2BStateStore(root);
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
        const store = new E2BStateStore(root);
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
        await expect(new E2BStateStore(malicious).source()).rejects.toThrow(
            'real directories'
        );
    });
});
