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
    for (const provider of ['E2B', 'Daytona']) {
        test(`${provider} removes read-only state overlays after staging`, async () => {
            const providerRules = new TransferRules(provider);
            const providerSources = {
                assets: diskAssetSource,
                local: diskAssetSource,
                rules: providerRules,
            };
            const root = await directory();
            const config = join(root, 'claude-code-config');
            await mkdir(join(config, 'skills', 'review'), { recursive: true });
            await writeFile(join(config, 'skills', 'review', 'SKILL.md'), 'current');
            const store = new StateStore(new SandboxArchive(providerRules), root);
            const remote = await claudeStateArchive(
                providerSources,
                'remote settings',
                'transcript'
            );
            await store.install(remote, (await store.source()).version, 1_024);
            await chmod(join(config, 'skills', 'review', 'SKILL.md'), 0o444);
            await chmod(join(config, 'skills', 'review'), 0o555);
            await chmod(join(config, 'skills'), 0o555);

            const overlaid = new StateStore(
                new SandboxArchive(providerRules),
                root,
                undefined,
                ['claude-code-config/skills']
            );
            let overlayDirectory = '';
            try {
                await overlaid.withSource(async (source) => {
                    overlayDirectory = source.directory;
                    expect(
                        await readFile(
                            join(
                                source.directory,
                                'claude-code-config',
                                'skills',
                                'review',
                                'SKILL.md'
                            ),
                            'utf8'
                        )
                    ).toBe('current');
                });
            } finally {
                await restoreOwnerWrite(root);
                if (overlayDirectory) {
                    await restoreOwnerWrite(overlayDirectory);
                    await rm(overlayDirectory, { recursive: true, force: true });
                }
            }
            expect(await stat(overlayDirectory).catch(() => undefined)).toBeUndefined();
        });

        test(`${provider} cleanup ignores overlay symlinks and git metadata`, async () => {
            const providerRules = new TransferRules(provider);
            const root = await directory();
            const config = join(root, 'claude-code-config');
            const outside = join(root, 'outside.sh');
            await mkdir(join(config, 'skills', 'review'), { recursive: true });
            await writeFile(join(config, 'skills', 'review', 'SKILL.md'), 'current');
            await writeFile(outside, '#!/bin/sh\n');
            await chmod(outside, 0o755);
            const base = new StateStore(new SandboxArchive(providerRules), root);
            const remote = await claudeStateArchive(
                {
                    assets: diskAssetSource,
                    local: diskAssetSource,
                    rules: providerRules,
                },
                'remote settings',
                'transcript'
            );
            await base.install(remote, (await base.source()).version, 1_024);
            await mkdir(join(config, '.git'), { recursive: true });
            await symlink(outside, join(config, 'skills', 'review', 'outside.sh'));
            const store = new StateStore(
                new SandboxArchive(providerRules),
                root,
                undefined,
                ['claude-code-config']
            );

            await expect(store.withSource(async () => {})).resolves.toBeUndefined();
            expect((await stat(outside)).mode & 0o777).toBe(0o755);
        });

        test(`${provider} ignores engine config changes but detects competing transcript activation`, async () => {
            const providerRules = new TransferRules(provider);
            const providerSources = {
                assets: diskAssetSource,
                local: diskAssetSource,
                rules: providerRules,
            };
            const root = await directory();
            const config = join(root, 'claude-code-config');
            await mkdir(join(config, 'projects'), { recursive: true });
            await writeFile(join(config, 'settings.json'), 'first settings');
            const binding = {
                hostPath: root,
                runtimePath: '/state',
                access: 'read-write' as const,
                kind: 'state' as const,
                excludedHostPaths: [],
                stateOverlay: ['claude-code-config/settings.json'],
            };
            const first = await DiskAssetSnapshot.create(
                binding,
                1_024,
                undefined,
                providerSources
            );
            snapshots.push(first);
            await rm(join(config, 'settings.json'));
            const firstRemote = await claudeStateArchive(
                providerSources,
                'remote settings',
                'first transcript'
            );
            await first.persistState(firstRemote, 1_024);

            const store = new StateStore(new SandboxArchive(providerRules), root);
            expect(
                await readFile(
                    join(
                        (await store.source()).directory,
                        'claude-code-config',
                        'projects',
                        'session.jsonl'
                    ),
                    'utf8'
                )
            ).toBe('first transcript');

            await writeFile(join(config, 'settings.json'), 'second settings');
            const resumed = await DiskAssetSnapshot.create(
                binding,
                1_024,
                undefined,
                providerSources
            );
            snapshots.push(resumed);
            await rm(join(config, 'settings.json'));
            const resumedRemote = await claudeStateArchive(
                providerSources,
                'remote settings',
                'resumed transcript'
            );
            await resumed.persistState(resumedRemote, 1_024);
            expect(
                await readFile(
                    join(
                        (await store.source()).directory,
                        'claude-code-config',
                        'projects',
                        'session.jsonl'
                    ),
                    'utf8'
                )
            ).toBe('resumed transcript');

            const stale = await DiskAssetSnapshot.create(
                binding,
                1_024,
                undefined,
                providerSources
            );
            snapshots.push(stale);
            const competing = await claudeStateArchive(
                providerSources,
                'remote settings',
                'competing transcript'
            );
            await store.install(competing, (await store.source()).version, 1_024);
            await expect(stale.persistState(resumedRemote, 1_024)).rejects.toThrow(
                'changed during this run'
            );
        });

        test(`${provider} keeps OpenCode native state conflict-sensitive`, async () => {
            const providerRules = new TransferRules(provider);
            const providerSources = {
                assets: diskAssetSource,
                local: diskAssetSource,
                rules: providerRules,
            };
            const root = await directory();
            await mkdir(join(root, 'opencode'));
            await writeFile(join(root, 'opencode', 'session.json'), 'before');
            const captured = await DiskAssetSnapshot.create(
                {
                    hostPath: root,
                    runtimePath: '/state',
                    access: 'read-write',
                    kind: 'state',
                    excludedHostPaths: [],
                },
                1_024,
                undefined,
                providerSources
            );
            snapshots.push(captured);
            await writeFile(join(root, 'opencode', 'session.json'), 'concurrent');
            const incoming = await opencodeStateArchive(providerSources, 'remote');
            await expect(captured.persistState(incoming, 1_024)).rejects.toThrow(
                'changed during this run'
            );
        });
    }

    test('overlays current engine config while retaining remote transcripts', async () => {
        const root = await directory();
        await mkdir(join(root, 'claude-code-config', 'projects'), {
            recursive: true,
        });
        await mkdir(join(root, 'claude-code-config', '.workbench-context'), {
            recursive: true,
        });
        await writeFile(
            join(root, 'claude-code-config', 'settings.json'),
            'first settings'
        );
        await writeFile(
            join(root, 'claude-code-config', '.workbench-context', 'system.md'),
            'first package instructions\nfirst repository CLAUDE.md'
        );
        await writeFile(
            join(root, 'claude-code-config', 'projects', 'session.jsonl'),
            'first'
        );
        const store = new StateStore(archives, root);
        const remote = await directory();
        await mkdir(join(remote, 'claude-code-config', 'projects'), {
            recursive: true,
        });
        await mkdir(join(remote, 'claude-code-config', '.workbench-context'), {
            recursive: true,
        });
        await writeFile(
            join(remote, 'claude-code-config', 'settings.json'),
            'stale settings'
        );
        await writeFile(
            join(remote, 'claude-code-config', '.workbench-context', 'system.md'),
            'stale instructions'
        );
        await writeFile(
            join(remote, 'claude-code-config', 'projects', 'session.jsonl'),
            'remote'
        );
        const captured = await DiskAssetSnapshot.create(
            {
                hostPath: remote,
                runtimePath: '/state',
                access: 'read-write',
                kind: 'outcome',
                excludedHostPaths: [],
            },
            1_024,
            undefined,
            sources
        );
        snapshots.push(captured);
        await store.install(captured.archive, (await store.source()).version, 1_024);
        await writeFile(
            join(root, 'claude-code-config', 'settings.json'),
            'second settings'
        );
        await writeFile(
            join(root, 'claude-code-config', '.workbench-context', 'system.md'),
            'second package instructions\nsecond repository CLAUDE.md'
        );

        const overlaid = new StateStore(archives, root, undefined, [
            'claude-code-config/settings.json',
            'claude-code-config/.workbench-context',
        ]);
        await overlaid.withSource(async (source) => {
            expect(
                await readFile(
                    join(source.directory, 'claude-code-config', 'settings.json'),
                    'utf8'
                )
            ).toBe('second settings');
            expect(
                await readFile(
                    join(
                        source.directory,
                        'claude-code-config',
                        '.workbench-context',
                        'system.md'
                    ),
                    'utf8'
                )
            ).toContain('second package instructions');
            expect(
                await readFile(
                    join(
                        source.directory,
                        'claude-code-config',
                        '.workbench-context',
                        'system.md'
                    ),
                    'utf8'
                )
            ).toContain('second repository CLAUDE.md');
            expect(
                await readFile(
                    join(
                        source.directory,
                        'claude-code-config',
                        'projects',
                        'session.jsonl'
                    ),
                    'utf8'
                )
            ).toBe('remote');
        });
    });

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

async function restoreOwnerWrite(path: string): Promise<void> {
    const details = await stat(path).catch(() => undefined);
    if (!details) return;
    if (!details.isDirectory()) {
        await chmod(path, details.mode | 0o600);
        return;
    }
    await chmod(path, details.mode | 0o700);
    for (const entry of await readdir(path)) {
        await restoreOwnerWrite(join(path, entry));
    }
}

async function claudeStateArchive(
    stateSources: typeof sources,
    settings: string,
    transcript: string
): Promise<string> {
    const root = await directory();
    await mkdir(join(root, 'claude-code-config', 'projects'), { recursive: true });
    await writeFile(join(root, 'claude-code-config', 'settings.json'), settings);
    await writeFile(
        join(root, 'claude-code-config', 'projects', 'session.jsonl'),
        transcript
    );
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
        stateSources
    );
    snapshots.push(snapshot);
    return snapshot.archive;
}

async function opencodeStateArchive(
    stateSources: typeof sources,
    transcript: string
): Promise<string> {
    const root = await directory();
    await mkdir(join(root, 'opencode'));
    await writeFile(join(root, 'opencode', 'session.json'), transcript);
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
        stateSources
    );
    snapshots.push(snapshot);
    return snapshot.archive;
}
