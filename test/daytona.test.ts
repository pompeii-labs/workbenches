import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OutcomeStore } from '../src/outcomes/index.js';
import type {
    DaytonaClient,
    DaytonaCreateOptions,
    DaytonaProcess,
    DaytonaProcessOptions,
    DaytonaRunOptions,
    DaytonaSandbox,
    DaytonaSandboxInfo,
} from '../src/runtimes/daytona/contracts.js';
import { DaytonaRuntimeProvider } from '../src/runtimes/daytona/provider.js';
import { e2bIdentityCommand } from '../src/runtimes/e2b/directories.js';
import { E2BAssetSnapshot } from '../src/runtimes/e2b/snapshot.js';
import { RuntimeRegistry } from '../src/runtimes/index.js';
import { installRepositoryTools } from '../src/runtimes/repository-tools.js';
import { RuntimeSmoke } from '../src/runtimes/smoke.js';
import type {
    ResolvedWorkbench,
    WorkbenchRequirements,
    WorkbenchRuntimeConfig,
} from '../src/types.js';
import { runtimeProviderContract } from './runtime-provider-contract.js';
import { MemoryAssetSource, readArchive } from './runtimes/memory-assets.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('Daytona runtime provider', () => {
    runtimeProviderContract({
        createProvider: () => new DaytonaRuntimeProvider({ client: new FakeClient() }),
        request: async () => request(await fixture()),
        manifest: (base) => {
            const { runtime: _runtime, image: _image, ...rest } = base;
            return {
                ...rest,
                spec: 1,
                runtimes: {
                    daytona: { class: 'linux', image: 'ghcr.io/example/core:1.0.0' },
                },
            };
        },
    });

    test('requires an API key before contacting Daytona', async () => {
        const resolved = await fixture();
        const home = await mkdtemp(join(tmpdir(), 'workbench-daytona-empty-home-'));
        temporaryDirectories.push(home);
        await expect(
            new DaytonaRuntimeProvider().prepare({
                ...request(resolved),
                environment: { WORKBENCH_HOME: home },
            })
        ).rejects.toThrow('DAYTONA_API_KEY is required for the Daytona runtime');
    });

    test('creates the sandbox from the manifest image and labels it for the run', async () => {
        const client = new FakeClient();
        const run = { id: `wb_${'a'.repeat(20)}`, scope: 'b'.repeat(24) };
        const runtime = await new DaytonaRuntimeProvider({ client }).prepare({
            ...request(await fixture()),
            run,
        });
        try {
            expect(runtime.preparation).toMatchObject({
                kind: 'image',
                reference: 'ghcr.io/example/workbench:1.0.0',
            });
            await runtime.preflight();
            expect(client.createOptions).toHaveLength(1);
            expect(client.createOptions[0]).toEqual({
                image: 'ghcr.io/example/workbench:1.0.0',
                labels: {
                    'dev.workbenches.managed': 'true',
                    'dev.workbenches.run': run.id,
                    'dev.workbenches.scope': run.scope,
                },
                resources: {},
                leaseMinutes: 60,
            });
        } finally {
            await runtime.cleanup();
        }
    });

    test('maps requirements to whole-unit sandbox resources', async () => {
        const client = new FakeClient();
        const runtime = await new DaytonaRuntimeProvider({ client }).prepare(
            request(
                await fixture({
                    requirements: { cpu: 4, memory_gb: 7.5, disk_gb: 20, gpu: false },
                })
            )
        );
        try {
            await runtime.preflight();
            expect(client.createOptions[0]?.resources).toEqual({
                cpu: 4,
                memoryGb: 8,
                diskGb: 20,
            });
        } finally {
            await runtime.cleanup();
        }
    });

    test('falls back to the docker image when the daytona entry has none', async () => {
        const client = new FakeClient();
        const runtime = await new DaytonaRuntimeProvider({ client }).prepare(
            request(
                await fixture({
                    runtimes: {
                        daytona: { class: 'linux' },
                        docker: { image: 'ghcr.io/example/docker-only:2.0.0' },
                    },
                })
            )
        );
        try {
            await runtime.preflight();
            expect(client.createOptions[0]?.image).toBe(
                'ghcr.io/example/docker-only:2.0.0'
            );
        } finally {
            await runtime.cleanup();
        }
    });

    test('prefers the daytona image over the docker image', async () => {
        const client = new FakeClient();
        const runtime = await new DaytonaRuntimeProvider({ client }).prepare(
            request(
                await fixture({
                    runtimes: {
                        daytona: { class: 'linux', image: 'ghcr.io/example/own:1' },
                        docker: { image: 'ghcr.io/example/docker-only:2.0.0' },
                    },
                })
            )
        );
        try {
            await runtime.preflight();
            expect(client.createOptions[0]?.image).toBe('ghcr.io/example/own:1');
        } finally {
            await runtime.cleanup();
        }
    });

    test('fails clearly without any image to create the sandbox from', async () => {
        const provider = new DaytonaRuntimeProvider({ client: new FakeClient() });
        await expect(
            provider.prepare(
                request(await fixture({ runtimes: { daytona: { class: 'linux' } } }))
            )
        ).rejects.toThrow('The daytona runtime needs an image');
    });

    test('refuses an image that would need a local Dockerfile build', async () => {
        const provider = new DaytonaRuntimeProvider({ client: new FakeClient() });
        await expect(
            provider.prepare(
                request(
                    await fixture({
                        runtimes: {
                            daytona: {
                                class: 'linux',
                                image: { build: './Dockerfile' },
                            },
                        },
                    })
                )
            )
        ).rejects.toThrow('cannot build a local Dockerfile');
    });

    for (const daytonaClass of ['windows', 'macos', 'gpu'] as const) {
        test(`refuses the ${daytonaClass} class for now`, async () => {
            const client = new FakeClient();
            await expect(
                new DaytonaRuntimeProvider({ client }).prepare(
                    request(
                        await fixture({
                            runtimes: {
                                daytona: {
                                    class: daytonaClass,
                                    image: 'ghcr.io/example/workbench:1.0.0',
                                },
                            },
                        })
                    )
                )
            ).rejects.toThrow(`class ${daytonaClass} is not available yet`);
            expect(client.createOptions).toHaveLength(0);
        });
    }

    test('refuses a GPU requirement', async () => {
        const client = new FakeClient();
        await expect(
            new DaytonaRuntimeProvider({ client }).prepare(
                request(await fixture({ requirements: { gpu: true } }))
            )
        ).rejects.toThrow('GPU requirements are not supported on the daytona runtime');
        expect(client.createOptions).toHaveLength(0);
    });

    test('checks tools inside the sandbox and names the image', async () => {
        const resolved = await fixture();
        resolved.manifest.tools = ['fixture-tool'];
        const client = new FakeClient();
        client.sandbox.missingCommands.add('fixture-tool');
        const runtime = await new DaytonaRuntimeProvider({ client }).prepare(
            request(resolved)
        );
        try {
            await expect(runtime.preflight()).rejects.toThrow(
                'Required CLI tool is unavailable in Daytona image ghcr.io/example/workbench:1.0.0: fixture-tool'
            );
            // A failed preflight deletes the sandbox it created.
            expect(client.deleted).toEqual([]);
        } finally {
            await runtime.cleanup();
        }
        expect(client.deleted).toEqual(['sandbox-fixture']);
    });

    test('reports the runner path after a successful preflight', async () => {
        const runtime = await new DaytonaRuntimeProvider({
            client: new FakeClient(),
        }).prepare(request(await fixture()));
        try {
            const result = await runtime.preflight();
            expect(result.runner).toEqual({
                name: 'opencode',
                path: '/usr/bin/opencode',
            });
        } finally {
            await runtime.cleanup();
        }
    });

    test('stages the package and workspace at the shared runtime paths', async () => {
        const resolved = await fixture();
        const client = new FakeClient();
        const runtime = await new DaytonaRuntimeProvider({ client }).prepare(
            request(resolved)
        );
        try {
            expect(runtime.workspaceDirectory).toBe('/workspace');
            expect(runtime.workbench.packageDirectory).toBe('/workbench');
            expect(runtime.workbench.instructionsPath).toBe(
                '/workbench/instructions.md'
            );
            await runtime.preflight();
            expect([...client.sandbox.uploads.keys()].sort()).toEqual([
                '/tmp/workbench-input-0.tar.gz',
                '/tmp/workbench-input-1.tar.gz',
            ]);
            const setup = client.sandbox.runs.find(
                (call) => call.options.user === 'root'
            );
            expect(setup?.command).toContain("chown '1000:1000' '/workspace'");
        } finally {
            await runtime.cleanup();
        }
    });

    test('reads staged files through an injected asset source', async () => {
        const source = new MemoryAssetSource()
            .file('/virtual/ws/readme.md', 'hello')
            .file('/virtual/ws/.env', 'SECRET=1')
            .file('/virtual/pkg/instructions.md', 'Use the fixture.')
            .file('/virtual/pkg/workbench.yml', 'fixture');
        const resolved = await fixture();
        const client = new FakeClient();
        const runtime = await new DaytonaRuntimeProvider({
            client,
            assets: source,
        }).prepare({
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
                { path: '/virtual/ws', access: 'read-write' },
                { path: '/virtual/pkg', access: 'read-only' },
            ],
        });
        try {
            await runtime.preflight();
            const uploaded = await Promise.all(
                [...client.sandbox.uploads.values()].map((bytes) => readArchive(bytes))
            );
            expect(uploaded.map((files) => Object.keys(files).sort())).toEqual([
                ['readme.md'],
                ['instructions.md', 'workbench.yml'],
            ]);
        } finally {
            await runtime.cleanup();
        }
    });

    test('runs a command to completion with its directory and environment', async () => {
        const client = new FakeClient();
        const runtime = await new DaytonaRuntimeProvider({ client }).prepare(
            request(await fixture())
        );
        try {
            await runtime.preflight();
            client.sandbox.nextRun = { code: 3, stdout: 'output', stderr: '' };
            const result = await runtime.execute({
                command: ['opencode', 'run', "it's safe"],
                cwd: runtime.workspaceDirectory,
                env: { VALUE: 'present', OMITTED: undefined },
            });
            expect(result).toEqual({ code: 3, stdout: 'output', stderr: '' });
            const call = client.sandbox.runs.at(-1);
            expect(call?.command).toBe(`'opencode' 'run' 'it'"'"'s safe'`);
            expect(call?.options).toEqual({
                cwd: '/workspace',
                env: { VALUE: 'present' },
            });
        } finally {
            await runtime.cleanup();
        }
    });

    test('rejects launch until preflight has succeeded', async () => {
        const runtime = await new DaytonaRuntimeProvider({
            client: new FakeClient(),
        }).prepare(request(await fixture()));
        try {
            expect(() =>
                runtime.launch({ command: ['runner'], cwd: '/workspace', env: {} })
            ).toThrow('Runtime preflight must succeed before launch');
        } finally {
            await runtime.cleanup();
        }
    });

    test('streams output, forwards input, and resolves the service URL', async () => {
        const client = new FakeClient();
        const runtime = await new RuntimeRegistry([
            new DaytonaRuntimeProvider({ client }),
        ])
            .resolve('daytona')
            .prepare(request(await fixture()));
        try {
            await runtime.preflight();
            const process = runtime.launchSession(
                {
                    command: ['opencode', 'run', 'hello'],
                    cwd: runtime.workspaceDirectory,
                    env: { VALUE: 'present' },
                },
                { stdin: 'pipe' }
            );
            await process.stdin?.write('steer\n');
            await process.stdin?.end?.();
            expect(await new Response(process.stdout).text()).toBe('streamed output');
            await expect(process.exited).resolves.toBe(0);
            expect(client.sandbox.started[0]?.options.env).toEqual({
                VALUE: 'present',
            });
            expect(client.sandbox.input).toBe('steer\n');

            const service = runtime.launchService((binding) => ({
                command: ['opencode', 'serve', binding.hostname, String(binding.port)],
                cwd: runtime.workspaceDirectory,
                env: {},
            }));
            expect(client.sandbox.started.at(-1)?.command).toContain(
                `'0.0.0.0' '4096'`
            );
            await expect(
                service.resolveUrl('http://0.0.0.0:4096/session?id=1')
            ).resolves.toBe('https://4096-token.proxy.daytona.test/session?id=1');
            await service.resolveUrl('http://0.0.0.0:4096/event');
            expect(client.sandbox.previews).toHaveLength(1);
            expect(client.sandbox.previews[0]?.port).toBe(4096);
            await service.process.exited;
        } finally {
            await runtime.cleanup();
        }
    });

    test('cancels a running process and forgets it', async () => {
        const client = new FakeClient();
        client.sandbox.holdProcesses = true;
        const runtime = await new DaytonaRuntimeProvider({ client }).prepare(
            request(await fixture())
        );
        try {
            await runtime.preflight();
            const process = runtime.launch({
                command: ['opencode', 'serve'],
                cwd: runtime.workspaceDirectory,
                env: {},
            });
            await Promise.resolve();
            runtime.cancel(process);
            await expect(process.exited).resolves.toBe(143);
            expect(client.sandbox.killedProcesses).toBe(1);
        } finally {
            await runtime.cleanup();
        }
    });

    test('deletes the sandbox on cleanup and is safe to repeat', async () => {
        const client = new FakeClient();
        const runtime = await new DaytonaRuntimeProvider({ client }).prepare(
            request(await fixture())
        );
        await runtime.preflight();
        await runtime.cleanup();
        await runtime.cleanup();
        expect(client.deleted).toEqual(['sandbox-fixture']);
        await expect(runtime.preflight()).rejects.toThrow(
            'Runtime has already been cleaned up'
        );
    });

    test('deletes the sandbox when staging fails', async () => {
        const client = new FakeClient();
        client.sandbox.uploadFailure = new Error('upload network unavailable');
        const runtime = await new DaytonaRuntimeProvider({ client }).prepare(
            request(await fixture())
        );
        await expect(runtime.preflight()).rejects.toThrow('upload network unavailable');
        expect(client.deleted).toEqual(['sandbox-fixture']);
        await runtime.cleanup();
    });

    test('surfaces a failed deletion at cleanup', async () => {
        const client = new FakeClient();
        client.deleteFailure = new Error('delete network unavailable');
        const runtime = await new DaytonaRuntimeProvider({ client }).prepare(
            request(await fixture())
        );
        await runtime.preflight();
        await expect(runtime.cleanup()).rejects.toThrow('delete network unavailable');
    });

    test('installs engine-managed Git tools as root for repository runs', async () => {
        const client = new FakeClient();
        const runtime = await new DaytonaRuntimeProvider({ client }).prepare({
            ...request(await fixture()),
            repository: { name: 'example/project', revision: 'main', delivery: 'pr' },
        });
        try {
            await runtime.preflight();
            const install = client.sandbox.runs.find(
                (call) => call.command === installRepositoryTools
            );
            expect(install?.options.user).toBe('root');
        } finally {
            await runtime.cleanup();
        }
    });

    test('does not install repository tools for ordinary runs', async () => {
        const client = new FakeClient();
        const runtime = await new DaytonaRuntimeProvider({ client }).prepare(
            request(await fixture())
        );
        try {
            await runtime.preflight();
            expect(
                client.sandbox.runs.some(
                    (call) => call.command === installRepositoryTools
                )
            ).toBeFalse();
        } finally {
            await runtime.cleanup();
        }
    });

    test('reports duration and resources without a cost estimate', async () => {
        const client = new FakeClient();
        client.sandbox.sandboxInfo = { cpuCount: 2, memoryMB: 4_096, diskGb: 10 };
        let clock = new Date('2026-09-30T12:00:00.000Z');
        const runtime = await new DaytonaRuntimeProvider({
            client,
            now: () => clock,
        }).prepare(request(await fixture()));
        try {
            await runtime.preflight();
            clock = new Date('2026-09-30T12:00:10.000Z');
            await expect(runtime.infrastructure?.()).resolves.toEqual({
                provider: 'daytona',
                duration_ms: 10_000,
                maximum_duration_ms: 3_600_000,
                resources: { cpu_count: 2, memory_mb: 4_096 },
                cost: { kind: 'unavailable', currency: 'USD' },
            });
        } finally {
            await runtime.cleanup();
        }
    });

    test('does not pass the Daytona credential into runtime commands', async () => {
        const resolved = await fixture();
        resolved.manifest.env.DAYTONA_API_KEY = { required: false };
        const client = new FakeClient();
        const runtime = await new DaytonaRuntimeProvider({ client }).prepare({
            ...request(resolved),
            environment: {
                DAYTONA_API_KEY: 'daytona-secret',
                OPENAI_API_KEY: 'model-secret',
            },
        });
        try {
            await runtime.preflight();
            expect(runtime.environment).not.toHaveProperty('DAYTONA_API_KEY');
            expect(runtime.environment.OPENAI_API_KEY).toBe('model-secret');
            expect(JSON.stringify(client.sandbox.started)).not.toContain(
                'daytona-secret'
            );
        } finally {
            await runtime.cleanup();
        }
    });

    test('does not support interactive terminals yet', async () => {
        const runtime = await new DaytonaRuntimeProvider({
            client: new FakeClient(),
        }).prepare(request(await fixture()));
        try {
            await runtime.preflight();
            await expect(
                runtime.interact({ command: ['login'], cwd: '/workspace', env: {} })
            ).rejects.toThrow('Interactive terminals are not supported');
        } finally {
            await runtime.cleanup();
        }
    });

    test('rejects native credential storage, which has no Daytona store', async () => {
        const credentials = await mkdtemp(join(tmpdir(), 'workbench-daytona-creds-'));
        temporaryDirectories.push(credentials);
        await expect(
            new DaytonaRuntimeProvider({ client: new FakeClient() }).prepare({
                ...request(await fixture()),
                credentials: {
                    runtime: 'e2b',
                    runner: 'opencode',
                    directory: credentials,
                },
            })
        ).rejects.toThrow('Daytona received credential storage for the e2b runtime');
    });

    test('collects declared artifacts and labels warnings with the provider', async () => {
        const resolved = await fixture();
        await mkdir(join(resolved.repositoryDirectory, 'apps', 'web'), {
            recursive: true,
        });
        await writeFile(
            join(resolved.repositoryDirectory, 'apps', 'web', '.npmrc'),
            'fixture config'
        );
        const outputDirectory = await mkdtemp(join(tmpdir(), 'workbench-daytona-out-'));
        const remoteOutput = await mkdtemp(join(tmpdir(), 'workbench-daytona-remote-'));
        const home = await mkdtemp(join(tmpdir(), 'workbench-daytona-outcomes-'));
        temporaryDirectories.push(outputDirectory, remoteOutput, home);
        await writeFile(join(remoteOutput, 'report.txt'), 'remote artifact');
        await writeFile(
            join(remoteOutput, 'outcome.json'),
            JSON.stringify({
                version: 1,
                summary: 'Remote work complete',
                artifacts: [{ path: 'report.txt', name: 'Report' }],
            })
        );
        const remoteSnapshot = await E2BAssetSnapshot.create(
            {
                hostPath: remoteOutput,
                runtimePath: '/outbox',
                access: 'read-write',
                excludedHostPaths: [],
                kind: 'outcome',
            },
            1024 * 1024
        );
        const client = new FakeClient();
        client.sandbox.artifactDownload = new Uint8Array(
            await readFile(remoteSnapshot.archive)
        );
        const runtime = await RuntimeRegistry.standard({ daytona: { client } })
            .resolve('daytona')
            .prepare({ ...request(resolved), outcome: { directory: outputDirectory } });
        try {
            await runtime.preflight();
            expect(runtime.environment.WORKBENCH_OUTPUT_DIR).toBe('/outbox');
            const store = new OutcomeStore(home);
            const collected = await runtime.collectOutcome?.(store);
            expect(collected).toMatchObject({
                application_state: 'pending',
                summary: 'Remote work complete',
                artifacts: [{ name: 'Report' }],
            });
            expect(collected?.warnings).toEqual([
                {
                    code: 'workspace_paths_excluded',
                    message:
                        '1 protected or nested workspace path was not sent to Daytona: "apps/web/.npmrc". This path cannot appear in returned changes.',
                },
            ]);
            await store.close();
        } finally {
            await runtime.cleanup();
            await remoteSnapshot.cleanup();
        }
        expect(client.deleted).toEqual(['sandbox-fixture']);
    });

    test('wb smoke prepares, checks, and deletes the sandbox', async () => {
        const resolved = await fixture();
        const client = new FakeClient();
        const result = await new RuntimeSmoke({
            workbench: resolved,
            workspaceDirectory: resolved.repositoryDirectory,
            environment: { OPENAI_API_KEY: 'fixture-key' },
            registry: RuntimeRegistry.standard({ daytona: { client } }),
        }).check();
        expect(result.runner).toEqual({ name: 'opencode', path: '/usr/bin/opencode' });
        expect(client.createOptions).toHaveLength(1);
        expect(client.deleted).toEqual(['sandbox-fixture']);
    });

    test('is registered in the standard runtime registry', async () => {
        const client = new FakeClient();
        const runtime = await RuntimeRegistry.standard({ daytona: { client } })
            .resolve('daytona')
            .prepare(request(await fixture()));
        try {
            expect(runtime.name).toBe('daytona');
        } finally {
            await runtime.cleanup();
        }
    });
});

class FakeClient implements DaytonaClient {
    readonly sandbox = new FakeSandbox();
    readonly createOptions: DaytonaCreateOptions[] = [];
    readonly deleted: string[] = [];
    deleteFailure: Error | undefined;

    async createSandbox(options: DaytonaCreateOptions): Promise<DaytonaSandbox> {
        this.createOptions.push(options);
        return this.sandbox;
    }

    async listSandboxes() {
        return [];
    }

    async getSandbox() {
        return this.sandbox;
    }

    async deleteSandbox(id: string): Promise<void> {
        if (this.deleteFailure) throw this.deleteFailure;
        this.deleted.push(id);
    }
}

class FakeSandbox implements DaytonaSandbox {
    readonly id = 'sandbox-fixture';
    readonly started: Array<{ command: string; options: DaytonaProcessOptions }> = [];
    readonly runs: Array<{ command: string; options: DaytonaRunOptions }> = [];
    readonly previews: Array<{ port: number; ttlSeconds: number }> = [];
    readonly uploads = new Map<string, Uint8Array>();
    readonly missingCommands = new Set<string>();
    artifactDownload: Uint8Array | undefined;
    nextRun: { code: number; stdout: string; stderr: string } | undefined;
    sandboxInfo: DaytonaSandboxInfo = { cpuCount: 1, memoryMB: 1_024, diskGb: 3 };
    uploadFailure: Error | undefined;
    holdProcesses = false;
    killedProcesses = 0;
    input = '';

    async run(command: string, options: DaytonaRunOptions = {}) {
        this.runs.push({ command, options });
        if (this.nextRun && command.startsWith("'opencode'")) {
            const result = this.nextRun;
            this.nextRun = undefined;
            return result;
        }
        if (command === e2bIdentityCommand) return result(0, '1000:1000');
        if (command === 'tar --help 2>&1') return result(0, '--null');
        if (command.startsWith('command -v')) {
            const name = command.match(/'([^']+)'/)?.[1] ?? 'tool';
            if (this.missingCommands.has(name)) return result(1);
            return result(0, `/usr/bin/${name}\n`);
        }
        if (command.includes('rev-parse HEAD')) return result(0, `${'a'.repeat(40)}\n`);
        if (command.startsWith('wc -c <')) {
            const path = command.match(/'([^']+)'/)?.[1] ?? '';
            return result(0, `${this.remoteBytes(path).byteLength}\n`);
        }
        return result(0);
    }

    async start(command: string, options: DaytonaProcessOptions = {}) {
        this.started.push({ command, options });
        await options.onStdout?.('streamed output');
        let release: (() => void) | undefined;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const process: DaytonaProcess = {
            wait: async () => {
                if (this.holdProcesses) await held;
                return this.holdProcesses ? result(143) : result(0);
            },
            sendStdin: async (value) => {
                this.input +=
                    typeof value === 'string' ? value : new TextDecoder().decode(value);
            },
            closeStdin: async () => {},
            kill: async () => {
                this.killedProcesses++;
                release?.();
            },
        };
        return process;
    }

    async upload(path: string, data: Uint8Array): Promise<void> {
        if (this.uploadFailure) throw this.uploadFailure;
        this.uploads.set(path, data);
    }

    async download(path: string): Promise<ReadableStream<Uint8Array>> {
        return new Blob([this.remoteBytes(path)]).stream();
    }

    /** What the sandbox would hold at a collection path: unchanged input, no deletions. */
    private remoteBytes(path: string): Uint8Array {
        if (path.includes('workbench-artifacts')) {
            return this.artifactDownload ?? new Uint8Array();
        }
        const output = path.match(/workbench-output-(\d+)/)?.[1];
        if (output !== undefined) {
            return (
                this.uploads.get(`/tmp/workbench-input-${output}.tar.gz`) ??
                new Uint8Array()
            );
        }
        return new Uint8Array();
    }

    async previewUrl(port: number, ttlSeconds: number): Promise<string> {
        this.previews.push({ port, ttlSeconds });
        return `https://${port}-token.proxy.daytona.test`;
    }

    async info(): Promise<DaytonaSandboxInfo> {
        return this.sandboxInfo;
    }
}

function result(code: number, stdout = '', stderr = '') {
    return { code, stdout, stderr };
}

async function fixture(
    overrides: {
        runtimes?: Record<string, WorkbenchRuntimeConfig>;
        requirements?: WorkbenchRequirements;
    } = {}
): Promise<ResolvedWorkbench> {
    const repository = await mkdtemp(join(tmpdir(), 'workbench-daytona-runtime-'));
    temporaryDirectories.push(repository);
    const packageDirectory = join(repository, '.workbenches', 'daytona-fixture');
    await mkdir(packageDirectory, { recursive: true });
    const manifestPath = join(packageDirectory, 'workbench.yml');
    const instructionsPath = join(packageDirectory, 'instructions.md');
    await writeFile(manifestPath, 'fixture');
    await writeFile(instructionsPath, 'Use the fixture.');
    await writeFile(join(repository, 'source.txt'), 'baseline');
    return {
        manifestPath,
        packageDirectory,
        repositoryDirectory: repository,
        instructionsPath,
        skills: [],
        manifest: {
            spec: 1,
            version: '0.1.0',
            name: 'daytona-fixture',
            runner: 'opencode',
            model: { id: 'openai/gpt-5.6-terra' },
            instructions: './instructions.md',
            skills: [],
            tools: [],
            mcps: [],
            env: {},
            runtimes: overrides.runtimes ?? {
                daytona: { class: 'linux', image: 'ghcr.io/example/workbench:1.0.0' },
            },
            ...(overrides.requirements ? { requirements: overrides.requirements } : {}),
        },
    };
}

function request(workbench: ResolvedWorkbench) {
    return {
        workbench,
        workspaceDirectory: workbench.repositoryDirectory,
        environment: { OPENAI_API_KEY: 'fixture-key' },
        assets: [
            { path: workbench.repositoryDirectory, access: 'read-write' as const },
            { path: workbench.packageDirectory, access: 'read-only' as const },
        ],
    };
}
