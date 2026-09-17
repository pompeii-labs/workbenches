import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OutcomeStore } from '../src/outcomes/index.js';
import type {
    E2BClient,
    E2BCommand,
    E2BCommandOptions,
    E2BPreparedTemplate,
    E2BPty,
    E2BPtyOptions,
    E2BRunOptions,
    E2BSandbox,
    E2BSandboxInfo,
    E2BTemplateSource,
} from '../src/runtimes/e2b/contracts.js';
import { e2bIdentityCommand } from '../src/runtimes/e2b/directories.js';
import { E2BManagedSandboxes } from '../src/runtimes/e2b/managed.js';
import { E2BRuntimeProvider } from '../src/runtimes/e2b/provider.js';
import { E2BAssetSnapshot } from '../src/runtimes/e2b/snapshot.js';
import { RuntimeRegistry } from '../src/runtimes/index.js';
import type { ResolvedWorkbench } from '../src/types.js';
import { runtimeProviderContract } from './runtime-provider-contract.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('E2B runtime provider', () => {
    runtimeProviderContract({
        createProvider: () => new E2BRuntimeProvider({ client: new FakeClient() }),
        request: async () => request(await fixture()),
    });

    test('requires an API key before contacting E2B', async () => {
        const resolved = await fixture();
        await expect(
            new E2BRuntimeProvider().prepare({
                ...request(resolved),
                environment: {},
            })
        ).rejects.toThrow('E2B_API_KEY is required for the E2B runtime');
    });

    test('prepares a deterministic image template and labels the sandbox', async () => {
        const resolved = await fixture();
        const client = new FakeClient();
        const run = {
            id: `wb_${'a'.repeat(20)}`,
            scope: 'b'.repeat(24),
        };
        const runtime = await new E2BRuntimeProvider({ client }).prepare({
            ...request(resolved),
            run,
        });
        try {
            expect(runtime.preparation).toMatchObject({
                kind: 'image',
                reference: 'ghcr.io/example/workbench:1.0.0',
                immutableReference: 'template-fixture',
                action: 'built',
            });
            await runtime.preflight();
            expect(client.templateSources).toEqual([
                { image: 'ghcr.io/example/workbench:1.0.0' },
            ]);
            expect(client.templateNames[0]).toMatch(
                /^workbench-e2b-fixture-[a-f0-9]{20}$/
            );
            expect(client.createOptions[0]?.metadata).toEqual({
                'dev.workbenches.managed': 'true',
                'dev.workbenches.run': run.id,
                'dev.workbenches.scope': run.scope,
            });
            expect(client.createOptions[0]?.timeoutMilliseconds).toBe(3_600_000);
        } finally {
            await runtime.cleanup();
        }
    });

    test('provisions staging paths for non-root users without elevating the harness', async () => {
        const client = new FakeClient();
        const runtime = await new E2BRuntimeProvider({ client }).prepare(
            request(await fixture())
        );
        try {
            await runtime.preflight();
            const setup = client.sandbox.runs.find(
                (run) => run.options.user === 'root'
            );
            expect(setup?.command).toContain("chown '1000:1000' '/workspace'");
            expect(setup?.command).toContain("test ! -L '/workspace'");
            expect(setup?.command).toContain("chmod 700 '/workspace'");
            expect(client.sandbox.runs.filter((run) => run.options.user)).toHaveLength(
                1
            );
            const process = runtime.launchSession(
                {
                    command: ['opencode', 'run', 'hello'],
                    cwd: runtime.workspaceDirectory,
                    env: {},
                },
                { stdin: 'pipe' }
            );
            await expect(process.exited).resolves.toBe(0);
            expect(
                Reflect.get(client.sandbox.started[0]?.options ?? {}, 'user')
            ).toBeUndefined();
        } finally {
            await runtime.cleanup();
        }
    });

    test('refuses malformed user identities before privileged directory setup', async () => {
        const client = new FakeClient();
        client.sandbox.runtimeIdentity = '1000:1000; touch /unsafe';
        const runtime = await new E2BRuntimeProvider({ client }).prepare(
            request(await fixture())
        );
        try {
            await expect(runtime.preflight()).rejects.toThrow(
                'Invalid E2B runtime user identity'
            );
            expect(client.sandbox.runs.some((run) => run.options.user)).toBeFalse();
            expect(client.sandbox.started).toHaveLength(0);
            expect(client.sandbox.killed).toBeTrue();
        } finally {
            await runtime.cleanup();
        }
    });

    test('reports remote duration, resources, and estimated infrastructure cost', async () => {
        const resolved = await fixture();
        const client = new FakeClient();
        client.sandbox.sandboxInfo = {
            startedAt: new Date('2026-09-11T12:00:00.000Z'),
            endAt: new Date('2026-09-11T13:00:00.000Z'),
            cpuCount: 2,
            memoryMB: 4_096,
        };
        const runtime = await new E2BRuntimeProvider({
            client,
            now: () => new Date('2026-09-11T12:00:10.000Z'),
        }).prepare(request(resolved));
        try {
            await runtime.preflight();
            await expect(runtime.infrastructure?.()).resolves.toEqual({
                provider: 'e2b',
                duration_ms: 10_000,
                maximum_duration_ms: 3_600_000,
                resources: { cpu_count: 2, memory_mb: 4_096 },
                cost: {
                    kind: 'estimated',
                    currency: 'USD',
                    amount_usd: 0.00046,
                    source: 'e2b-public-pricing-2026-09-11',
                },
            });
        } finally {
            await runtime.cleanup();
        }
    });

    test('keeps infrastructure accounting separate when sandbox metadata is unavailable', async () => {
        const resolved = await fixture();
        const client = new FakeClient();
        client.sandbox.infoFailure = new Error('metadata unavailable');
        const runtime = await new E2BRuntimeProvider({
            client,
            now: () => new Date('2026-09-11T12:00:10.000Z'),
        }).prepare(request(resolved));
        try {
            await runtime.preflight();
            await expect(runtime.infrastructure?.()).resolves.toMatchObject({
                provider: 'e2b',
                maximum_duration_ms: 3_600_000,
                cost: { kind: 'unavailable', currency: 'USD' },
            });
        } finally {
            await runtime.cleanup();
        }
    });

    test('streams process output, forwards input, and resolves service URLs', async () => {
        const resolved = await fixture();
        const client = new FakeClient();
        const runtime = await new RuntimeRegistry([new E2BRuntimeProvider({ client })])
            .resolve('e2b')
            .prepare(request(resolved));
        try {
            await runtime.preflight();
            const process = runtime.launchSession(
                {
                    command: ['opencode', 'run', "it's safe"],
                    cwd: runtime.workspaceDirectory,
                    env: { VALUE: 'present', OMITTED: undefined },
                },
                { stdin: 'pipe' }
            );
            await process.stdin?.write('steer\n');
            await process.stdin?.end?.();
            expect(await new Response(process.stdout).text()).toBe('streamed output');
            await expect(process.exited).resolves.toBe(0);
            expect(client.sandbox.started[0]?.command).toContain(`'it'"'"'s safe'`);
            expect(client.sandbox.started[0]?.options.env).toEqual({
                VALUE: 'present',
            });
            expect(client.sandbox.input).toBe('steer\n');

            await expect(
                runtime.interact({
                    command: ['opencode', 'auth', 'login', '--provider', 'openai'],
                    cwd: runtime.workspaceDirectory,
                    env: { XDG_DATA_HOME: '/workbench-credentials' },
                })
            ).resolves.toBe(0);
            expect(client.sandbox.ptyStarted[0]?.command).toContain(
                `'opencode' 'auth' 'login' '--provider' 'openai'`
            );
            expect(client.sandbox.ptyStarted[0]?.options).toMatchObject({
                cwd: runtime.workspaceDirectory,
                env: { XDG_DATA_HOME: '/workbench-credentials' },
            });

            const service = runtime.launchService((binding) => ({
                command: ['opencode', 'serve', binding.hostname, String(binding.port)],
                cwd: runtime.workspaceDirectory,
                env: {},
            }));
            await expect(
                service.resolveUrl('http://0.0.0.0:4096/session?id=1')
            ).resolves.toBe('https://4096-sandbox.e2b.test/session?id=1');
            await service.process.exited;
        } finally {
            await runtime.cleanup();
        }
        expect(client.sandbox.killed).toBeTrue();
    });

    test('does not pass the E2B credential into runtime commands', async () => {
        const resolved = await fixture();
        resolved.manifest.env.E2B_API_KEY = { required: false };
        const client = new FakeClient();
        const runtime = await new E2BRuntimeProvider({ client }).prepare({
            ...request(resolved),
            environment: {
                E2B_API_KEY: 'e2b-secret',
                OPENAI_API_KEY: 'model-secret',
            },
        });
        try {
            await runtime.preflight();
            expect(runtime.environment).not.toHaveProperty('E2B_API_KEY');
            expect(runtime.environment.OPENAI_API_KEY).toBe('model-secret');
            expect(JSON.stringify(client.sandbox.started)).not.toContain('e2b-secret');
        } finally {
            await runtime.cleanup();
        }
    });

    test('stages persistent native runner credentials without exposing the E2B key', async () => {
        const resolved = await fixture();
        const credentials = await mkdtemp(join(tmpdir(), 'workbench-e2b-credentials-'));
        temporaryDirectories.push(credentials);
        await mkdir(join(credentials, 'opencode'), { recursive: true });
        await writeFile(join(credentials, 'opencode', 'auth.json'), '{}\n', {
            mode: 0o600,
        });
        const client = new FakeClient();
        const runtime = await new E2BRuntimeProvider({ client }).prepare({
            ...request(resolved),
            environment: {
                E2B_API_KEY: 'e2b-secret',
            },
            credentials: {
                runtime: 'e2b',
                runner: 'opencode',
                directory: credentials,
            },
        });
        try {
            expect(runtime.nativeAuthentication).toBe('persistent');
            expect(runtime.pathFor(credentials)).toBe('/workbench-credentials');
            expect(runtime.environment).toMatchObject({
                HOME: '/tmp/workbench-home',
                XDG_DATA_HOME: '/workbench-credentials',
            });
            expect(runtime.environment).not.toHaveProperty('E2B_API_KEY');
            await runtime.preflight();
            expect(client.sandbox.uploads.size).toBe(3);
        } finally {
            await runtime.cleanup();
        }
        expect(await readFile(join(credentials, 'opencode', 'auth.json'), 'utf8')).toBe(
            '{}\n'
        );
    });

    test('rejects credential storage for another runtime or runner', async () => {
        const resolved = await fixture();
        const credentials = await mkdtemp(join(tmpdir(), 'workbench-e2b-credentials-'));
        temporaryDirectories.push(credentials);
        const provider = new E2BRuntimeProvider({ client: new FakeClient() });

        await expect(
            provider.prepare({
                ...request(resolved),
                credentials: {
                    runtime: 'docker',
                    runner: 'opencode',
                    directory: credentials,
                },
            })
        ).rejects.toThrow('credential storage for the docker runtime');
        await expect(
            provider.prepare({
                ...request(resolved),
                credentials: {
                    runtime: 'e2b',
                    runner: 'pi',
                    directory: credentials,
                },
            })
        ).rejects.toThrow('credential storage does not match the Workbench runner');
    });

    test('fails preflight when a declared tool is absent inside the sandbox', async () => {
        const resolved = await fixture();
        resolved.manifest.tools = ['fixture-tool'];
        const client = new FakeClient();
        client.sandbox.missingCommands.add('fixture-tool');
        const runtime = await new E2BRuntimeProvider({ client }).prepare(
            request(resolved)
        );
        try {
            await expect(runtime.preflight()).rejects.toThrow(
                'Required CLI tool is unavailable in E2B image template-fixture: fixture-tool'
            );
        } finally {
            await runtime.cleanup();
        }
    });

    test('surfaces template preparation failures before creating a sandbox', async () => {
        const resolved = await fixture();
        const client = new FakeClient();
        client.templateFailure = new Error('template network unavailable');
        await expect(
            new RuntimeRegistry([new E2BRuntimeProvider({ client })])
                .resolve('e2b')
                .prepare(request(resolved))
        ).rejects.toThrow('template network unavailable');
        expect(client.createOptions).toHaveLength(0);
    });

    test('destroys a newly created sandbox when workspace upload fails', async () => {
        const resolved = await fixture();
        const client = new FakeClient();
        client.sandbox.uploadFailure = new Error('upload network unavailable');
        const runtime = await new E2BRuntimeProvider({ client }).prepare(
            request(resolved)
        );
        await expect(runtime.preflight()).rejects.toThrow('upload network unavailable');
        expect(client.sandbox.killed).toBeTrue();
        await runtime.cleanup();
    });

    test('closes output streams and cleans up when command start fails', async () => {
        const resolved = await fixture();
        const client = new FakeClient();
        const runtime = await new E2BRuntimeProvider({ client }).prepare(
            request(resolved)
        );
        await runtime.preflight();
        client.sandbox.startFailure = new Error('command network unavailable');
        const process = runtime.launchSession(
            {
                command: ['opencode', 'run', 'probe'],
                cwd: runtime.workspaceDirectory,
                env: runtime.environment,
            },
            { stdin: 'ignore' }
        );
        await expect(process.exited).rejects.toThrow('command network unavailable');
        await expect(new Response(process.stdout).text()).resolves.toBe('');
        await runtime.cleanup();
        expect(client.sandbox.killed).toBeTrue();
    });

    test('remaps a saved package independently from its active workspace', async () => {
        const resolved = await fixture();
        const workspace = await mkdtemp(join(tmpdir(), 'workbench-e2b-project-'));
        temporaryDirectories.push(workspace);
        await writeFile(join(workspace, 'project.txt'), 'active project');
        const client = new FakeClient();
        const runtime = await new E2BRuntimeProvider({ client }).prepare({
            ...request(resolved),
            workspaceDirectory: workspace,
            assets: [
                { path: workspace, access: 'read-write' },
                { path: resolved.packageDirectory, access: 'read-only' },
            ],
        });
        try {
            expect(runtime.workspaceDirectory).toBe('/workspace');
            expect(runtime.workbench.packageDirectory).toBe('/workbench');
            expect(runtime.workbench.repositoryDirectory).toBe('/workbench');
            expect(runtime.workbench.instructionsPath).toBe(
                '/workbench/instructions.md'
            );
            await runtime.preflight();
        } finally {
            await runtime.cleanup();
        }
    });

    test('collects declared remote artifacts without materializing them into the host output directory', async () => {
        const resolved = await fixture();
        const outputDirectory = await mkdtemp(join(tmpdir(), 'workbench-e2b-output-'));
        const remoteOutput = await mkdtemp(
            join(tmpdir(), 'workbench-e2b-remote-output-')
        );
        const home = await mkdtemp(join(tmpdir(), 'workbench-e2b-outcomes-'));
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
        const runtime = await RuntimeRegistry.standard({ e2b: { client } })
            .resolve('e2b')
            .prepare({
                ...request(resolved),
                outcome: { directory: outputDirectory },
            });
        try {
            await runtime.preflight();
            expect(runtime.environment.WORKBENCH_OUTPUT_DIR).toBe('/outbox');
            const store = new OutcomeStore(home);
            const before = client.sandbox.runs.length;
            const first = await runtime.collectOutput?.(store);
            expect(first?.artifacts[0]?.name).toBe('Report');
            expect(client.sandbox.killed).toBeFalse();
            expect(
                client.sandbox.runs
                    .slice(before)
                    .some((call) => call.command.includes('git -C'))
            ).toBeFalse();
            await writeFile(
                join(remoteOutput, 'report.txt'),
                'remote artifact revised'
            );
            const revision = await E2BAssetSnapshot.create(
                remoteSnapshot.binding,
                1024 * 1024
            );
            try {
                client.sandbox.artifactDownload = new Uint8Array(
                    await readFile(revision.archive)
                );
                const second = await runtime.collectOutput?.(store);
                expect(second?.artifacts[0]?.content.digest).not.toBe(
                    first?.artifacts[0]?.content.digest
                );
            } finally {
                await revision.cleanup();
            }
            const collected = await runtime.collectOutcome?.(store);
            expect(collected).toMatchObject({
                application_state: 'pending',
                summary: 'Remote work complete',
                artifacts: [{ name: 'Report' }],
            });
            const artifact = collected?.artifacts[0];
            if (!artifact) throw new Error('Expected a collected artifact');
            expect(await readFile(await store.blob(artifact.content), 'utf8')).toBe(
                'remote artifact revised'
            );
            const original = first?.artifacts[0];
            if (!original) throw new Error('Expected original remote artifact');
            expect(await readFile(await store.blob(original.content), 'utf8')).toBe(
                'remote artifact'
            );
            await store.close();
            await expect(
                readFile(join(outputDirectory, 'report.txt'))
            ).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            await runtime.cleanup();
            await remoteSnapshot.cleanup();
        }
    });

    test('rejects read-write file assets because they cannot be synchronized', async () => {
        const resolved = await fixture();
        const file = join(resolved.repositoryDirectory, 'state.json');
        await writeFile(file, '{}');
        await expect(
            new E2BRuntimeProvider({ client: new FakeClient() }).prepare({
                ...request(resolved),
                assets: [
                    ...request(resolved).assets,
                    { path: file, access: 'read-write' },
                ],
            })
        ).rejects.toThrow('E2B read-write runtime assets must be directories');
    });

    test('counts deletion metadata against the uncompressed output limit', async () => {
        const resolved = await fixture();
        const client = new FakeClient();
        client.sandbox.outputSize = 1;
        client.sandbox.deletedOutput = new TextEncoder().encode('x'.repeat(4_096));
        const runtime = await new E2BRuntimeProvider({
            client,
            maxTransferBytes: 4_096,
        }).prepare(request(resolved));
        const home = await mkdtemp(join(tmpdir(), 'workbench-e2b-outcomes-'));
        temporaryDirectories.push(home);
        try {
            await runtime.preflight();
            await expect(
                runtime.collectOutcome?.(new OutcomeStore(home))
            ).rejects.toThrow('E2B output exceeds the 4.0 KiB transfer safety limit');
            expect(
                await readFile(join(resolved.repositoryDirectory, 'source.txt'), 'utf8')
            ).toBe('baseline');
        } finally {
            await runtime.cleanup();
        }
    });

    test('enforces the output limit against downloaded bytes, not remote metadata', async () => {
        const resolved = await fixture();
        const client = new FakeClient();
        client.sandbox.outputSize = 1;
        client.sandbox.outputDownload = new Uint8Array(65);
        const runtime = await new E2BRuntimeProvider({
            client,
            maxTransferBytes: 64,
        }).prepare(request(resolved));
        const home = await mkdtemp(join(tmpdir(), 'workbench-e2b-outcomes-'));
        temporaryDirectories.push(home);
        try {
            await runtime.preflight();
            await expect(
                runtime.collectOutcome?.(new OutcomeStore(home))
            ).rejects.toThrow('E2B output exceeds the 64 B transfer safety limit');
            expect(
                await readFile(join(resolved.repositoryDirectory, 'source.txt'), 'utf8')
            ).toBe('baseline');
        } finally {
            await runtime.cleanup();
            expect(client.sandbox.killed).toBeTrue();
        }
    });

    test('destroys an unrecoverable sandbox after outcome collection fails', async () => {
        const resolved = await fixture();
        const client = new FakeClient();
        const home = await mkdtemp(join(tmpdir(), 'workbench-e2b-failure-'));
        temporaryDirectories.push(home);
        const runtime = await new E2BRuntimeProvider({
            client,
            maxTransferBytes: 64,
        }).prepare({
            ...request(resolved),
            outcome: { directory: home },
        });
        const store = new OutcomeStore(home);
        try {
            await runtime.preflight();
            client.sandbox.outputSize = 1;
            client.sandbox.outputDownload = new Uint8Array(65);
            await expect(runtime.collectOutcome?.(store)).rejects.toThrow(
                'transfer safety limit'
            );
        } finally {
            await runtime.cleanup();
            await store.close();
        }
        expect(client.sandbox.killed).toBeTrue();
        await runtime.cleanup();
    });

    test('destroys an unrecoverable sandbox when native state persistence fails', async () => {
        const resolved = await fixture();
        const client = new FakeClient();
        const state = await mkdtemp(join(tmpdir(), 'workbench-e2b-state-failure-'));
        temporaryDirectories.push(state);
        await writeFile(join(state, 'session.json'), '{}');
        const runtime = await new E2BRuntimeProvider({
            client,
            maxTransferBytes: 128,
        }).prepare({
            ...request(resolved),
            assets: [
                ...request(resolved).assets,
                { path: state, access: 'read-write', state: true },
            ],
        });
        await runtime.preflight();
        client.sandbox.outputDownload = new Uint8Array(129);
        await expect(runtime.cleanup()).rejects.toThrow('transfer safety limit');
        expect(client.sandbox.killed).toBeTrue();
        await runtime.cleanup();
    });
});

describe('managed E2B sandboxes', () => {
    test('lists and removes only scoped sandboxes with valid Workbench run IDs', async () => {
        const client = new FakeClient();
        client.managed = [
            { id: 'sandbox-valid', runId: `wb_${'a'.repeat(20)}`, state: 'paused' },
            { id: 'sandbox-foreign', runId: 'foreign', state: 'running' },
        ];
        const managed = E2BManagedSandboxes.connect('b'.repeat(24), {}, { client });
        if (!managed) throw new Error('Expected managed E2B sandbox storage');

        const listed = await managed.list();
        expect(listed).toEqual([
            {
                id: 'sandbox-valid',
                runId: `wb_${'a'.repeat(20)}`,
                state: 'paused',
            },
        ]);
        const candidate = listed[0];
        if (!candidate) throw new Error('Expected a managed sandbox');
        await managed.remove(candidate);
        expect(client.killed).toEqual(['sandbox-valid']);
    });
});

class FakeClient implements E2BClient {
    readonly sandbox = new FakeSandbox();
    readonly templateSources: E2BTemplateSource[] = [];
    readonly templateNames: string[] = [];
    readonly createOptions: Array<{
        template: string;
        metadata: Record<string, string>;
        timeoutMilliseconds: number;
    }> = [];
    managed: Array<{ id: string; runId: string; state: 'running' | 'paused' }> = [];
    readonly killed: string[] = [];
    templateFailure: Error | undefined;

    async prepareTemplate(
        source: E2BTemplateSource,
        name: string
    ): Promise<E2BPreparedTemplate> {
        if (this.templateFailure) throw this.templateFailure;
        this.templateSources.push(source);
        this.templateNames.push(name);
        return {
            name,
            immutableReference: 'template-fixture',
            action: 'built',
        };
    }

    async createSandbox(options: {
        template: string;
        metadata: Record<string, string>;
        timeoutMilliseconds: number;
    }): Promise<E2BSandbox> {
        this.createOptions.push(options);
        return this.sandbox;
    }

    async listManaged() {
        return this.managed;
    }

    async killSandbox(id: string): Promise<void> {
        this.killed.push(id);
    }
}

class FakeSandbox implements E2BSandbox {
    readonly id = 'sandbox-fixture';
    readonly started: Array<{ command: string; options: E2BCommandOptions }> = [];
    readonly runs: Array<{ command: string; options: E2BRunOptions }> = [];
    runtimeIdentity = '1000:1000';
    readonly ptyStarted: Array<{ command: string; options: E2BPtyOptions }> = [];
    readonly uploads = new Map<number, Uint8Array>();
    deletedOutput = new Uint8Array();
    outputSize: number | undefined;
    outputDownload: Uint8Array | undefined;
    artifactDownload: Uint8Array | undefined;
    input = '';
    readonly ptyInputs: Uint8Array[] = [];
    readonly ptyResizes: Array<{ columns: number; rows: number }> = [];
    killed = false;
    sandboxInfo: E2BSandboxInfo = {
        startedAt: new Date('2026-09-11T12:00:00.000Z'),
        endAt: new Date('2026-09-11T13:00:00.000Z'),
        cpuCount: 2,
        memoryMB: 4_096,
    };
    infoFailure: Error | undefined;
    uploadFailure: Error | undefined;
    startFailure: Error | undefined;
    readonly missingCommands = new Set<string>();

    async run(
        command: string,
        options: E2BRunOptions = {}
    ): Promise<{ code: number; stdout: string; stderr: string }> {
        this.runs.push({ command, options });
        if (command === e2bIdentityCommand) return result(0, this.runtimeIdentity);
        if (command === 'tar --help 2>&1') {
            return result(0, 'Usage: tar [OPTION...]\n      --null');
        }
        if (command.startsWith('command -v')) {
            const name = command.match(/'([^']+)'/)?.[1] ?? 'tool';
            if (this.missingCommands.has(name)) return result(1);
            return result(0, `/usr/bin/${name}\n`);
        }
        if (command.includes('git -C') && command.includes('rev-parse HEAD')) {
            return result(0, `${'a'.repeat(40)}\n`);
        }
        return result(0);
    }

    async start(command: string, options: E2BCommandOptions = {}): Promise<E2BCommand> {
        if (this.startFailure) throw this.startFailure;
        this.started.push({ command, options });
        await options.onStdout?.('streamed output');
        return {
            pid: 10,
            wait: async () => result(0),
            sendStdin: async (value) => {
                this.input +=
                    typeof value === 'string' ? value : new TextDecoder().decode(value);
            },
            closeStdin: async () => {},
            kill: async () => {},
        };
    }

    async startPty(command: string, options: E2BPtyOptions): Promise<E2BPty> {
        this.ptyStarted.push({ command, options });
        return {
            pid: 11,
            wait: async () => result(0),
            sendInput: async (data) => {
                this.ptyInputs.push(data);
            },
            resize: async (columns, rows) => {
                this.ptyResizes.push({ columns, rows });
            },
            kill: async () => {},
        };
    }

    async upload(path: string, data: ReadableStream<Uint8Array>): Promise<void> {
        if (this.uploadFailure) throw this.uploadFailure;
        const index = Number(path.match(/input-(\d+)/)?.[1] ?? 0);
        this.uploads.set(index, new Uint8Array(await new Response(data).arrayBuffer()));
    }

    download(path: string): Promise<ReadableStream<Uint8Array>> {
        if (path.includes('workbench-artifacts')) {
            return Promise.resolve(
                new Blob([this.artifactDownload ?? new Uint8Array()]).stream()
            );
        }
        if (path.includes('deleted')) {
            return Promise.resolve(new Blob([this.deletedOutput]).stream());
        }
        if (this.outputDownload) {
            return Promise.resolve(new Blob([this.outputDownload]).stream());
        }
        const index = Number(path.match(/(?:output|native-state)-(\d+)/)?.[1] ?? 0);
        return Promise.resolve(
            new Blob([this.uploads.get(index) ?? new Uint8Array()]).stream()
        );
    }

    async fileSize(path: string): Promise<number> {
        if (path.includes('workbench-artifacts')) {
            return this.artifactDownload?.byteLength ?? 0;
        }
        if (path.includes('deleted')) return this.deletedOutput.byteLength;
        if (this.outputSize !== undefined) return this.outputSize;
        const index = Number(path.match(/(?:output|native-state)-(\d+)/)?.[1] ?? 0);
        return this.uploads.get(index)?.byteLength ?? 0;
    }

    host(port: number): string {
        return `${port}-sandbox.e2b.test`;
    }

    async info(): Promise<E2BSandboxInfo> {
        if (this.infoFailure) throw this.infoFailure;
        return this.sandboxInfo;
    }

    async kill(): Promise<void> {
        this.killed = true;
    }
}

async function fixture(): Promise<ResolvedWorkbench> {
    const repository = await mkdtemp(join(tmpdir(), 'workbench-e2b-runtime-'));
    temporaryDirectories.push(repository);
    const packageDirectory = join(repository, '.workbenches', 'e2b-fixture');
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
            spec: 0,
            version: '0.1.0',
            name: 'e2b-fixture',
            runner: 'opencode',
            model: { id: 'openai/gpt-5.6-terra' },
            instructions: './instructions.md',
            skills: [],
            tools: [],
            mcps: [],
            env: {},
            runtime: 'e2b',
            image: 'ghcr.io/example/workbench:1.0.0',
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

function result(code: number, stdout = '', stderr = '') {
    return { code, stdout, stderr };
}
