import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { MemoryOutcomeStore } from '../../src/outcomes/index.js';
import type {
    DaytonaClient,
    DaytonaProcess,
    DaytonaProcessOptions,
    DaytonaRunOptions,
    DaytonaSandbox,
    DaytonaSandboxInfo,
} from '../../src/runtimes/daytona/contracts.js';
import { DaytonaRuntimeProvider } from '../../src/runtimes/daytona/provider.js';
import { e2bIdentityCommand } from '../../src/runtimes/e2b/directories.js';
import { diskAssetSource, diskTransfer } from '../../src/runtimes/staging/disk.js';
import { memoryTransfer } from '../../src/runtimes/staging/memory.js';
import { MemoryAssetSource } from '../../src/runtimes/staging/memory-source.js';
import type { AssetSource } from '../../src/runtimes/staging/source.js';
import {
    gunzip,
    packTarGzip,
    readTar,
    type TarEntry,
} from '../../src/runtimes/staging/tar.js';
import type { RemoteTransfer } from '../../src/runtimes/staging/transfer.js';
import type { ResolvedWorkbench } from '../../src/types.js';

const encode = (value: string) => new TextEncoder().encode(value);
const file = (name: string, content: string | Uint8Array, mode = 0o644): TarEntry => ({
    name,
    type: 'file',
    mode,
    content: typeof content === 'string' ? encode(content) : content,
});

const workspace = '/virtual/ws';
const packageDirectory = '/virtual/pkg';

function assets(): MemoryAssetSource {
    return new MemoryAssetSource()
        .file(`${workspace}/a.txt`, 'alpha\nbeta\n')
        .file(`${workspace}/b.txt`, 'bravo\n')
        .file(`${workspace}/run.sh`, '#!/bin/sh\n', 0o644)
        .file(`${workspace}/logo.bin`, new Uint8Array([0, 1, 2, 3]))
        .file(`${workspace}/.env`, 'SECRET=1')
        .file(`${packageDirectory}/workbench.yml`, 'fixture')
        .file(`${packageDirectory}/instructions.md`, 'Use the fixture.')
        .directory('/virtual/out');
}

function workbench(): ResolvedWorkbench {
    return {
        manifestPath: `${packageDirectory}/workbench.yml`,
        packageDirectory,
        repositoryDirectory: workspace,
        instructionsPath: `${packageDirectory}/instructions.md`,
        skills: [],
        manifest: {
            spec: 1,
            version: '0.1.0',
            name: 'memory-fixture',
            runner: 'opencode',
            model: { id: 'openai/gpt-5.6-terra' },
            instructions: './instructions.md',
            skills: [],
            tools: [],
            mcps: [],
            env: {},
            runtimes: {
                daytona: { class: 'linux', image: 'ghcr.io/example/workbench:1.0.0' },
            },
        },
    };
}

function request(withOutcome = false) {
    return {
        workbench: workbench(),
        workspaceDirectory: workspace,
        environment: {},
        assets: [
            { path: workspace, access: 'read-write' as const },
            { path: packageDirectory, access: 'read-only' as const },
        ],
        ...(withOutcome ? { outcome: { directory: '/virtual/out' } } : {}),
    };
}

describe('Daytona on in-memory storage', () => {
    test('stages from memory, runs, collects changes into a memory sink, and cleans up', async () => {
        const sandbox = new FakeSandbox();
        const client = new FakeClient(sandbox);
        const runtime = await new DaytonaRuntimeProvider({
            client,
            assets: assets(),
        }).prepare(request(true));
        try {
            await runtime.preflight();
            expect(runtime.sandboxId).toBe('sandbox-memory');
            // Both assets and the outbox were uploaded as gzip tars built in memory.
            const staged = readTar(
                await gunzip(
                    sandbox.uploads.get('/tmp/workbench-input-0.tar.gz') ??
                        new Uint8Array()
                )
            );
            expect(staged.map((entry) => entry.name).sort()).toEqual([
                'a.txt',
                'b.txt',
                'logo.bin',
                'run.sh',
            ]);
            expect(sandbox.uploads.has('/tmp/workbench-input-1.tar.gz')).toBe(true);

            sandbox.remote.set(
                '/tmp/workbench-output-0.tar.gz',
                await packTarGzip([
                    file('a.txt', 'alpha\nBETA\n'),
                    file('c.txt', 'charlie\n'),
                    file('run.sh', '#!/bin/sh\n', 0o755),
                    file('logo.bin', new Uint8Array([0, 9, 2, 3])),
                    file('.env', 'STOLEN=1'),
                ])
            );
            sandbox.remote.set('/tmp/workbench-deleted-0', encode('b.txt\0'));
            sandbox.artifacts = await packTarGzip([
                file('report.md', '# Report'),
                file(
                    'outcome.json',
                    JSON.stringify({
                        version: 1,
                        summary: 'Changed things',
                        artifacts: [{ path: 'report.md', name: 'Report' }],
                    })
                ),
            ]);

            const store = new MemoryOutcomeStore();
            const collected = await runtime.collectOutcome?.(store);
            expect(collected?.summary).toBe('Changed things');
            expect(collected?.artifacts).toMatchObject([
                { name: 'Report', path: 'report.md' },
            ]);
            const [changeset] = collected?.changesets ?? [];
            expect(changeset?.id).toBe('change_primary');
            expect(
                changeset?.entries.map((entry) => [entry.path, entry.operation])
            ).toEqual([
                ['a.txt', 'modify'],
                ['b.txt', 'delete'],
                ['c.txt', 'add'],
                ['logo.bin', 'modify'],
                ['run.sh', 'modify'],
            ]);
            expect(changeset?.stats).toEqual({
                additions: 1,
                modifications: 3,
                deletions: 1,
                binary_files: 1,
            });
            expect(changeset?.base.snapshot_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
            expect(changeset?.base.git_revision).toBeUndefined();
            const added = changeset?.entries.find((entry) => entry.path === 'c.txt');
            expect(
                added?.after?.kind === 'file' && store.get(added.after.content)
            ).toEqual(encode('charlie\n'));
            expect(
                changeset?.entries.find((entry) => entry.path === 'run.sh')?.after
            ).toMatchObject({ kind: 'file', mode: 0o755 });
            if (!changeset?.review) throw new Error('Expected a review diff');
            const review = new TextDecoder().decode(store.get(changeset.review));
            expect(review).toContain('diff --git a/a.txt b/a.txt');
            expect(review).toContain('-beta\n+BETA');
            expect(review).toContain('deleted file mode 100644');
            expect(review).toContain('Binary files a/logo.bin and b/logo.bin differ');
            expect(review).toContain('old mode 100644\nnew mode 100755');
            // A protected path never appears in returned changes.
            expect(review).not.toContain('STOLEN');
            expect(changeset?.entries.some((entry) => entry.path === '.env')).toBe(
                false
            );
            expect(collected?.warnings[0]?.message).toContain('.env');
        } finally {
            await runtime.cleanup();
        }
        expect(client.deleted).toEqual(['sandbox-memory']);
    });

    test('reports no change when the sandbox returns nothing', async () => {
        const sandbox = new FakeSandbox();
        const runtime = await new DaytonaRuntimeProvider({
            client: new FakeClient(sandbox),
            assets: assets(),
        }).prepare(request());
        try {
            await runtime.preflight();
            sandbox.remote.set('/tmp/workbench-output-0.tar.gz', await packTarGzip([]));
            const collected = await runtime.collectOutcome?.(new MemoryOutcomeStore());
            expect(collected?.changesets).toEqual([]);
        } finally {
            await runtime.cleanup();
        }
    });

    test('refuses an archive entry that escapes the workspace', async () => {
        const sandbox = new FakeSandbox();
        const runtime = await new DaytonaRuntimeProvider({
            client: new FakeClient(sandbox),
            assets: assets(),
        }).prepare(request());
        try {
            await runtime.preflight();
            sandbox.remote.set(
                '/tmp/workbench-output-0.tar.gz',
                await packTarGzip([
                    {
                        name: 'link',
                        type: 'symlink',
                        mode: 0o777,
                        content: new Uint8Array(),
                        link: '../../etc/passwd',
                    },
                ])
            );
            await expect(
                runtime.collectOutcome?.(new MemoryOutcomeStore())
            ).rejects.toThrow('Escaping symlink is not allowed in Daytona transfer');
        } finally {
            await runtime.cleanup();
        }
    });

    test('enforces the transfer limit on collected output', async () => {
        const sandbox = new FakeSandbox();
        const runtime = await new DaytonaRuntimeProvider({
            client: new FakeClient(sandbox),
            assets: assets(),
            maxTransferBytes: 4_096,
        }).prepare(request());
        try {
            await runtime.preflight();
            sandbox.remote.set(
                '/tmp/workbench-output-0.tar.gz',
                await packTarGzip([file('big.txt', 'x'.repeat(100_000))])
            );
            await expect(
                runtime.collectOutcome?.(new MemoryOutcomeStore())
            ).rejects.toThrow('transfer safety limit');
        } finally {
            await runtime.cleanup();
        }
    });

    test('refuses to prepare without an asset source', async () => {
        await expect(
            new DaytonaRuntimeProvider({
                client: new FakeClient(new FakeSandbox()),
            }).prepare(request())
        ).rejects.toThrow('needs an asset source');
    });
});

describe('Daytona reconnection', () => {
    test('binds to a running sandbox without uploading and recovers its baseline', async () => {
        const sandbox = new FakeSandbox();
        const client = new FakeClient(sandbox);
        const runtime = await new DaytonaRuntimeProvider({
            client,
            assets: assets(),
        }).adopt(request(), 'sandbox-memory');
        try {
            const preflight = await runtime.preflight();
            expect(preflight.runner.name).toBe('opencode');
            expect(sandbox.uploads.size).toBe(0);
            expect(client.created).toBe(0);
            expect(
                sandbox.runs.some((run) => run.includes('rev-list --max-parents=0'))
            ).toBe(true);
            // Collection works against the recovered baseline.
            sandbox.remote.set(
                '/tmp/workbench-output-0.tar.gz',
                await packTarGzip([file('a.txt', 'changed\n')])
            );
            sandbox.remote.set('/tmp/workbench-deleted-0', new Uint8Array());
            const collected = await runtime.collectOutcome?.(new MemoryOutcomeStore());
            expect(collected?.changesets[0]?.entries).toMatchObject([
                { path: 'a.txt', operation: 'modify' },
            ]);
        } finally {
            await runtime.cleanup();
        }
        expect(client.deleted).toEqual(['sandbox-memory']);
    });

    test('attaches to a server that is already listening instead of starting one', async () => {
        const sandbox = new FakeSandbox();
        sandbox.listening = true;
        const runtime = await new DaytonaRuntimeProvider({
            client: new FakeClient(sandbox),
            assets: assets(),
        }).adopt(request(), 'sandbox-memory');
        try {
            await runtime.preflight();
            const service = runtime.launchService((binding) => ({
                command: ['opencode', 'serve', '--port', String(binding.port)],
                cwd: '/workspace',
                env: {},
            }));
            // The address arrives on stdout, where the session driver reads it.
            const first = await service.process.stdout?.getReader().read();
            expect(new TextDecoder().decode(first?.value)).toContain(
                'http://0.0.0.0:4096'
            );
            const reported = 'http://0.0.0.0:4096';
            expect(await service.resolveUrl(reported)).toBe(
                'https://4096-token.proxy.daytona.test/'
            );
            expect(sandbox.started).toEqual([]);
            // Detaching leaves the server running.
            runtime.cancel(service.process);
            expect(await service.process.exited).toBe(0);
            expect(sandbox.killed).toBe(0);
        } finally {
            await runtime.cleanup();
        }
    });

    test('starts the server when nothing is listening', async () => {
        const sandbox = new FakeSandbox();
        const runtime = await new DaytonaRuntimeProvider({
            client: new FakeClient(sandbox),
            assets: assets(),
        }).adopt(request(), 'sandbox-memory');
        try {
            await runtime.preflight();
            runtime.launchService(() => ({
                command: ['opencode', 'serve'],
                cwd: '/workspace',
                env: {},
            }));
            await sandbox.startedOnce;
            expect(sandbox.started).toHaveLength(1);
        } finally {
            await runtime.cleanup();
        }
    });

    test('reports a sandbox that does not exist or is not running', async () => {
        const client = new FakeClient(new FakeSandbox());
        client.missing = true;
        await expect(
            new DaytonaRuntimeProvider({ client, assets: assets() })
                .adopt(request(), 'gone')
                .then((runtime) => runtime.preflight())
        ).rejects.toThrow('Daytona sandbox does not exist: gone');

        const stopped = new FakeSandbox();
        stopped.state = 'stopped';
        await expect(
            new DaytonaRuntimeProvider({
                client: new FakeClient(stopped),
                assets: assets(),
            })
                .adopt(request(), 'sandbox-memory')
                .then((runtime) => runtime.preflight())
        ).rejects.toThrow('is stopped, not running');
    });

    test('does not delete a sandbox it failed to adopt', async () => {
        const stopped = new FakeSandbox();
        stopped.state = 'stopped';
        const client = new FakeClient(stopped);
        const runtime = await new DaytonaRuntimeProvider({
            client,
            assets: assets(),
        }).adopt(request(), 'sandbox-memory');
        await expect(runtime.preflight()).rejects.toThrow('not running');
        expect(client.deleted).toEqual([]);
    });

    test('requires a sandbox id', async () => {
        await expect(
            new DaytonaRuntimeProvider({
                client: new FakeClient(new FakeSandbox()),
                assets: assets(),
            }).adopt(request(), ' ')
        ).rejects.toThrow('A sandbox id is required');
    });
});

describe('memory and disk transfer agree', () => {
    test('collect the same changes for the same tree', async () => {
        const root = await mkdtemp(join(tmpdir(), 'workbench-parity-'));
        try {
            const files: Array<[string, string | Uint8Array, number]> = [
                ['a.txt', 'alpha\nbeta\n', 0o644],
                ['b.txt', 'bravo\n', 0o644],
                ['run.sh', '#!/bin/sh\n', 0o644],
                ['logo.bin', new Uint8Array([0, 1, 2, 3]), 0o644],
                ['nested/deep/keep.txt', 'keep\n', 0o644],
            ];
            const memory = new MemoryAssetSource()
                .file(`${packageDirectory}/workbench.yml`, 'fixture')
                .file(`${packageDirectory}/instructions.md`, 'Use the fixture.');
            await mkdir(join(root, 'pkg'), { recursive: true });
            await writeFile(join(root, 'pkg', 'workbench.yml'), 'fixture');
            await writeFile(join(root, 'pkg', 'instructions.md'), 'Use the fixture.');
            for (const [path, content, mode] of files) {
                memory.file(`${workspace}/${path}`, content, mode);
                await mkdir(dirname(join(root, 'ws', path)), { recursive: true });
                await writeFile(join(root, 'ws', path), content, { mode });
            }
            const returned = await packTarGzip([
                file('a.txt', 'alpha\nBETA\n'),
                file('c.txt', 'charlie\n'),
                file('run.sh', '#!/bin/sh\n', 0o755),
                file('logo.bin', new Uint8Array([0, 9, 2, 3])),
                file('nested/deep/new.txt', 'new\n'),
            ]);
            const collect = async (
                source: AssetSource,
                transfer: RemoteTransfer,
                where: { workspace: string; package: string }
            ) => {
                const sandbox = new FakeSandbox();
                const runtime = await new DaytonaRuntimeProvider({
                    client: new FakeClient(sandbox),
                    assets: source,
                    transfer,
                }).prepare({
                    ...request(),
                    workbench: {
                        ...workbench(),
                        manifestPath: join(where.package, 'workbench.yml'),
                        packageDirectory: where.package,
                        repositoryDirectory: where.workspace,
                        instructionsPath: join(where.package, 'instructions.md'),
                    },
                    workspaceDirectory: where.workspace,
                    assets: [
                        { path: where.workspace, access: 'read-write' },
                        { path: where.package, access: 'read-only' },
                    ],
                });
                try {
                    await runtime.preflight();
                    sandbox.remote.set('/tmp/workbench-output-0.tar.gz', returned);
                    sandbox.remote.set('/tmp/workbench-deleted-0', encode('b.txt\0'));
                    const sink = new MemoryOutcomeStore();
                    const collected = await runtime.collectOutcome?.(sink);
                    const [changeset] = collected?.changesets ?? [];
                    return { changeset, sink };
                } finally {
                    await runtime.cleanup();
                }
            };
            const fromMemory = await collect(memory, memoryTransfer, {
                workspace,
                package: packageDirectory,
            });
            const fromDisk = await collect(diskAssetSource, diskTransfer, {
                workspace: join(root, 'ws'),
                package: join(root, 'pkg'),
            });
            expect(fromMemory.changeset?.entries.length).toBeGreaterThan(0);
            expect(fromMemory.changeset?.entries).toEqual(fromDisk.changeset?.entries);
            expect(fromMemory.changeset?.stats).toEqual(fromDisk.changeset?.stats);
            expect(fromMemory.changeset?.base).toEqual(fromDisk.changeset?.base);
            expect(fromMemory.changeset?.id).toBe(fromDisk.changeset?.id);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

class FakeClient implements DaytonaClient {
    readonly deleted: string[] = [];
    created = 0;
    missing = false;

    constructor(private readonly sandbox: FakeSandbox) {}

    async createSandbox(): Promise<DaytonaSandbox> {
        this.created++;
        return this.sandbox;
    }

    async listSandboxes() {
        return [];
    }

    async getSandbox() {
        return this.missing ? undefined : this.sandbox;
    }

    async deleteSandbox(id: string): Promise<void> {
        this.deleted.push(id);
    }
}

class FakeSandbox implements DaytonaSandbox {
    readonly id = 'sandbox-memory';
    state: string | undefined;
    listening = false;
    killed = 0;
    artifacts: Uint8Array = new Uint8Array();
    readonly runs: string[] = [];
    readonly started: string[] = [];
    readonly uploads = new Map<string, Uint8Array>();
    readonly remote = new Map<string, Uint8Array>();
    readonly startedOnce: Promise<void>;
    private markStarted: (() => void) | undefined;

    constructor() {
        this.startedOnce = new Promise((resolve) => {
            this.markStarted = resolve;
        });
    }

    async run(command: string, _options: DaytonaRunOptions = {}) {
        this.runs.push(command);
        if (command === e2bIdentityCommand) return result(0, '1000:1000');
        if (command === 'tar --help 2>&1') return result(0, '--null');
        if (command.startsWith('command -v')) {
            const name = command.match(/'([^']+)'/)?.[1] ?? 'tool';
            return result(0, `/usr/bin/${name}\n`);
        }
        if (command.includes('rev-parse HEAD')) return result(0, `${'a'.repeat(40)}\n`);
        if (command.includes('rev-list --max-parents=0')) {
            return result(0, `${'b'.repeat(40)}\n`);
        }
        if (command.includes('/dev/tcp/')) return result(this.listening ? 0 : 1);
        if (command.startsWith('wc -c <')) {
            const path = command.match(/'([^']+)'/)?.[1] ?? '';
            return result(0, `${this.bytes(path).byteLength}\n`);
        }
        return result(0);
    }

    async start(command: string, _options: DaytonaProcessOptions = {}) {
        this.started.push(command);
        this.markStarted?.();
        const process: DaytonaProcess = {
            wait: async () => result(0),
            sendStdin: async () => {},
            closeStdin: async () => {},
            kill: async () => {
                this.killed++;
            },
        };
        return process;
    }

    async upload(path: string, data: Uint8Array): Promise<void> {
        this.uploads.set(path, data);
    }

    async download(path: string): Promise<ReadableStream<Uint8Array>> {
        return new Blob([this.bytes(path)]).stream();
    }

    private bytes(path: string): Uint8Array {
        if (path.includes('workbench-artifacts')) return this.artifacts;
        return this.remote.get(path) ?? new Uint8Array();
    }

    async previewUrl(port: number): Promise<string> {
        return `https://${port}-token.proxy.daytona.test`;
    }

    async info(): Promise<DaytonaSandboxInfo> {
        return { cpuCount: 1, memoryMB: 1_024, diskGb: 3 };
    }
}

function result(code: number, stdout = '', stderr = '') {
    return { code, stdout, stderr };
}
