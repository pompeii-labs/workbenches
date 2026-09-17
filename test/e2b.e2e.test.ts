import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RunnerCredentialStore } from '../src/connections/credentials.js';
import {
    OutcomeApplier,
    OutcomeLifecycle,
    OutcomeStore,
    type RunOutcome,
} from '../src/outcomes/index.js';
import {
    InteractiveRun,
    type InteractiveRunSession,
    RunStore,
    type WorkbenchEvent,
} from '../src/runs/index.js';
import type { PreparedRuntime } from '../src/runtimes/contracts.js';
import type { E2BPty, E2BSandbox } from '../src/runtimes/e2b/contracts.js';
import { E2BManagedSandboxes } from '../src/runtimes/e2b/managed.js';
import { E2BRuntimeProvider } from '../src/runtimes/e2b/provider.js';
import { E2BOutcomeRecovery } from '../src/runtimes/e2b/recovery.js';
import { E2BSdkClient, e2bMetadata } from '../src/runtimes/e2b/sdk.js';
import { E2BStateStore } from '../src/runtimes/e2b/state.js';
import { SessionRetention } from '../src/sessions/index.js';
import type { ResolvedWorkbench } from '../src/types.js';
import { seedModelCatalogFixture } from './model-catalog-fixture.js';

const enabled = process.env.WORKBENCH_E2B_E2E === '1';
const sessionEnabled = process.env.WORKBENCH_E2B_SESSION_E2E === '1';
const projectDirectory = resolve(import.meta.dir, '..');
const cliPath = join(projectDirectory, 'src', 'cli.ts');
const temporaryDirectories: string[] = [];
const activeRuntimes = new Set<PreparedRuntime>();
const activeSessions = new Set<InteractiveRunSession>();

afterEach(async () => {
    await Promise.allSettled(
        [...activeSessions].map(async (session) => {
            activeSessions.delete(session);
            await session.cancel('E2B end-to-end test cleanup');
        })
    );
    await Promise.allSettled(
        [...activeRuntimes].map(async (runtime) => {
            activeRuntimes.delete(runtime);
            await runtime.cleanup();
        })
    );
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe.skipIf(!enabled)('E2B runtime end to end', () => {
    test('recovers interrupted collection from the original paused sandbox through the CLI', async () => {
        const workbench = await fixture();
        const home = await mkdtemp(join(tmpdir(), 'workbench-e2b-recovery-home-'));
        temporaryDirectories.push(home);
        const apiKey = process.env.E2B_API_KEY;
        if (!apiKey) throw new Error('E2B_API_KEY is required for this test');
        const client = new InterruptingArtifactClient(apiKey);
        const runs = new RunStore(home);
        const run = await runs.create({
            metadata: {
                workbench: workbench.manifest.name,
                workbench_version: workbench.manifest.version,
                runtime: 'e2b',
                runner: 'opencode',
                model: workbench.manifest.model.id,
                workspace: workbench.repositoryDirectory,
            },
            request: {
                workbench_path: workbench.packageDirectory,
                workspace: workbench.repositoryDirectory,
                task: 'Produce files for the recovery probe',
            },
        });
        const scope = RunStore.scope(home);
        const lifecycle = await OutcomeLifecycle.create({ home, runId: run.id });
        const runtime = await new E2BRuntimeProvider({ client }).prepare({
            workbench,
            workspaceDirectory: workbench.repositoryDirectory,
            environment: process.env,
            assets: [
                { path: workbench.repositoryDirectory, access: 'read-write' },
                { path: workbench.packageDirectory, access: 'read-only' },
            ],
            run: { id: run.id, scope },
            outcome: { directory: lifecycle.output.directory, home },
        });
        activeRuntimes.add(runtime);
        try {
            await runtime.preflight();
            expect(runtime.environment.WORKBENCH_OUTPUT_DIR).toBe('/outbox');
            expect(runtime.pathFor(lifecycle.output.directory)).toBe('/outbox');
            const child = runtime.launch({
                command: [
                    '/bin/sh',
                    '-c',
                    [
                        'printf "remote result\\n" > recovered.txt',
                        'printf "remote edit\\n" > delete-me.txt',
                        'printf "\\000\\001\\377" > "$WORKBENCH_OUTPUT_DIR/original.bin"',
                        'printf \'{"version":1,"summary":"Recovered result","links":[{"label":"Report","uri":"https://example.com/report","kind":"external"}]}\' > "$WORKBENCH_OUTPUT_DIR/outcome.json"',
                    ].join('; '),
                ],
                cwd: runtime.workspaceDirectory,
                env: runtime.environment,
            });
            await Promise.all([
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
            ]);
            expect(await child.exited).toBe(0);
            await expect(lifecycle.collect(runtime, 'complete')).rejects.toThrow(
                '--recover'
            );
            await runtime.cleanup();
            activeRuntimes.delete(runtime);
            await lifecycle.cleanup();
            await runs.update(run.id, {
                status: 'failed',
                finished_at: new Date().toISOString(),
            });
            await expectManagedState(client, scope, run.id, 'paused', 30_000);
            const recovery = new E2BOutcomeRecovery(home, { id: run.id, scope });
            expect(await recovery.exists()).toBeTrue();
            const sandboxes = E2BManagedSandboxes.connect(scope, {}, { client });
            if (!sandboxes) throw new Error('Expected managed E2B sandbox inventory');
            const review = await new SessionRetention(home, {
                sandboxes,
            }).review({ before: new Date() });
            expect(review.sandboxes).toHaveLength(0);
            expect(review.runs).toHaveLength(0);
            await writeFile(
                join(workbench.repositoryDirectory, 'delete-me.txt'),
                'new host edit\n'
            );
            const cli = Bun.spawn(
                [process.execPath, cliPath, 'outcome', run.id, '--recover', '--json'],
                {
                    cwd: workbench.repositoryDirectory,
                    env: { ...process.env, WORKBENCH_HOME: home },
                    stdout: 'pipe',
                    stderr: 'pipe',
                }
            );
            const [stdout, stderr, code] = await Promise.all([
                new Response(cli.stdout).text(),
                new Response(cli.stderr).text(),
                cli.exited,
            ]);
            expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
            const outcome = JSON.parse(stdout).outcome as RunOutcome;
            expect(outcome.completeness).toBe('partial');
            expect(outcome.summary).toBe('Recovered result');
            expect(outcome.artifacts).toHaveLength(1);
            expect(outcome.links).toHaveLength(1);
            const store = new OutcomeStore(home);
            const artifact = outcome.artifacts[0];
            if (!artifact) throw new Error('Expected recovered binary artifact');
            expect(await readFile(await store.blob(artifact.content))).toEqual(
                Buffer.from([0, 1, 255])
            );
            expect(
                await readFile(
                    join(workbench.repositoryDirectory, 'delete-me.txt'),
                    'utf8'
                )
            ).toBe('new host edit\n');
            await expect(
                new OutcomeApplier(store).apply(outcome, {
                    primary: workbench.repositoryDirectory,
                })
            ).rejects.toThrow('delete-me.txt');
            expect(await recovery.exists()).toBeFalse();
            expect((await runs.read(run.id)).outcome_id).toBe(outcome.id);
            await expectManagedSandboxGone(client, scope, run.id);
        } finally {
            await lifecycle.cleanup();
            await runtime.cleanup().catch(() => {});
            for (const sandbox of await client.listManaged(scope))
                await client.killSandbox(sandbox.id).catch(() => {});
        }
    }, 180_000);

    test(
        'builds, streams, captures and applies an outcome, destroys its sandbox, and prunes paused orphans',
        async () => {
            const workbench = await fixture();
            const home = await mkdtemp(join(tmpdir(), 'workbench-e2b-clean-home-'));
            temporaryDirectories.push(home);
            const apiKey = process.env.E2B_API_KEY;
            if (!apiKey) throw new Error('E2B_API_KEY is required for this test');
            const client = new E2BSdkClient(apiKey);
            const run = {
                id: RunStore.createId(),
                scope: RunStore.scope(home),
            };
            const runtime = await new E2BRuntimeProvider({ client }).prepare({
                workbench,
                workspaceDirectory: workbench.repositoryDirectory,
                environment: process.env,
                assets: [
                    {
                        path: workbench.repositoryDirectory,
                        access: 'read-write',
                    },
                    {
                        path: workbench.packageDirectory,
                        access: 'read-only',
                    },
                ],
                run,
            });
            activeRuntimes.add(runtime);
            const preflight = await runtime.preflight();
            expect(preflight.runner.name).toBe('opencode');
            expect(
                (await client.listManaged(run.scope)).some(
                    (sandbox) => sandbox.runId === run.id
                )
            ).toBeTrue();

            const child = runtime.launch({
                command: [
                    '/bin/sh',
                    '-c',
                    'test ! -e ignored.txt; test ! -e .env; printf "real e2b output\\n"; printf "remote change\\n" > e2b-output.txt; dd if=/dev/zero of=e2b-large-output.bin bs=1048576 count=8 2>/dev/null; rm -f delete-me.txt; mkdir -p .workbenches/e2b-e2e; printf "tampered\\n" > .workbenches/e2b-e2e/instructions.md; git add -A; git commit -q --no-gpg-sign -m "agent commit"',
                ],
                cwd: runtime.workspaceDirectory,
                env: runtime.environment,
            });
            expect(await new Response(child.stdout).text()).toBe('real e2b output\n');
            await expect(child.exited).resolves.toBe(0);
            const store = new OutcomeStore(home);
            const outcome = await commitRuntimeOutcome(runtime, store, run.id);
            await expect(
                readFile(join(workbench.repositoryDirectory, 'e2b-output.txt'))
            ).rejects.toMatchObject({ code: 'ENOENT' });
            expect(
                await readFile(
                    join(workbench.repositoryDirectory, 'delete-me.txt'),
                    'utf8'
                )
            ).toBe('delete me');
            await new OutcomeApplier(store).apply(outcome, {
                primary: workbench.repositoryDirectory,
            });
            expect(
                await readFile(
                    join(workbench.repositoryDirectory, 'e2b-output.txt'),
                    'utf8'
                )
            ).toBe('remote change\n');
            await expect(
                readFile(join(workbench.repositoryDirectory, 'delete-me.txt'))
            ).rejects.toMatchObject({ code: 'ENOENT' });
            expect(await readFile(workbench.instructionsPath, 'utf8')).toBe(
                'Use the E2B fixture.'
            );
            expect(
                (
                    await stat(
                        join(workbench.repositoryDirectory, 'e2b-large-output.bin')
                    )
                ).size
            ).toBe(8 * 1024 * 1024);

            const sleeper = runtime.launch({
                command: ['/bin/sh', '-c', 'sleep 60'],
                cwd: runtime.workspaceDirectory,
                env: runtime.environment,
            });
            runtime.cancel(sleeper);
            expect(await sleeper.exited).not.toBe(0);

            await runtime.cleanup();
            activeRuntimes.delete(runtime);
            await expectManagedSandboxGone(client, run.scope, run.id);

            const orphanRunId = RunStore.createId();
            const orphan = await client.createSandbox({
                template: runtime.preparation?.immutableReference ?? '',
                metadata: e2bMetadata({ id: orphanRunId, scope: run.scope }),
                timeoutMilliseconds: 10_000,
            });
            try {
                await expectManagedState(
                    client,
                    run.scope,
                    orphanRunId,
                    'paused',
                    60_000
                );
                const sandboxes = E2BManagedSandboxes.connect(
                    run.scope,
                    {},
                    { client }
                );
                if (!sandboxes) throw new Error('Managed E2B cleanup unavailable');
                const retention = new SessionRetention(home, { sandboxes });
                const policy = { before: new Date() };
                expect((await retention.review(policy)).sandboxes).toContainEqual({
                    id: orphan.id,
                    runId: orphanRunId,
                    state: 'paused',
                });
                expect((await retention.apply(policy)).removedSandboxes).toContain(
                    orphan.id
                );
                await expectManagedSandboxGone(client, run.scope, orphanRunId);
            } finally {
                await orphan.kill().catch(() => {});
            }
        },
        10 * 60 * 1_000
    );

    test(
        'captures remote changes without touching the host and rejects an explicit conflicting apply',
        async () => {
            const workbench = await fixture();
            await writeFile(
                join(workbench.repositoryDirectory, 'conflict.txt'),
                'baseline\n'
            );
            await writeFile(
                join(workbench.repositoryDirectory, 'safe.txt'),
                'baseline\n'
            );
            const home = await mkdtemp(join(tmpdir(), 'workbench-e2b-conflict-'));
            temporaryDirectories.push(home);
            const apiKey = process.env.E2B_API_KEY;
            if (!apiKey) throw new Error('E2B_API_KEY is required for this test');
            const client = new E2BSdkClient(apiKey);
            const run = {
                id: RunStore.createId(),
                scope: RunStore.scope(home),
            };
            const runtime = await new E2BRuntimeProvider({ client }).prepare({
                workbench,
                workspaceDirectory: workbench.repositoryDirectory,
                environment: process.env,
                assets: [
                    {
                        path: workbench.repositoryDirectory,
                        access: 'read-write',
                    },
                    {
                        path: workbench.packageDirectory,
                        access: 'read-only',
                    },
                ],
                run,
            });
            activeRuntimes.add(runtime);
            await runtime.preflight();
            const remote = runtime.launch({
                command: [
                    '/bin/sh',
                    '-c',
                    'printf "remote\\n" > conflict.txt; printf "remote\\n" > safe.txt',
                ],
                cwd: runtime.workspaceDirectory,
                env: runtime.environment,
            });
            await expect(remote.exited).resolves.toBe(0);
            await writeFile(
                join(workbench.repositoryDirectory, 'conflict.txt'),
                'host\n'
            );

            const store = new OutcomeStore(home);
            const outcome = await commitRuntimeOutcome(runtime, store, run.id);
            await expect(
                new OutcomeApplier(store).apply(outcome, {
                    primary: workbench.repositoryDirectory,
                })
            ).rejects.toThrow(
                'Outcome conflicts with current workspace content: conflict.txt'
            );
            expect(
                await readFile(
                    join(workbench.repositoryDirectory, 'conflict.txt'),
                    'utf8'
                )
            ).toBe('host\n');
            expect(
                await readFile(join(workbench.repositoryDirectory, 'safe.txt'), 'utf8')
            ).toBe('baseline\n');

            await runtime.cleanup();
            activeRuntimes.delete(runtime);
            await expectManagedSandboxGone(client, run.scope, run.id);
        },
        10 * 60 * 1_000
    );

    test(
        'persists runner credentials across fresh sandboxes',
        async () => {
            const apiKey = process.env.E2B_API_KEY;
            if (!apiKey) throw new Error('E2B_API_KEY is required for this test');
            const workbench = await fixture();
            const home = await mkdtemp(join(tmpdir(), 'workbench-e2b-auth-home-'));
            temporaryDirectories.push(home);
            const client = new E2BSdkClient(apiKey);
            const scope = RunStore.scope(home);
            const credentials = await new RunnerCredentialStore(home).prepare(
                'e2b',
                'opencode'
            );
            const assets = [
                {
                    path: workbench.repositoryDirectory,
                    access: 'read-write' as const,
                },
                {
                    path: workbench.packageDirectory,
                    access: 'read-only' as const,
                },
            ];

            const firstRun = { id: RunStore.createId(), scope };
            const first = await new E2BRuntimeProvider({ client }).prepare({
                workbench,
                workspaceDirectory: workbench.repositoryDirectory,
                environment: process.env,
                assets,
                credentials,
                purpose: 'connect',
                run: firstRun,
            });
            activeRuntimes.add(first);
            await first.preflight();
            const written = await first.execute({
                command: [
                    '/bin/sh',
                    '-c',
                    'mkdir -p "$XDG_DATA_HOME/opencode"; printf \'{"fixture":"persistent"}\\n\' > "$XDG_DATA_HOME/opencode/auth.json"; chmod 600 "$XDG_DATA_HOME/opencode/auth.json"',
                ],
                cwd: first.workspaceDirectory,
                env: first.environment,
            });
            expect(written.code, written.stderr).toBe(0);
            await first.cleanup();
            activeRuntimes.delete(first);
            await expectManagedSandboxGone(client, scope, firstRun.id);
            expect(
                await readFile(
                    join(
                        (await new E2BStateStore(credentials.directory).source())
                            .directory,
                        'opencode',
                        'auth.json'
                    ),
                    'utf8'
                )
            ).toBe('{"fixture":"persistent"}\n');

            const secondRun = { id: RunStore.createId(), scope };
            const second = await new E2BRuntimeProvider({ client }).prepare({
                workbench,
                workspaceDirectory: workbench.repositoryDirectory,
                environment: process.env,
                assets,
                credentials,
                purpose: 'run',
                run: secondRun,
            });
            activeRuntimes.add(second);
            await second.preflight();
            const restored = await second.execute({
                command: ['/bin/sh', '-c', 'cat "$XDG_DATA_HOME/opencode/auth.json"'],
                cwd: second.workspaceDirectory,
                env: second.environment,
            });
            expect(restored.code, restored.stderr).toBe(0);
            expect(restored.stdout).toBe('{"fixture":"persistent"}\n');
            await second.cleanup();
            activeRuntimes.delete(second);
            await expectManagedSandboxGone(client, scope, secondRun.id);
        },
        10 * 60 * 1_000
    );

    test(
        'provides an interactive PTY with input forwarding',
        async () => {
            const apiKey = process.env.E2B_API_KEY;
            if (!apiKey) throw new Error('E2B_API_KEY is required for this test');
            const client = new E2BSdkClient(apiKey);
            const home = await mkdtemp(join(tmpdir(), 'workbench-e2b-pty-home-'));
            temporaryDirectories.push(home);
            const run = {
                id: RunStore.createId(),
                scope: RunStore.scope(home),
            };
            const prepared = await client.prepareTemplate(
                { image: 'e2bdev/base:latest' },
                'workbench-e2b-pty-e2e-v1'
            );
            const sandbox = await client.createSandbox({
                template: prepared.immutableReference,
                metadata: e2bMetadata(run),
                timeoutMilliseconds: 60_000,
            });
            const decoder = new TextDecoder();
            let output = '';
            try {
                const terminal = await sandbox.startPty(
                    `/bin/sh -c 'read value; test "$value" = input && echo remote-pty-ok'`,
                    {
                        columns: 80,
                        rows: 24,
                        onData: (data) => {
                            output += decoder.decode(data, { stream: true });
                        },
                    }
                );
                await terminal.sendInput(new TextEncoder().encode('input\r'));
                const result = await terminal.wait();
                output += decoder.decode();
                expect(result.code, result.stderr).toBe(0);
                expect(output).toContain('remote-pty-ok');
            } finally {
                await sandbox.kill().catch(() => {});
            }
            await expectManagedSandboxGone(client, run.scope, run.id);
        },
        2 * 60 * 1_000
    );

    test(
        'opens the real OpenCode provider authentication menu in a PTY',
        async () => {
            const apiKey = process.env.E2B_API_KEY;
            if (!apiKey) throw new Error('E2B_API_KEY is required for this test');
            const client = new E2BSdkClient(apiKey);
            const home = await mkdtemp(join(tmpdir(), 'workbench-e2b-auth-pty-'));
            temporaryDirectories.push(home);
            const run = {
                id: RunStore.createId(),
                scope: RunStore.scope(home),
            };
            const prepared = await client.prepareTemplate(
                { image: 'ghcr.io/anomalyco/opencode:1.18.30' },
                'workbench-e2b-opencode-auth-e2e-v1'
            );
            const sandbox = await client.createSandbox({
                template: prepared.immutableReference,
                metadata: e2bMetadata(run),
                timeoutMilliseconds: 60_000,
            });
            const decoder = new TextDecoder();
            let output = '';
            let terminal: E2BPty | undefined;
            let resolveMenu: (() => void) | undefined;
            let rejectMenu: ((error: Error) => void) | undefined;
            const menu = new Promise<void>((resolveMenuPromise, rejectMenuPromise) => {
                resolveMenu = resolveMenuPromise;
                rejectMenu = rejectMenuPromise;
            });
            const timeout = setTimeout(() => {
                rejectMenu?.(
                    new Error(
                        `OpenCode authentication menu did not appear: ${output.slice(-500)}`
                    )
                );
            }, 30_000);
            try {
                terminal = await sandbox.startPty(
                    'opencode auth login --provider openai',
                    {
                        columns: 100,
                        rows: 30,
                        env: { XDG_DATA_HOME: '/tmp/workbench-credentials' },
                        onData: (data) => {
                            output += decoder.decode(data, { stream: true });
                            if (output.includes('ChatGPT')) resolveMenu?.();
                        },
                    }
                );
                await menu;
                await terminal.sendInput(new Uint8Array([0x03]));
                await terminal.wait();
                output += decoder.decode();
                expect(output).toContain('ChatGPT');
            } finally {
                clearTimeout(timeout);
                await terminal?.kill().catch(() => {});
                await sandbox.kill().catch(() => {});
            }
            await expectManagedSandboxGone(client, run.scope, run.id);
        },
        2 * 60 * 1_000
    );

    test(
        'reconciles a crashed worker and removes its sandbox through wb clean',
        async () => {
            const home = await mkdtemp(join(tmpdir(), 'workbench-e2b-crash-home-'));
            const workspace = await mkdtemp(
                join(tmpdir(), 'workbench-e2b-crash-workspace-')
            );
            temporaryDirectories.push(home, workspace);
            const apiKey = process.env.E2B_API_KEY;
            if (!apiKey) throw new Error('E2B_API_KEY is required for this test');
            const client = new E2BSdkClient(apiKey);
            const store = new RunStore(home);
            const runId = RunStore.createId();
            const scope = RunStore.scope(home);
            await store.create({
                id: runId,
                metadata: {
                    workbench: 'e2b-crash-e2e',
                    workbench_version: '0.0.1-e2e',
                    runner: 'opencode',
                    model: 'openai/gpt-5.6-terra',
                    runtime: 'e2b',
                    workspace,
                    mode: 'detached',
                    execution: 'session',
                },
                request: {
                    workbench_path: workspace,
                    workspace,
                    task: 'crash probe',
                },
            });
            await store.update(runId, {
                status: 'running',
                started_at: new Date().toISOString(),
                pid: 2_147_483_647,
            });
            const prepared = await client.prepareTemplate(
                { image: 'e2bdev/base:latest' },
                'workbench-e2b-clean-e2e-v1'
            );
            const sandbox = await client.createSandbox({
                template: prepared.immutableReference,
                metadata: e2bMetadata({ id: runId, scope }),
                timeoutMilliseconds: 60_000,
            });
            try {
                const report = await clean(home);
                expect(report.reconciled_runs).toContain(runId);
                expect(report.removed.runs).toEqual([]);
                expect(report.removed.sandboxes).toContain(sandbox.id);
                await expectManagedSandboxGone(client, scope, runId);
                expect((await store.read(runId)).status).toBe('failed');

                const historyCleanup = await clean(home);
                expect(historyCleanup.removed.runs).toContain(runId);
                await expect(store.read(runId)).rejects.toThrow(
                    `Workbench run does not exist: ${runId}`
                );
            } finally {
                await sandbox.kill().catch(() => {});
            }
        },
        10 * 60 * 1_000
    );

    test(
        'pauses at lease expiry without retaining memory and remains cleanable',
        async () => {
            const home = await mkdtemp(join(tmpdir(), 'workbench-e2b-expiry-home-'));
            temporaryDirectories.push(home);
            const apiKey = process.env.E2B_API_KEY;
            if (!apiKey) throw new Error('E2B_API_KEY is required for this test');
            const client = new E2BSdkClient(apiKey);
            const run = {
                id: RunStore.createId(),
                scope: RunStore.scope(home),
            };
            const prepared = await client.prepareTemplate(
                { image: 'e2bdev/base:latest' },
                'workbench-e2b-clean-e2e-v1'
            );
            const sandbox = await client.createSandbox({
                template: prepared.immutableReference,
                metadata: e2bMetadata(run),
                timeoutMilliseconds: 10_000,
            });
            try {
                await expectManagedState(client, run.scope, run.id, 'paused', 60_000);
                const sandboxes = E2BManagedSandboxes.connect(
                    run.scope,
                    {},
                    { client }
                );
                if (!sandboxes) throw new Error('Managed E2B cleanup unavailable');
                const result = await new SessionRetention(home, {
                    sandboxes,
                }).apply({ before: new Date() });
                expect(result.removedSandboxes).toContain(sandbox.id);
                await expectManagedSandboxGone(client, run.scope, run.id);
            } finally {
                await sandbox.kill().catch(() => {});
            }
        },
        2 * 60 * 1_000
    );
});

class InterruptingArtifactClient extends E2BSdkClient {
    private interrupted = false;
    override async createSandbox(
        options: Parameters<E2BSdkClient['createSandbox']>[0]
    ): Promise<E2BSandbox> {
        const sandbox = await super.createSandbox(options);
        return new Proxy(sandbox, {
            get: (target, property) => {
                if (property === 'download')
                    return async (path: string) => {
                        if (!this.interrupted && path.includes('workbench-artifacts')) {
                            this.interrupted = true;
                            throw new Error('Injected interrupted artifact transfer');
                        }
                        return target.download(path);
                    };
                const value = Reflect.get(target, property, target);
                return typeof value === 'function' ? value.bind(target) : value;
            },
        });
    }
}

describe.skipIf(!sessionEnabled)('E2B interactive sessions end to end', () => {
    test(
        'runs and resumes a real OpenCode session in a fresh sandbox',
        async () => {
            if (!process.env.E2B_API_KEY) {
                throw new Error('E2B_API_KEY is required for this test');
            }
            if (!process.env.OPENROUTER_API_KEY) {
                throw new Error('OPENROUTER_API_KEY is required for this test');
            }
            const workbench = await sessionFixture();
            const home = await mkdtemp(join(tmpdir(), 'workbench-e2b-home-'));
            const nativeDirectory = await mkdtemp(
                join(tmpdir(), 'workbench-e2b-session-')
            );
            temporaryDirectories.push(home, nativeDirectory);
            const runId = RunStore.createId();
            const scope = RunStore.scope(home);
            const client = new E2BSdkClient(process.env.E2B_API_KEY);
            const sessionContext = {
                id: 'e2b-session-e2e',
                directory: nativeDirectory,
            };

            const firstEvents: WorkbenchEvent[] = [];
            const first = await InteractiveRun.start({
                runId,
                home,
                resolved: {
                    workbench,
                    workspaceDirectory: workbench.repositoryDirectory,
                    cleanup: async () => {},
                },
                session: sessionContext,
                onEvent: (event) => void firstEvents.push(event),
            });
            activeSessions.add(first);
            await first.send(
                'Remember the codeword topaz. Reply with exactly: remembered topaz'
            );
            expect(outputText(firstEvents).toLowerCase()).toContain('topaz');
            const nativeSessionId = first.runnerSessionId;
            expect(nativeSessionId).toBeString();
            if (!nativeSessionId) throw new Error('OpenCode did not create a session');
            await first.close();
            activeSessions.delete(first);
            await expectManagedSandboxGone(client, scope, runId);
            const savedNativeState = await new E2BStateStore(nativeDirectory).source();
            expect(
                (await stat(join(savedNativeState.directory, 'opencode.sqlite'))).size
            ).toBeGreaterThan(0);

            const resumedRunId = RunStore.createId();
            const resumedEvents: WorkbenchEvent[] = [];
            const resumed = await InteractiveRun.start({
                runId: resumedRunId,
                home,
                resolved: {
                    workbench,
                    workspaceDirectory: workbench.repositoryDirectory,
                    cleanup: async () => {},
                },
                session: { ...sessionContext, nativeSessionId },
                onEvent: (event) => void resumedEvents.push(event),
            });
            activeSessions.add(resumed);
            await resumed.send(
                'Reply with exactly the codeword from the prior process.'
            );
            expect(outputText(resumedEvents).toLowerCase()).toContain('topaz');
            await resumed.close();
            activeSessions.delete(resumed);
            await expectManagedSandboxGone(client, scope, resumedRunId);
        },
        10 * 60 * 1_000
    );
});

describe.skipIf(!sessionEnabled)('E2B CLI end to end', () => {
    test(
        'runs a real model turn through the public command path and cleans up',
        async () => {
            if (!process.env.E2B_API_KEY) {
                throw new Error('E2B_API_KEY is required for this test');
            }
            if (!process.env.OPENROUTER_API_KEY) {
                throw new Error('OPENROUTER_API_KEY is required for this test');
            }
            const workbench = await sessionFixture();
            const home = await mkdtemp(join(tmpdir(), 'workbench-e2b-cli-home-'));
            temporaryDirectories.push(home);
            await seedModelCatalogFixture(home);
            const client = new E2BSdkClient(process.env.E2B_API_KEY);
            const scope = RunStore.scope(home);

            const child = Bun.spawn(
                [
                    process.execPath,
                    cliPath,
                    'run',
                    workbench.packageDirectory,
                    '--task',
                    'Reply with exactly: cli-e2b-ok',
                    '--json',
                ],
                {
                    cwd: workbench.repositoryDirectory,
                    env: {
                        ...process.env,
                        WORKBENCH_HOME: home,
                        DO_NOT_TRACK: '1',
                    },
                    stdout: 'pipe',
                    stderr: 'pipe',
                }
            );
            const [stdout, stderr, code] = await Promise.all([
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
                child.exited,
            ]);

            expect(code, stderr).toBe(0);
            const events = parseEvents(stdout);
            expect(outputText(events).trim().toLowerCase()).toBe('cli-e2b-ok');
            expect(events.at(-1)).toMatchObject({
                type: 'run.completed',
                data: {
                    infrastructure: {
                        provider: 'e2b',
                        maximum_duration_ms: 3_600_000,
                        cost: { kind: 'estimated', currency: 'USD' },
                    },
                },
            });
            expect(
                events
                    .filter((event) => event.type === 'usage.updated')
                    .some(
                        (event) =>
                            typeof event.data === 'object' &&
                            event.data !== null &&
                            Reflect.has(event.data, 'infrastructure')
                    )
            ).toBeFalse();
            await expectManagedScopeEmpty(client, scope);
        },
        10 * 60 * 1_000
    );

    test(
        'protects detached worker crash results until explicit recovery',
        async () => {
            if (!process.env.E2B_API_KEY) {
                throw new Error('E2B_API_KEY is required for this test');
            }
            if (!process.env.OPENROUTER_API_KEY) {
                throw new Error('OPENROUTER_API_KEY is required for this test');
            }
            const workbench = await sessionFixture();
            const home = await mkdtemp(join(tmpdir(), 'workbench-e2b-kill-home-'));
            temporaryDirectories.push(home);
            await seedModelCatalogFixture(home);
            const client = new E2BSdkClient(process.env.E2B_API_KEY);
            const scope = RunStore.scope(home);
            const store = new RunStore(home);
            let workerPid: number | undefined;
            let runId: string | undefined;
            try {
                const detached = Bun.spawn(
                    [
                        process.execPath,
                        cliPath,
                        'run',
                        workbench.packageDirectory,
                        '--task',
                        'Reply with exactly: detached-e2b-ready',
                        '--detach',
                    ],
                    {
                        cwd: workbench.repositoryDirectory,
                        env: {
                            ...process.env,
                            WORKBENCH_HOME: home,
                            DO_NOT_TRACK: '1',
                        },
                        stdout: 'pipe',
                        stderr: 'pipe',
                    }
                );
                const [stdout, stderr, code] = await Promise.all([
                    new Response(detached.stdout).text(),
                    new Response(detached.stderr).text(),
                    detached.exited,
                ]);
                expect(code, stderr).toBe(0);
                const run = await store.latest();
                runId = run.id;
                workerPid = run.pid;
                expect(run.session_id).toBeString();
                if (!run.session_id) {
                    throw new Error('Detached Workbench session ID is unavailable');
                }
                expect(stdout.trim()).toBe(run.session_id);
                expect(workerPid).toBeNumber();
                if (!workerPid) throw new Error('Detached worker PID is unavailable');
                await expectManagedState(client, scope, run.id, 'running', 30_000);

                process.kill(workerPid, 'SIGKILL');
                await expectProcessGone(workerPid);
                const report = await clean(home);
                expect(report.reconciled_runs).toContain(run.id);
                expect(report.removed.sandboxes).toHaveLength(0);
                expect(report.protected.outcome_recoveries).toContainEqual(
                    expect.objectContaining({ run_id: run.id })
                );
                expect((await store.read(run.id)).status).toBe('failed');
                const recovery = Bun.spawn(
                    [
                        process.execPath,
                        cliPath,
                        'outcome',
                        run.id,
                        '--recover',
                        '--json',
                    ],
                    {
                        cwd: workbench.repositoryDirectory,
                        env: {
                            ...process.env,
                            WORKBENCH_HOME: home,
                            DO_NOT_TRACK: '1',
                        },
                        stdout: 'pipe',
                        stderr: 'pipe',
                    }
                );
                const [recovered, recoveryError, recoveryCode] = await Promise.all([
                    new Response(recovery.stdout).text(),
                    new Response(recovery.stderr).text(),
                    recovery.exited,
                ]);
                expect(recoveryCode, recoveryError).toBe(0);
                expect(JSON.parse(recovered).outcome.completeness).toBe('partial');
                await expectManagedSandboxGone(client, scope, run.id);
            } finally {
                if (workerPid && processAlive(workerPid)) {
                    process.kill(workerPid, 'SIGKILL');
                }
                for (const sandbox of await client.listManaged(scope)) {
                    if (!runId || sandbox.runId === runId) {
                        await client.killSandbox(sandbox.id).catch(() => {});
                    }
                }
            }
        },
        10 * 60 * 1_000
    );
});

async function expectManagedSandboxGone(
    client: E2BSdkClient,
    scope: string,
    runId: string
): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
        const matching = (await client.listManaged(scope)).filter(
            (sandbox) => sandbox.runId === runId
        );
        if (matching.length === 0) return;
        await Bun.sleep(250);
    }
    throw new Error(`Managed E2B sandbox still exists for run ${runId}`);
}

async function expectManagedScopeEmpty(
    client: E2BSdkClient,
    scope: string
): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
        if ((await client.listManaged(scope)).length === 0) return;
        await Bun.sleep(250);
    }
    throw new Error(`Managed E2B sandboxes still exist for scope ${scope}`);
}

async function expectManagedState(
    client: E2BSdkClient,
    scope: string,
    runId: string,
    state: 'running' | 'paused',
    timeoutMilliseconds: number
): Promise<void> {
    const deadline = Date.now() + timeoutMilliseconds;
    let observed = 'missing';
    while (Date.now() < deadline) {
        const matching = (await client.listManaged(scope)).find(
            (sandbox) => sandbox.runId === runId
        );
        observed = matching?.state ?? 'missing';
        if (matching?.state === state) return;
        await Bun.sleep(1_000);
    }
    throw new Error(
        `Managed E2B sandbox ${runId} did not reach ${state}; last state was ${observed}`
    );
}

async function expectProcessGone(pid: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (!processAlive(pid)) return;
        await Bun.sleep(25);
    }
    throw new Error(`Detached Workbench worker is still alive: ${pid}`);
}

function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function commitRuntimeOutcome(
    runtime: PreparedRuntime,
    store: OutcomeStore,
    runId: string
): Promise<RunOutcome> {
    const collected = await runtime.collectOutcome?.(store);
    if (!collected) throw new Error('E2B runtime did not produce an outcome');
    const outcome: RunOutcome = {
        version: 1,
        id: OutcomeStore.createId(),
        run_id: runId,
        created_at: new Date().toISOString(),
        completeness: 'complete',
        ...(collected.summary ? { summary: collected.summary } : {}),
        changesets: collected.changesets,
        artifacts: collected.artifacts,
        links: collected.links,
        warnings: collected.warnings,
    };
    return store.commit(outcome, collected.application_state);
}

async function fixture(): Promise<ResolvedWorkbench> {
    const repository = await mkdtemp(join(tmpdir(), 'workbench-e2b-e2e-'));
    temporaryDirectories.push(repository);
    const packageDirectory = join(repository, '.workbenches', 'e2b-e2e');
    await mkdir(packageDirectory, { recursive: true });
    const dockerfile = [
        'FROM e2bdev/base:latest',
        'USER root',
        'RUN ln -s /bin/sh /usr/local/bin/opencode',
        '',
    ].join('\n');
    const manifestPath = join(packageDirectory, 'workbench.yml');
    const instructionsPath = join(packageDirectory, 'instructions.md');
    await writeFile(join(packageDirectory, 'Dockerfile'), dockerfile);
    await writeFile(manifestPath, 'fixture');
    await writeFile(instructionsPath, 'Use the E2B fixture.');
    await writeFile(join(repository, 'delete-me.txt'), 'delete me');
    await writeFile(join(repository, '.gitignore'), 'ignored.txt\n');
    await writeFile(join(repository, 'ignored.txt'), 'do not upload');
    await writeFile(join(repository, '.env'), 'SECRET=do-not-upload');
    return {
        manifestPath,
        packageDirectory,
        repositoryDirectory: repository,
        instructionsPath,
        skills: [],
        manifest: {
            spec: 0,
            version: '0.0.1-e2e',
            name: 'e2b-e2e',
            runner: 'opencode',
            model: { id: 'openai/gpt-5.6-terra' },
            instructions: './instructions.md',
            skills: [],
            tools: [],
            mcps: [],
            env: {},
            runtime: 'e2b',
            image: { build: './Dockerfile', context: '.' },
        },
    };
}

async function sessionFixture(): Promise<ResolvedWorkbench> {
    const repository = await mkdtemp(join(tmpdir(), 'workbench-e2b-session-e2e-'));
    temporaryDirectories.push(repository);
    const packageDirectory = join(repository, '.workbenches', 'e2b-opencode-e2e');
    await mkdir(packageDirectory, { recursive: true });
    const dockerfile = [
        'FROM ghcr.io/anomalyco/opencode:1.18.30',
        'USER root',
        'RUN apk add --no-cache git tar',
        '',
    ].join('\n');
    const manifestPath = join(packageDirectory, 'workbench.yml');
    const instructionsPath = join(packageDirectory, 'instructions.md');
    const workbench: ResolvedWorkbench = {
        manifestPath,
        packageDirectory,
        repositoryDirectory: repository,
        instructionsPath,
        skills: [],
        manifest: {
            spec: 0,
            version: '0.0.1-e2e',
            name: 'e2b-opencode-e2e',
            runner: 'opencode',
            model: {
                id: 'openai/gpt-5.4-mini',
                routes: [{ provider: 'openrouter' }],
            },
            instructions: './instructions.md',
            skills: [],
            tools: [],
            mcps: [],
            env: {},
            runtime: 'e2b',
            image: { build: './Dockerfile.workbench', context: '.' },
        },
    };
    await writeFile(join(packageDirectory, 'Dockerfile.workbench'), dockerfile);
    await writeFile(manifestPath, Bun.YAML.stringify(workbench.manifest));
    await writeFile(
        instructionsPath,
        '# E2B session probe\n\nFollow exact response-format instructions and remember facts across turns.\n'
    );
    return workbench;
}

function parseEvents(output: string): WorkbenchEvent[] {
    return output
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as WorkbenchEvent);
}

function outputText(events: WorkbenchEvent[]): string {
    return events
        .filter((event) => event.type === 'output.text')
        .map((event) =>
            typeof event.data === 'object' && event.data
                ? String(Reflect.get(event.data, 'text') ?? '')
                : ''
        )
        .join('');
}

async function clean(home: string): Promise<{
    reconciled_runs: string[];
    removed: { runs: string[]; sandboxes: string[] };
    protected: { outcome_recoveries: Array<{ run_id: string }> };
}> {
    const cleanup = Bun.spawn(
        [process.execPath, cliPath, 'clean', '--older-than=0ms', '--apply', '--json'],
        {
            cwd: projectDirectory,
            env: {
                ...process.env,
                WORKBENCH_HOME: home,
                DO_NOT_TRACK: '1',
            },
            stdout: 'pipe',
            stderr: 'pipe',
        }
    );
    const [stdout, stderr, code] = await Promise.all([
        new Response(cleanup.stdout).text(),
        new Response(cleanup.stderr).text(),
        cleanup.exited,
    ]);
    expect(code, stderr).toBe(0);
    return JSON.parse(stdout) as {
        reconciled_runs: string[];
        removed: { runs: string[]; sandboxes: string[] };
        protected: { outcome_recoveries: Array<{ run_id: string }> };
    };
}
