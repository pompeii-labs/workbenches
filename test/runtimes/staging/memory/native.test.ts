import { describe, expect, test } from 'bun:test';

import { RunnerRegistry } from '../../../../src/runners/registry.js';
import { PathPlan } from '../../../../src/runtimes/remote/paths.js';
import { MemoryAssetSource } from '../../../../src/runtimes/staging/memory/source.js';
import { MemoryTransfer } from '../../../../src/runtimes/staging/memory/transfer.js';
import { TransferRules } from '../../../../src/runtimes/staging/rules.js';
import { TarArchive, type TarEntry } from '../../../../src/runtimes/staging/tar.js';
import type { AssetBinding } from '../../../../src/runtimes/staging/transfer.js';
import type { ResolvedWorkbench } from '../../../../src/types.js';
import { readArchive } from '../archive.js';

const rules = new TransferRules('Daytona');
const maximumBytes = 1024 * 1024;

function file(name: string, content: string): TarEntry {
    return {
        name,
        type: 'file',
        mode: 0o644,
        content: new TextEncoder().encode(content),
    };
}

async function gzip(entries: TarEntry[]): Promise<Uint8Array> {
    return new TarArchive(TarArchive.pack(entries).bytes).gzip();
}

/** A sandbox whose native state directory holds `archive` when it is collected. */
function sandbox(archive: Uint8Array) {
    const commands: string[] = [];
    return {
        commands,
        run: async (command: string) => {
            commands.push(command);
            return { code: 0, stdout: '', stderr: '' };
        },
        download: async () => new Blob([archive as Uint8Array<ArrayBuffer>]).stream(),
    };
}

function stateBinding(hostPath: string, runtimePath: string): AssetBinding {
    return {
        hostPath,
        runtimePath,
        access: 'read-write',
        excludedHostPaths: [],
        kind: 'state',
    };
}

/** A session directory planned as a state asset for `runner`, and where it lands. */
function plannedSession(runner: string, directory: string) {
    const workbench = {
        manifestPath: '/virtual/pkg/workbench.yml',
        packageDirectory: '/virtual/pkg',
        repositoryDirectory: '/virtual/ws',
        instructionsPath: '/virtual/pkg/instructions.md',
        skills: [],
        manifest: { runner, env: {}, mcps: [] },
    } as unknown as ResolvedWorkbench;
    const plan = new PathPlan(
        {
            workbench,
            workspaceDirectory: '/virtual/ws',
            environment: {},
            runner: RunnerRegistry.standard().resolve(runner).runtimeContract(),
            assets: [
                { path: '/virtual/ws', access: 'read-write' },
                { path: '/virtual/pkg', access: 'read-only' },
                { path: directory, access: 'read-write', state: true },
            ],
        },
        rules
    );
    const binding = plan.bindings.find((candidate) => candidate.kind === 'state');
    if (!binding) throw new Error('The session directory is not a state asset');
    return { binding, runtimePath: plan.pathFor(directory) };
}

/** Collects one state asset out of a sandbox, restores it, and packs it again. */
async function roundTrip(
    binding: AssetBinding,
    initial: MemoryAssetSource,
    remote: TarEntry[]
) {
    const saved = new Map<string, Uint8Array>();
    const sink = {
        putNativeState: async (path: string, archive: Uint8Array) => {
            saved.set(path, archive);
        },
    };
    const first = new MemoryTransfer(initial, rules, sink);
    const staged = await first.pack(binding, maximumBytes);
    const fake = sandbox(await gzip(remote));
    await first.captureNativeState({
        sandbox: fake,
        snapshots: [staged],
        maximumBytes,
        completed: new Set(),
    });
    const archive = saved.get(binding.hostPath);
    if (!archive) throw new Error('No native state was saved');
    const restored = await new MemoryAssetSource().unpack(
        binding.hostPath,
        archive,
        rules
    );
    const again = await new MemoryTransfer(restored, rules, sink).pack(
        binding,
        maximumBytes
    );
    return {
        commands: fake.commands,
        captured: await readArchive(archive),
        staged: await readArchive(await again.archiveBytes()),
    };
}

describe('in-memory native state', () => {
    test('round-trips an OpenCode session database into a fresh sandbox', async () => {
        const { binding, runtimePath } = plannedSession(
            'opencode',
            '/virtual/sessions/opencode'
        );
        expect(runtimePath).toBe('/runtime-state/2');
        const result = await roundTrip(
            binding,
            new MemoryAssetSource().directory('/virtual/sessions/opencode'),
            [
                file('./opencode.sqlite', 'database'),
                file('./opencode.sqlite-wal', 'log'),
                file('./.env.local', 'MUST_NOT_RENDER_CREDENTIAL'),
            ]
        );
        expect(result.commands[0]).toBe(
            "tar -C '/runtime-state/2' --exclude=./.git --exclude=./.workbench-state -czf '/tmp/workbench-native-state-0.tar.gz' ."
        );
        expect(result.commands.at(-1)).toBe(
            "rm -f '/tmp/workbench-native-state-0.tar.gz'"
        );
        expect(result.captured).toEqual({
            'opencode.sqlite': 'database',
            'opencode.sqlite-wal': 'log',
        });
        expect(result.staged).toEqual(result.captured);
    });

    test('round-trips a Pi session directory, a runner that reads standard input', async () => {
        const { binding } = plannedSession('pi', '/virtual/sessions/pi');
        const transcript = '--virtual-ws--/2026-10-01_pi-native-1.jsonl';
        const result = await roundTrip(
            binding,
            new MemoryAssetSource().file(`/virtual/sessions/pi/${transcript}`, 'one'),
            [
                file(`./${transcript}`, 'one\ntwo'),
                file('./.ssh/id_ed25519', 'MUST_NOT_RENDER_CREDENTIAL'),
                file('./provider.key', 'MUST_NOT_RENDER_CREDENTIAL'),
                file('./credentials', 'MUST_NOT_RENDER_CREDENTIAL'),
            ]
        );
        expect(result.captured).toEqual({ [transcript]: 'one\ntwo' });
        expect(result.staged).toEqual({ [transcript]: 'one\ntwo' });
        expect(JSON.stringify(result)).not.toContain('MUST_NOT_RENDER_CREDENTIAL');
    });

    test('hands state over with private file modes', async () => {
        let archive: Uint8Array | undefined;
        const transfer = new MemoryTransfer(
            new MemoryAssetSource().directory('/host/state'),
            rules,
            {
                putNativeState: async (_path, bytes) => {
                    archive = bytes;
                },
            }
        );
        const staged = await transfer.pack(
            stateBinding('/host/state', '/runtime-state/0'),
            maximumBytes
        );
        await transfer.captureNativeState({
            sandbox: sandbox(await gzip([{ ...file('./db', 'x'), mode: 0o755 }])),
            snapshots: [staged],
            maximumBytes,
            completed: new Set(),
        });
        const entries = (
            await TarArchive.gunzip(archive ?? new Uint8Array())
        ).entries();
        expect(entries.map((entry) => [entry.name, entry.mode])).toEqual([
            ['db', 0o600],
        ]);
    });

    test('copies only state assets and skips those already captured', async () => {
        const source = new MemoryAssetSource()
            .file('/host/ws/readme.md', 'hello')
            .directory('/host/a')
            .directory('/host/b');
        const saved: string[] = [];
        const checkpoints: number[][] = [];
        const transfer = new MemoryTransfer(source, rules, {
            putNativeState: async (path) => {
                saved.push(path);
            },
        });
        const snapshots = [
            await transfer.pack(
                {
                    hostPath: '/host/ws',
                    runtimePath: '/workspace',
                    access: 'read-write',
                    excludedHostPaths: [],
                    kind: 'workspace',
                },
                maximumBytes
            ),
            await transfer.pack(
                stateBinding('/host/a', '/runtime-state/1'),
                maximumBytes
            ),
            await transfer.pack(
                stateBinding('/host/b', '/runtime-state/2'),
                maximumBytes
            ),
        ];
        await transfer.captureNativeState({
            sandbox: sandbox(await gzip([file('./db', 'x')])),
            snapshots,
            maximumBytes,
            completed: new Set([1]),
            checkpoint: async (completed) => {
                checkpoints.push([...completed]);
            },
        });
        expect(saved).toEqual(['/host/b']);
        expect(checkpoints).toEqual([[1, 2]]);
    });

    test('refuses links in native state', async () => {
        const transfer = new MemoryTransfer(
            new MemoryAssetSource().directory('/host/state'),
            rules,
            { putNativeState: async () => {} }
        );
        const staged = await transfer.pack(
            stateBinding('/host/state', '/runtime-state/0'),
            maximumBytes
        );
        const link: TarEntry = {
            name: './current',
            type: 'symlink',
            mode: 0o777,
            content: new Uint8Array(),
            link: 'db',
        };
        await expect(
            transfer.captureNativeState({
                sandbox: sandbox(await gzip([file('./db', 'x'), link])),
                snapshots: [staged],
                maximumBytes,
                completed: new Set(),
            })
        ).rejects.toThrow('Daytona native state contains a symbolic link: current');
    });

    test('refuses state past the transfer limit', async () => {
        const transfer = new MemoryTransfer(
            new MemoryAssetSource().directory('/host/state'),
            rules,
            { putNativeState: async () => {} }
        );
        const staged = await transfer.pack(
            stateBinding('/host/state', '/runtime-state/0'),
            maximumBytes
        );
        await expect(
            transfer.captureNativeState({
                sandbox: sandbox(await gzip([file('./db', 'x'.repeat(4096))])),
                snapshots: [staged],
                maximumBytes: 16,
                completed: new Set(),
            })
        ).rejects.toThrow('Daytona native state exceeds the');
    });
});
