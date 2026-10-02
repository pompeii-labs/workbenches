import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OutcomeStore } from '../../../src/outcomes/index.js';
import { RuntimeRegistry } from '../../../src/runtimes/index.js';
import { DiskTransfer } from '../../../src/runtimes/remote/disk/transfer.js';
import { MemoryAssetSource } from '../../../src/runtimes/staging/memory/source.js';
import { MemoryTransfer } from '../../../src/runtimes/staging/memory/transfer.js';
import { readArchive } from '../staging/archive.js';
import {
    cleanTemporaryDirectories,
    connection,
    daytonaProvider,
    disk,
    FakeClient,
    FakeClock,
    fixture,
    request,
    rules,
    track,
} from './fixture.js';

afterEach(cleanTemporaryDirectories);

const service =
    (workspace: string) => (binding: { hostname: string; port: number }) => ({
        command: ['opencode', 'serve', binding.hostname, String(binding.port)],
        cwd: workspace,
        env: {},
    });

describe('DaytonaRuntime', () => {
    test('checks tools inside the sandbox and names the image', async () => {
        const resolved = await fixture();
        resolved.manifest.tools = ['fixture-tool'];
        const client = new FakeClient();
        client.sandbox.missingCommands.add('fixture-tool');
        const runtime = await daytonaProvider({ client }).prepare(request(resolved));
        try {
            await expect(runtime.preflight()).rejects.toThrow(
                'Required CLI tool is unavailable in Daytona image ghcr.io/example/workbench:1.0.0: fixture-tool'
            );
            // A failed preflight leaves the sandbox for cleanup to delete.
            expect(client.deleted).toEqual([]);
        } finally {
            await runtime.cleanup();
        }
        expect(client.deleted).toEqual(['sandbox-fixture']);
    });

    test('reports the runner path after a successful preflight', async () => {
        const runtime = await daytonaProvider({
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
        const runtime = await daytonaProvider({ client }).prepare(request(resolved));
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

    test('skips root when the staging directories are pre-created and owned', async () => {
        const resolved = await fixture();
        const client = new FakeClient();
        for (const path of ['/workspace', '/workbench', '/tmp/workbench-home'])
            client.sandbox.ownedDirectories.add(path);
        client.sandbox.rootUnavailable = true;
        const runtime = await daytonaProvider({ client }).prepare(request(resolved));
        try {
            await runtime.preflight();
            expect(
                client.sandbox.runs.some((call) => call.options.user === 'root')
            ).toBeFalse();
            expect(
                client.sandbox.runs.some((call) =>
                    call.command.includes("chmod 700 '/workspace'")
                )
            ).toBeTrue();
        } finally {
            await runtime.cleanup();
        }
    });

    test('creates a writable-parent staging directory as the user without root', async () => {
        const client = new FakeClient();
        client.sandbox.rootUnavailable = true;
        client.sandbox.ownedDirectories.add('/workspace');
        client.sandbox.ownedDirectories.add('/workbench');
        const runtime = await daytonaProvider({ client }).prepare(
            request(await fixture())
        );
        try {
            await runtime.preflight();
            expect(
                client.sandbox.runs.some((call) => call.options.user === 'root')
            ).toBeFalse();
            expect(
                client.sandbox.runs.some((call) =>
                    call.command.includes("mkdir -p '/tmp/workbench-home'")
                )
            ).toBeTrue();
        } finally {
            await runtime.cleanup();
        }
    });

    test('uses root when a staging directory is missing', async () => {
        const client = new FakeClient();
        const runtime = await daytonaProvider({ client }).prepare(
            request(await fixture())
        );
        try {
            await runtime.preflight();
            expect(
                client.sandbox.runs.some(
                    (call) =>
                        call.options.user === 'root' &&
                        call.command.includes('mkdir -p')
                )
            ).toBeTrue();
        } finally {
            await runtime.cleanup();
        }
    });

    test('names the missing directory when root access is unavailable', async () => {
        const client = new FakeClient();
        client.sandbox.rootUnavailable = true;
        const runtime = await daytonaProvider({ client }).prepare(
            request(await fixture())
        );
        try {
            await expect(runtime.preflight()).rejects.toThrow(
                /staging directory \/\S+: the sandbox image must run as root, allow sudo, or pre-create that directory owned by the sandbox user/
            );
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
        const runtime = await daytonaProvider({
            client,
            assets: source,
            transfer: new MemoryTransfer(source, rules),
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
        const runtime = await daytonaProvider({ client }).prepare(
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
        const runtime = await daytonaProvider({
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
        const runtime = await new RuntimeRegistry([daytonaProvider({ client })])
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

            const launched = runtime.launchService(service(runtime.workspaceDirectory));
            expect(client.sandbox.started.at(-1)?.command).toContain(
                `'0.0.0.0' '4096'`
            );
            await expect(
                launched.resolveUrl('http://0.0.0.0:4096/session?id=1')
            ).resolves.toBe('https://4096-token.proxy.daytona.test/session?id=1');
            await launched.resolveUrl('http://0.0.0.0:4096/event');
            expect(client.sandbox.previews).toHaveLength(1);
            expect(client.sandbox.previews[0]?.port).toBe(4096);
            await launched.process.exited;
        } finally {
            await runtime.cleanup();
        }
    });

    test('retries the preview URL after a failed request instead of caching the failure', async () => {
        const client = new FakeClient();
        const clock = new FakeClock();
        const runtime = await daytonaProvider({ client, clock }).prepare(
            request(await fixture())
        );
        try {
            await runtime.preflight();
            const launched = runtime.launchService(service(runtime.workspaceDirectory));
            client.sandbox.previewAnswers = [new Error('preview unavailable')];
            await expect(launched.resolveUrl('http://0.0.0.0:4096/a')).resolves.toBe(
                'https://4096-token.proxy.daytona.test/a'
            );
            await launched.resolveUrl('http://0.0.0.0:4096/c');
            expect(client.sandbox.previews).toHaveLength(2);
            expect(clock.delays).toEqual([500]);
            await launched.process.exited;
        } finally {
            await runtime.cleanup();
        }
    });

    test('never puts a malformed signed preview URL in an error', async () => {
        const client = new FakeClient();
        const runtime = await daytonaProvider({ client }).prepare(
            request(await fixture())
        );
        try {
            await runtime.preflight();
            const launched = runtime.launchService(service(runtime.workspaceDirectory));
            client.sandbox.previewAnswers = ['not a url?token=signed-secret'];
            const error = await launched
                .resolveUrl('http://0.0.0.0:4096/a')
                .catch((value) => value);
            expect(error.message).toBe('Daytona returned a malformed preview URL');
            expect(error.message).not.toContain('signed-secret');
            await launched.process.exited;
        } finally {
            await runtime.cleanup();
        }
    });

    test('cancels a running process and forgets it', async () => {
        const client = new FakeClient();
        client.sandbox.holdProcesses = true;
        const runtime = await daytonaProvider({ client }).prepare(
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

    describe('cleanup', () => {
        test('deletes the sandbox and is safe to repeat', async () => {
            const client = new FakeClient();
            const runtime = await daytonaProvider({ client }).prepare(
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
            const runtime = await daytonaProvider({ client }).prepare(
                request(await fixture())
            );
            await expect(runtime.preflight()).rejects.toThrow(
                'upload network unavailable'
            );
            expect(client.deleted).toEqual(['sandbox-fixture']);
            await runtime.cleanup();
        });

        test('reports the sandbox when deleting it fails after staging fails', async () => {
            const client = new FakeClient();
            client.sandbox.uploadFailure = new Error('upload network unavailable');
            client.deleteFailure = new Error('delete network unavailable');
            const runtime = await daytonaProvider({ client }).prepare(
                request(await fixture())
            );
            const error = await runtime.preflight().catch((value) => value);
            expect(error.message).toContain('upload network unavailable');
            expect(error.message).toContain(
                'Daytona sandbox sandbox-fixture was not deleted'
            );
            await runtime.cleanup();
        });

        test('retries a failed deletion with a growing delay', async () => {
            const client = new FakeClient();
            client.deleteFailure = new Error('delete network unavailable');
            client.deleteFailures = 2;
            const clock = new FakeClock();
            const runtime = await daytonaProvider({ client, clock }).prepare(
                request(await fixture())
            );
            await runtime.preflight();
            await runtime.cleanup();
            expect(client.deleteAttempts).toBe(3);
            expect(client.deleted).toEqual(['sandbox-fixture']);
            expect(clock.delays).toEqual([1_000, 2_000]);
        });

        test('gives up after a bounded number of attempts and names the sandbox', async () => {
            const client = new FakeClient();
            client.deleteFailure = new Error('delete network unavailable');
            const clock = new FakeClock();
            const runtime = await daytonaProvider({ client, clock }).prepare(
                request(await fixture())
            );
            await runtime.preflight();
            const error = await runtime.cleanup().catch((value) => value);
            expect(error.name).toBe('RuntimeError');
            expect(error.message).toBe(
                'Daytona sandbox sandbox-fixture was not deleted after 4 attempts: delete network unavailable. Delete it with the Daytona dashboard or API.'
            );
            expect(client.deleteAttempts).toBe(4);
            expect(clock.delays).toEqual([1_000, 2_000, 4_000]);
            expect(client.deleted).toEqual([]);
        });

        test('is not clean until the sandbox is deleted, so a later call tries again', async () => {
            const client = new FakeClient();
            client.deleteFailure = new Error('delete network unavailable');
            const runtime = await daytonaProvider({ client }).prepare(
                request(await fixture())
            );
            await runtime.preflight();
            await expect(runtime.cleanup()).rejects.toThrow('was not deleted');
            client.deleteFailure = undefined;
            await runtime.cleanup();
            expect(client.deleted).toEqual(['sandbox-fixture']);
            await runtime.cleanup();
            expect(client.deleted).toEqual(['sandbox-fixture']);
        });
    });

    test('reports duration and resources without a cost estimate', async () => {
        const client = new FakeClient();
        client.sandbox.sandboxInfo = { cpuCount: 2, memoryMB: 4_096, diskGb: 10 };
        const clock = new FakeClock();
        const runtime = await daytonaProvider({ client, clock }).prepare(
            request(await fixture())
        );
        try {
            await runtime.preflight();
            clock.time = new Date('2026-09-30T12:00:10.000Z');
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
        const runtime = await daytonaProvider({ client }).prepare({
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
        const runtime = await daytonaProvider({
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

    test('collects declared artifacts and labels warnings with the provider', async () => {
        const resolved = await fixture();
        await mkdir(join(resolved.repositoryDirectory, 'apps', 'web'), {
            recursive: true,
        });
        await writeFile(
            join(resolved.repositoryDirectory, 'apps', 'web', '.npmrc'),
            'fixture config'
        );
        const outputDirectory = track(
            await mkdtemp(join(tmpdir(), 'workbench-daytona-out-'))
        );
        const remoteOutput = track(
            await mkdtemp(join(tmpdir(), 'workbench-daytona-remote-'))
        );
        const home = track(
            await mkdtemp(join(tmpdir(), 'workbench-daytona-outcomes-'))
        );
        await writeFile(join(remoteOutput, 'report.txt'), 'remote artifact');
        await writeFile(
            join(remoteOutput, 'outcome.json'),
            JSON.stringify({
                version: 1,
                summary: 'Remote work complete',
                artifacts: [{ path: 'report.txt', name: 'Report' }],
            })
        );
        const remoteSnapshot = await new DiskTransfer(disk, disk, rules).pack(
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
        client.sandbox.artifactDownload = await remoteSnapshot.archiveBytes();
        const runtime = await RuntimeRegistry.standard({ daytona: connection(client) })
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

    describe('reconnection', () => {
        /** Prepares a runtime, stages it, and returns the request and sandbox id. */
        async function staged(client: FakeClient) {
            const prepared = request(await fixture());
            const first = await daytonaProvider({ client }).prepare(prepared);
            await first.preflight();
            const sandboxId = first.sandboxId as string;
            return { prepared, sandboxId };
        }

        test('binds to the running sandbox without creating or uploading', async () => {
            const client = new FakeClient();
            const { prepared, sandboxId } = await staged(client);
            const uploads = client.sandbox.uploads.size;
            const runtime = await daytonaProvider({ client }).adopt(
                prepared,
                sandboxId
            );
            try {
                const result = await runtime.preflight();
                expect(runtime.sandboxId).toBe('sandbox-fixture');
                expect(result.runner.name).toBe('opencode');
                expect(client.createOptions).toHaveLength(1);
                expect(client.sandbox.uploads.size).toBe(uploads);
                expect(
                    client.sandbox.runs.some((call) =>
                        call.command.includes('rev-list')
                    )
                ).toBeTrue();
            } finally {
                await runtime.cleanup();
            }
            expect(client.deleted).toEqual(['sandbox-fixture']);
        });

        test('collects changes against the baseline recovered from the sandbox', async () => {
            const client = new FakeClient();
            const { prepared, sandboxId } = await staged(client);
            const runtime = await daytonaProvider({ client }).adopt(
                prepared,
                sandboxId
            );
            try {
                await runtime.preflight();
                const home = track(
                    await mkdtemp(join(tmpdir(), 'workbench-daytona-adopt-'))
                );
                const store = new OutcomeStore(home);
                const collected = await runtime.snapshotRepository?.(store);
                expect(collected).toMatchObject({ application_state: 'pending' });
                await store.close();
            } finally {
                await runtime.cleanup();
            }
        });

        test('fails when the sandbox no longer exists and deletes nothing', async () => {
            const client = new FakeClient();
            const { prepared, sandboxId } = await staged(client);
            client.missing = true;
            const runtime = await daytonaProvider({ client }).adopt(
                prepared,
                sandboxId
            );
            await expect(runtime.preflight()).rejects.toThrow(
                'Daytona sandbox does not exist: sandbox-fixture'
            );
            await runtime.cleanup();
            expect(client.deleted).toEqual([]);
        });

        test('fails when the sandbox is not running and deletes nothing', async () => {
            const client = new FakeClient();
            const { prepared, sandboxId } = await staged(client);
            client.sandbox.state = 'stopped';
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

        test('fails when a workspace baseline cannot be recovered', async () => {
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
            await runtime.cleanup();
            expect(client.deleted).toEqual([]);
        });

        test('reports no sandbox id before one exists', async () => {
            const runtime = await daytonaProvider({
                client: new FakeClient(),
            }).prepare(request(await fixture()));
            try {
                expect(runtime.sandboxId).toBeUndefined();
            } finally {
                await runtime.cleanup();
            }
        });
    });
});
