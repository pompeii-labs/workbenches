import { afterEach, describe, expect, test } from 'bun:test';

import type { PreparedRuntime } from '../../../src/runtimes/contracts.js';
import { RuntimeRegistry } from '../../../src/runtimes/index.js';
import { MemoryAssetSource } from '../../../src/runtimes/staging/memory/source.js';
import { MemoryTransfer } from '../../../src/runtimes/staging/memory/transfer.js';
import { TarArchive } from '../../../src/runtimes/staging/tar.js';
import { readArchive } from '../staging/archive.js';
import {
    cleanTemporaryDirectories,
    connection,
    daytonaProvider,
    FakeClient,
    FakeClock,
    fixture,
    request,
    rules,
} from './fixture.js';

afterEach(cleanTemporaryDirectories);

const service =
    (workspace: string) => (binding: { hostname: string; port: number }) => ({
        command: ['opencode', 'serve', binding.hostname, String(binding.port)],
        cwd: workspace,
        env: {},
    });

/** A runtime that ran in a fresh sandbox, and the request to adopt it with. */
async function staged(client: FakeClient, clock = new FakeClock()) {
    const prepared = request(await fixture());
    const first = await daytonaProvider({ client, clock }).prepare(prepared);
    await first.preflight();
    return { prepared, first, sandboxId: first.sandboxId as string };
}

describe('Daytona session continuation', () => {
    describe('suspend', () => {
        test('stops the sandbox, keeps it, clears its lease, and deletes nothing', async () => {
            const client = new FakeClient();
            client.sandbox.holdProcesses = true;
            const { first } = await staged(client);
            first.launch({
                command: ['opencode', 'serve'],
                cwd: '/workspace',
                env: {},
            });
            await first.suspend?.(10_080);
            expect(client.sandbox.killedProcesses).toBe(1);
            // Auto-delete is set before the TTL is cleared, so a failure between
            // the two still leaves a sandbox that expires.
            expect(client.lifecycle).toEqual([
                'stop sandbox-fixture',
                // Archiving is set a minute after deleting, so deletion comes first.
                'autoarchive 10081 sandbox-fixture',
                'autodelete 10080 sandbox-fixture',
                'ttl 0 sandbox-fixture',
            ]);
            expect(client.deleted).toEqual([]);
            // A suspended runtime is finished; cleanup deletes nothing.
            await first.cleanup();
            expect(client.deleted).toEqual([]);
            await expect(first.preflight()).rejects.toThrow(
                'Runtime has already been cleaned up'
            );
        });

        test('is reached through the runtime registry', async () => {
            const client = new FakeClient();
            const runtime = await RuntimeRegistry.standard({
                daytona: connection(client),
            })
                .resolve('daytona')
                .prepare(request(await fixture()));
            await runtime.preflight();
            await runtime.suspend?.(60);
            expect(client.lifecycle.at(-1)).toBe('ttl 0 sandbox-fixture');
            expect(client.deleted).toEqual([]);
        });

        test('only a runtime that can keep its sandbox exposes suspend', async () => {
            const bare = {
                name: 'bare',
                cleanup: async () => {},
            } as unknown as PreparedRuntime;
            const registry = new RuntimeRegistry([
                {
                    name: 'bare',
                    placement: 'sandbox',
                    prepare: async () => bare,
                },
            ]);
            const runtime = await registry
                .resolve('bare')
                .prepare(request(await fixture()));
            expect(runtime.suspend).toBeUndefined();
        });

        test('copies native state out and keeps the sandbox', async () => {
            const source = virtualSource();
            const saved: string[] = [];
            const client = new FakeClient();
            client.sandbox.nativeStateDownload = await new TarArchive(
                TarArchive.pack([file('./opencode.sqlite', 'database')]).bytes
            ).gzip();
            const runtime = await daytonaProvider({
                client,
                assets: source,
                transfer: new MemoryTransfer(source, rules, {
                    putNativeState: async (path) => {
                        saved.push(path);
                    },
                }),
            }).prepare(await virtualRequest());
            await runtime.preflight();
            await runtime.suspend?.(60);
            expect(saved).toEqual(['/virtual/sessions/s1']);
            expect(client.lifecycle).toContain('stop sandbox-fixture');
            expect(client.deleted).toEqual([]);
        });

        test('refuses a keep time that is not a whole number of minutes', async () => {
            const client = new FakeClient();
            const { first } = await staged(client);
            for (const minutes of [0, -1, 1.5]) {
                await expect(first.suspend?.(minutes)).rejects.toThrow(
                    'must be kept for a whole number of minutes'
                );
            }
            expect(client.lifecycle).toEqual([]);
            await first.cleanup();
            expect(client.deleted).toEqual(['sandbox-fixture']);
        });

        test('names the sandbox when it cannot be stopped, and cleanup then deletes it', async () => {
            const client = new FakeClient();
            const { first } = await staged(client);
            client.lifecycleFailure = 'stop';
            await expect(first.suspend?.(60)).rejects.toThrow(
                'Daytona sandbox sandbox-fixture was not suspended: stop failed. Call cleanup to delete it.'
            );
            expect(client.deleted).toEqual([]);
            await first.cleanup();
            expect(client.deleted).toEqual(['sandbox-fixture']);
        });

        test('keeps the lease when the auto-delete interval cannot be set', async () => {
            const client = new FakeClient();
            const { first } = await staged(client);
            client.lifecycleFailure = 'autodelete';
            await expect(first.suspend?.(60)).rejects.toThrow(
                'Daytona sandbox sandbox-fixture was not suspended: autodelete 60 failed. Call cleanup to delete it.'
            );
            // The TTL was never cleared, so Daytona still destroys the sandbox.
            expect(client.lifecycle).not.toContain('ttl 0 sandbox-fixture');
            expect(client.deleted).toEqual([]);
            await first.cleanup();
            expect(client.deleted).toEqual(['sandbox-fixture']);
        });

        test('names the sandbox when the lease cannot be cleared, and cleanup then deletes it', async () => {
            const client = new FakeClient();
            const { first } = await staged(client);
            client.lifecycleFailure = 'ttl 0';
            await expect(first.suspend?.(60)).rejects.toThrow(
                'Daytona sandbox sandbox-fixture was not suspended: ttl 0 failed. Call cleanup to delete it.'
            );
            expect(client.lifecycle).toEqual([
                'stop sandbox-fixture',
                'autoarchive 61 sandbox-fixture',
                'autodelete 60 sandbox-fixture',
            ]);
            expect(client.deleted).toEqual([]);
            await first.cleanup();
            expect(client.deleted).toEqual(['sandbox-fixture']);
        });

        test('refuses a client that cannot stop sandboxes before touching anything', async () => {
            const client = new FakeClient();
            const { first } = await staged(client);
            Object.defineProperty(client, 'stopSandbox', { value: undefined });
            await expect(first.suspend?.(60)).rejects.toThrow(
                'cannot stop sandboxes or change their lifetime'
            );
            await first.cleanup();
            expect(client.deleted).toEqual(['sandbox-fixture']);
        });
    });

    describe('adopt', () => {
        test('starts a stopped sandbox after setting a fresh lease', async () => {
            const client = new FakeClient();
            const { prepared, first, sandboxId } = await staged(client);
            await first.suspend?.(60);
            client.lifecycle.length = 0;
            const uploads = client.sandbox.uploads.size;
            const runtime = await daytonaProvider({ client }).adopt(
                prepared,
                sandboxId
            );
            try {
                await runtime.preflight();
                expect(client.lifecycle).toEqual([
                    'ttl 60 sandbox-fixture',
                    'start sandbox-fixture',
                ]);
                expect(client.sandbox.state).toBe('started');
                expect(client.createOptions).toHaveLength(1);
                expect(client.sandbox.uploads.size).toBe(uploads);
            } finally {
                await runtime.cleanup();
            }
            // A run that ends normally deletes the sandbox it reattached.
            expect(client.deleted).toEqual(['sandbox-fixture']);
        });

        test('sets the lease again on a sandbox that is still running', async () => {
            const client = new FakeClient();
            const { prepared, sandboxId } = await staged(client);
            const runtime = await daytonaProvider({
                client,
                leaseMilliseconds: 30 * 60_000,
            }).adopt(prepared, sandboxId);
            try {
                await runtime.preflight();
                expect(client.lifecycle).toEqual(['ttl 30 sandbox-fixture']);
            } finally {
                await runtime.cleanup();
            }
        });

        test('refuses a stopped sandbox when the client cannot start one', async () => {
            const client = new FakeClient();
            const { prepared, sandboxId } = await staged(client);
            client.sandbox.state = 'stopped';
            Object.defineProperty(client, 'startSandbox', { value: undefined });
            const runtime = await daytonaProvider({ client }).adopt(
                prepared,
                sandboxId
            );
            await expect(runtime.preflight()).rejects.toThrow(
                'Daytona sandbox sandbox-fixture is stopped, not running'
            );
            await runtime.cleanup();
            expect(client.deleted).toEqual([]);
        });

        test('starts an archived sandbox as it starts a stopped one', async () => {
            const client = new FakeClient();
            const { prepared, sandboxId } = await staged(client);
            client.sandbox.state = 'archived';
            const runtime = await daytonaProvider({ client }).adopt(
                prepared,
                sandboxId
            );
            try {
                await runtime.preflight();
                expect(client.lifecycle).toEqual([
                    'ttl 60 sandbox-fixture',
                    'start sandbox-fixture',
                ]);
                expect(client.sandbox.state).toBe('started');
            } finally {
                await runtime.cleanup();
            }
        });

        test('stops a sandbox it started again when attaching fails, and clears its lease', async () => {
            const client = new FakeClient();
            const { prepared, first, sandboxId } = await staged(client);
            await first.suspend?.(60);
            client.lifecycle.length = 0;
            client.sandbox.baselineFailure = true;
            const runtime = await daytonaProvider({ client }).adopt(
                prepared,
                sandboxId
            );
            await expect(runtime.preflight()).rejects.toThrow(
                'Cannot find the workspace baseline in the Daytona sandbox'
            );
            expect(client.lifecycle).toEqual([
                'ttl 60 sandbox-fixture',
                'start sandbox-fixture',
                'stop sandbox-fixture',
                'ttl 0 sandbox-fixture',
            ]);
            expect(client.sandbox.state).toBe('stopped');
            await runtime.cleanup();
            expect(client.deleted).toEqual([]);
        });

        test('leaves a sandbox that is still running alone when attaching fails', async () => {
            const client = new FakeClient();
            const { prepared, sandboxId } = await staged(client);
            client.sandbox.baselineFailure = true;
            const runtime = await daytonaProvider({ client }).adopt(
                prepared,
                sandboxId
            );
            await expect(runtime.preflight()).rejects.toThrow(
                'Cannot find the workspace baseline in the Daytona sandbox'
            );
            expect(client.lifecycle).toEqual(['ttl 60 sandbox-fixture']);
            await runtime.cleanup();
        });

        test('refuses every other state without starting anything', async () => {
            for (const state of ['error', 'stopping', 'destroyed']) {
                const client = new FakeClient();
                const { prepared, sandboxId } = await staged(client);
                client.sandbox.state = state;
                const runtime = await daytonaProvider({ client }).adopt(
                    prepared,
                    sandboxId
                );
                await expect(runtime.preflight()).rejects.toThrow(
                    `Daytona sandbox sandbox-fixture is ${state}, not running`
                );
                await runtime.cleanup();
                expect(client.lifecycle).toEqual([]);
                expect(client.deleted).toEqual([]);
            }
        });

        test('measures billed duration from the attach, not the sandbox creation', async () => {
            const client = new FakeClient();
            client.sandbox.sandboxInfo = {
                cpuCount: 2,
                memoryMB: 4_096,
                diskGb: 10,
                createdAt: new Date('2026-09-23T12:00:00.000Z'),
            };
            const { prepared, sandboxId } = await staged(client);
            const clock = new FakeClock(new Date('2026-09-30T15:00:00.000Z'));
            const runtime = await daytonaProvider({ client, clock }).adopt(
                prepared,
                sandboxId
            );
            try {
                await runtime.preflight();
                clock.time = new Date('2026-09-30T15:00:42.000Z');
                await expect(runtime.infrastructure?.()).resolves.toMatchObject({
                    provider: 'daytona',
                    duration_ms: 42_000,
                    maximum_duration_ms: 3_600_000,
                });
            } finally {
                await runtime.cleanup();
            }
        });

        test('counts the lease from when it was set, not from when the start finished', async () => {
            const client = new FakeClient();
            client.sandbox.listening = true;
            const { prepared, first, sandboxId } = await staged(client);
            await first.suspend?.(60);
            const clock = new FakeClock(new Date('2026-09-30T15:00:00.000Z'));
            const start = client.startSandbox.bind(client);
            client.startSandbox = async (id) => {
                clock.time = new Date('2026-09-30T15:02:00.000Z');
                return start(id);
            };
            const runtime = await daytonaProvider({ client, clock }).adopt(
                prepared,
                sandboxId
            );
            try {
                await runtime.preflight();
                const launched = runtime.launchService(
                    service(runtime.workspaceDirectory)
                );
                await launched.resolveUrl('http://0.0.0.0:4096/session');
                expect(client.sandbox.previews).toEqual([
                    { port: 4096, ttlSeconds: 3_480 },
                ]);
            } finally {
                await runtime.cleanup();
            }
        });

        test('signs the preview URL for the full lease, counted from the attach', async () => {
            const client = new FakeClient();
            client.sandbox.listening = true;
            client.sandbox.sandboxInfo = {
                cpuCount: 2,
                memoryMB: 4_096,
                diskGb: 10,
                createdAt: new Date('2026-09-01T00:00:00.000Z'),
            };
            const { prepared, sandboxId } = await staged(client);
            const clock = new FakeClock(new Date('2026-09-30T15:00:00.000Z'));
            const runtime = await daytonaProvider({ client, clock }).adopt(
                prepared,
                sandboxId
            );
            try {
                await runtime.preflight();
                const launched = runtime.launchService(
                    service(runtime.workspaceDirectory)
                );
                await launched.resolveUrl('http://0.0.0.0:4096/session');
                expect(client.sandbox.previews).toEqual([
                    { port: 4096, ttlSeconds: 3_600 },
                ]);
            } finally {
                await runtime.cleanup();
            }
        });
    });

    describe('native state in a fresh sandbox', () => {
        test('copies an OpenCode session out at cleanup and stages it into the next sandbox', async () => {
            const source = virtualSource().file(
                '/virtual/sessions/s1/opencode.sqlite',
                'first database'
            );
            const saved = new Map<string, Uint8Array>();
            const sink = {
                putNativeState: async (path: string, archive: Uint8Array) => {
                    saved.set(path, archive);
                },
            };
            const client = new FakeClient();
            const runtime = await daytonaProvider({
                client,
                assets: source,
                transfer: new MemoryTransfer(source, rules, sink),
            }).prepare(await virtualRequest());
            await runtime.preflight();
            const directory = runtime.pathFor('/virtual/sessions/s1');
            expect(directory).toBe('/runtime-state/2');
            // What the sandbox holds when the run ends: OpenCode's database,
            // its write-ahead log, and files the staging rules never return.
            client.sandbox.nativeStateDownload = await new TarArchive(
                TarArchive.pack([
                    file('./opencode.sqlite', 'second database'),
                    file('./opencode.sqlite-wal', 'log'),
                    file('./.env', 'TOKEN=MUST_NOT_RENDER_CREDENTIAL'),
                    file('./credentials', 'MUST_NOT_RENDER_CREDENTIAL'),
                    file('./keys/provider.pem', 'MUST_NOT_RENDER_CREDENTIAL'),
                ]).bytes
            ).gzip();
            await runtime.cleanup();
            expect(client.deleted).toEqual(['sandbox-fixture']);
            const capture = client.sandbox.runs.find((call) =>
                call.command.includes('workbench-native-state')
            );
            expect(capture?.command).toContain("tar -C '/runtime-state/2'");
            expect(capture?.command).toContain('--exclude=./.git');
            const archive = saved.get('/virtual/sessions/s1');
            if (!archive) throw new Error('No native state was saved');
            expect(await readArchive(archive)).toEqual({
                'opencode.sqlite': 'second database',
                'opencode.sqlite-wal': 'log',
            });

            const restored = await virtualSource().unpack(
                '/virtual/sessions/s1',
                archive,
                rules
            );
            const next = new FakeClient();
            const resumed = await daytonaProvider({
                client: next,
                assets: restored,
                transfer: new MemoryTransfer(restored, rules, sink),
            }).prepare(await virtualRequest());
            try {
                await resumed.preflight();
                const uploaded = next.sandbox.uploads.get(
                    '/tmp/workbench-input-2.tar.gz'
                );
                if (!uploaded) throw new Error('Native state was not staged');
                expect(await readArchive(uploaded)).toEqual({
                    'opencode.sqlite': 'second database',
                    'opencode.sqlite-wal': 'log',
                });
            } finally {
                next.sandbox.nativeStateDownload = archive;
                await resumed.cleanup();
            }
        });

        test('saves nothing without a native state sink', async () => {
            const source = virtualSource().file(
                '/virtual/sessions/s1/opencode.sqlite',
                'database'
            );
            const client = new FakeClient();
            const runtime = await daytonaProvider({
                client,
                assets: source,
                transfer: new MemoryTransfer(source, rules),
            }).prepare(await virtualRequest());
            await runtime.preflight();
            await runtime.cleanup();
            expect(
                client.sandbox.runs.some((call) =>
                    call.command.includes('workbench-native-state')
                )
            ).toBeFalse();
        });
    });
});

function file(name: string, content: string) {
    return {
        name,
        type: 'file' as const,
        mode: 0o644,
        content: new TextEncoder().encode(content),
    };
}

function virtualSource(): MemoryAssetSource {
    return new MemoryAssetSource()
        .file('/virtual/ws/readme.md', 'hello')
        .file('/virtual/pkg/instructions.md', 'Use the fixture.')
        .file('/virtual/pkg/workbench.yml', 'fixture')
        .directory('/virtual/sessions/s1');
}

/** A request for the workspace, package, and session directory of `virtualSource`. */
async function virtualRequest() {
    const resolved = await fixture();
    return {
        ...request(resolved),
        workbench: {
            ...resolved,
            packageDirectory: '/virtual/pkg',
            manifestPath: '/virtual/pkg/workbench.yml',
            instructionsPath: '/virtual/pkg/instructions.md',
            repositoryDirectory: '/virtual/ws',
        },
        workspaceDirectory: '/virtual/ws',
        assets: [
            { path: '/virtual/ws', access: 'read-write' as const },
            { path: '/virtual/pkg', access: 'read-only' as const },
            {
                path: '/virtual/sessions/s1',
                access: 'read-write' as const,
                state: true,
            },
        ],
    };
}
