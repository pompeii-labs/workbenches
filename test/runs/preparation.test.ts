import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectionStore } from '../../src/connections/store.js';
import { OutcomeStore } from '../../src/outcomes/store.js';
import { RepositoryWorkspace } from '../../src/repositories/workspace.js';
import { runtimeContext } from '../../src/runners/context.js';
import { RunnerRegistry } from '../../src/runners/registry.js';
import { type PreparedRunner, Runner } from '../../src/runners/runner.js';
import { RunEvents } from '../../src/runs/events.js';
import { ExecutionPreparation } from '../../src/runs/preparation.js';
import { RunStore } from '../../src/runs/store.js';
import type {
    PreparedRuntime,
    RuntimePrepareRequest,
    RuntimeProvider,
} from '../../src/runtimes/contracts.js';
import { DockerMountPlan } from '../../src/runtimes/docker/mounts.js';
import { E2BPathPlan } from '../../src/runtimes/e2b/paths.js';
import { RuntimeRegistry } from '../../src/runtimes/registry.js';
import type { ResolvedWorkbench } from '../../src/types.js';
import { checkoutFixture, fixtureIdentity } from '../repositories/fixture.js';

const directories: string[] = [];
afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
});

describe('shared execution preparation', () => {
    for (const runtime of ['local', 'docker', 'e2b']) {
        test(`${runtime} gives authenticated repository runs normal gh and git credentials`, async () => {
            const fixture = await createFixture({
                runtime,
                repository: true,
                delivery: 'pr',
            });
            try {
                await fixture.preparation.prepare();
                const request = fixture.provider.request;
                if (!request) throw new Error('Missing runtime request');
                expect(request.environment.GH_TOKEN).toBe('github-account-credential');
                expect(request.environment.GIT_CONFIG_KEY_1).toBe(
                    'credential.https://github.com.helper'
                );
                expect(request.environment.GIT_CONFIG_VALUE_1).toBe(
                    '!gh auth git-credential'
                );
                expect(request.environment.GITHUB_TOKEN).toBeUndefined();
                expect(request.environment.SSH_AUTH_SOCK).toBeUndefined();
                const visible =
                    runtime === 'docker'
                        ? new DockerMountPlan(request).containerEnvironment()
                        : runtime === 'e2b'
                          ? new E2BPathPlan(request).environment()
                          : request.environment;
                expect(visible.GH_TOKEN).toBe('github-account-credential');
                expect(visible.GIT_CONFIG_COUNT).toBe('4');
                expect(visible.GIT_CONFIG_VALUE_2).toBe('example');
                expect(visible.GIT_CONFIG_VALUE_3).toBe(
                    '123+example@users.noreply.github.com'
                );
                const context = runtimeContext(
                    fixture.workbench,
                    request.workspaceDirectory,
                    visible
                );
                expect(context).toContain('GitHub authentication is available');
                expect(context).not.toContain('github-account-credential');
            } finally {
                await fixture.preparation.cleanup();
            }
        });
    }
    for (const runtime of ['local', 'docker', 'e2b']) {
        for (const runner of ['opencode', 'pi']) {
            for (const mode of ['one-shot', 'session'] as const) {
                test(`${runner} on ${runtime} keeps GitHub credentials out of legacy read-only repository ${mode} runs`, async () => {
                    const fixture = await createFixture({
                        runtime,
                        runner,
                        mode,
                        repository: true,
                    });
                    try {
                        const prepared = await fixture.preparation.prepare();
                        const request = fixture.provider.request;
                        if (!request || !fixture.repository)
                            throw new Error('Missing repository request');
                        const repository = fixture.repository;
                        const directory = join(
                            fixture.home,
                            'sessions',
                            fixture.repository.binding.session_id,
                            'repository'
                        );
                        expect(request.workspaceDirectory).toBe(directory);
                        expect(request.environment.GH_TOKEN).toBeUndefined();
                        expect(request.environment.GITHUB_TOKEN).toBeUndefined();
                        expect(request.environment.SSH_AUTH_SOCK).toBeUndefined();
                        expect(request.environment.GIT_CONFIG_VALUE_0).toBeUndefined();
                        expect(request.repository).toEqual({
                            name: 'example/project',
                            revision: fixture.repository.binding.revision,
                            delivery: 'none',
                        });
                        expect(request.assets).toContainEqual({
                            path:
                                runtime === 'local'
                                    ? join(directory, '.git')
                                    : join(
                                          fixture.home,
                                          'sessions',
                                          fixture.repository.binding.session_id,
                                          'agent-git'
                                      ),
                            access: 'read-write',
                            git: true,
                        });
                        expect(
                            request.assets.some((asset) => asset.path === fixture.root)
                        ).toBeFalse();
                        const invocation = prepared.runner.build(
                            prepared.runtime,
                            'Audit the project',
                            prepared.configuration
                        );
                        expect(JSON.stringify(invocation)).not.toContain(
                            'github-account-credential'
                        );
                        expect(
                            runtimeContext(
                                fixture.workbench,
                                directory,
                                request.environment
                            )
                        ).toContain('<repository name="example/project"');
                        expect(
                            fixture.eventsSeen.map((event) => event.type).slice(0, 2)
                        ).toEqual(['repository.preparing', 'repository.ready']);
                        if (runtime === 'docker') {
                            const plan = new DockerMountPlan(request);
                            expect(plan.arguments()).toContain(
                                `${fixture.home}/sessions/${fixture.repository.binding.session_id}/agent-git:/workspace/.git`
                            );
                            expect(plan.containerEnvironment()).toMatchObject({
                                WORKBENCH_REPOSITORY: 'example/project',
                            });
                            expect(
                                plan.containerEnvironment().GH_TOKEN
                            ).toBeUndefined();
                        }
                        if (runtime === 'e2b') {
                            const plan = new E2BPathPlan(request);
                            expect(
                                plan.bindings.find(
                                    (asset) =>
                                        asset.hostPath ===
                                        join(
                                            fixture.home,
                                            'sessions',
                                            repository.binding.session_id,
                                            'agent-git'
                                        )
                                )
                            ).toMatchObject({
                                runtimePath: '/workspace/.git',
                                access: 'read-write',
                                kind: 'git',
                            });
                            expect(plan.environment()).toMatchObject({
                                WORKBENCH_REPOSITORY: 'example/project',
                            });
                            expect(plan.environment().GH_TOKEN).toBeUndefined();
                            expect(plan.environment().E2B_API_KEY).toBeUndefined();
                        }
                    } finally {
                        await fixture.preparation.cleanup();
                    }
                });
            }
        }
    }
    for (const runtime of ['local', 'docker', 'e2b']) {
        for (const runner of ['opencode', 'pi']) {
            for (const mode of ['one-shot', 'session'] as const) {
                test(`${runner} on ${runtime} stages and releases ${mode} resources once`, async () => {
                    const fixture = await createFixture({ runtime, runner, mode });
                    const first = fixture.preparation.prepare();
                    expect(fixture.preparation.prepare()).toBe(first);
                    const prepared = await first;
                    expect(prepared.configuration.runner).toBe(runner);
                    expect(prepared.configuration.provider).toBe('openrouter');
                    expect(prepared.authentication).toBeUndefined();
                    expect(fixture.provider.request).toMatchObject({
                        workspaceDirectory: fixture.root,
                        authorizations: { hostDocker: false },
                        purpose: 'run',
                        run: {
                            id: fixture.events.runId,
                            scope: RunStore.scope(fixture.home),
                        },
                        outcome: { home: fixture.home },
                    });
                    expect(fixture.provider.request?.assets).toContainEqual({
                        path: fixture.root,
                        access: 'read-write',
                    });
                    expect(fixture.provider.request?.assets).toContainEqual({
                        path: fixture.workbench.packageDirectory,
                        access: 'read-only',
                    });
                    expect(fixture.provider.request?.assets).toContainEqual({
                        path: join(fixture.root, 'notes'),
                        access: 'read-only',
                        workspace: 'notes',
                    });
                    expect(
                        fixture.provider.request?.assets.some((asset) => asset.state)
                    ).toBe(mode === 'session');
                    expect(Boolean(fixture.provider.request?.credentials)).toBe(
                        runtime === 'e2b'
                    );
                    const outbox = fixture.provider.request?.outcome?.directory;
                    if (!outbox) throw new Error('Missing outbox');
                    await writeFile(join(outbox, 'result.txt'), 'original bytes');
                    const outcome = await fixture.preparation.collect('complete');
                    expect(outcome?.artifacts).toHaveLength(1);
                    await Promise.all([
                        fixture.preparation.cleanup(),
                        fixture.preparation.cleanup(),
                    ]);
                    expect(
                        fixture.calls.filter((call) => call === 'runtime.cleanup')
                    ).toHaveLength(1);
                    expect(
                        fixture.calls.filter((call) => call === 'runner.cleanup')
                    ).toHaveLength(1);
                    expect(await stat(outbox).catch(() => undefined)).toBeUndefined();
                    await expect(fixture.preparation.prepare()).rejects.toThrow(
                        'closed'
                    );
                    if (!outcome?.artifacts[0])
                        throw new Error('Missing retained artifact');
                    const store = new OutcomeStore(fixture.home);
                    try {
                        expect(
                            await readFile(
                                await store.artifactPath(
                                    outcome.id,
                                    outcome.artifacts[0].id
                                ),
                                'utf8'
                            )
                        ).toBe('original bytes');
                    } finally {
                        await store.close();
                    }
                });
            }
        }
    }

    test('does not allocate an outbox when capture is disabled', async () => {
        const fixture = await createFixture({ captureOutcomes: false });
        try {
            await fixture.preparation.prepare();
            expect(fixture.provider.request?.outcome).toBeUndefined();
            expect(await fixture.preparation.collect('complete')).toBeUndefined();
            expect(await fixture.preparation.checkpoint(1)).toBeUndefined();
        } finally {
            await fixture.preparation.cleanup();
        }
    });

    test('retains a failed preparation runtime for partial collection before cleanup', async () => {
        const failure = new Error('preflight failed');
        const fixture = await createFixture({ preflightFailure: failure });
        await expect(fixture.preparation.prepare()).rejects.toThrow('preflight failed');
        const outbox = fixture.provider.request?.outcome?.directory;
        if (!outbox) throw new Error('Missing outbox');
        await writeFile(join(outbox, 'partial.txt'), 'partial result');
        expect(fixture.calls).not.toContain('runtime.cleanup');
        const outcome = await fixture.preparation.collect('partial');
        expect(outcome?.completeness).toBe('partial');
        expect(outcome?.artifacts).toHaveLength(1);
        await fixture.preparation.cleanup();
        expect(fixture.calls).toContain('runner.cleanup');
    });

    test('cleans runner assets when runtime preparation rejects', async () => {
        const fixture = await createFixture({
            runtimeFailure: new Error('runtime failed'),
        });
        await expect(fixture.preparation.prepare()).rejects.toThrow('runtime failed');
        await fixture.preparation.cleanup();
        expect(fixture.calls.filter((call) => call === 'runner.cleanup')).toHaveLength(
            1
        );
        expect(fixture.calls).not.toContain('runtime.cleanup');
        const outbox = fixture.provider.request?.outcome?.directory;
        if (!outbox) throw new Error('Missing outbox');
        expect(await stat(outbox).catch(() => undefined)).toBeUndefined();
    });

    test('attempts every release even when runtime cleanup throws synchronously', async () => {
        const failure = new Error('cleanup failed');
        const fixture = await createFixture({ cleanupFailure: failure });
        await fixture.preparation.prepare();
        const release = fixture.preparation.cleanup();
        expect(fixture.preparation.cleanup()).toBe(release);
        await expect(release).rejects.toThrow('cleanup failed');
        expect(fixture.calls).toContain('runner.cleanup');
        const outbox = fixture.provider.request?.outcome?.directory;
        if (!outbox) throw new Error('Missing outbox');
        expect(await stat(outbox).catch(() => undefined)).toBeUndefined();
    });

    test('cleanup waits for an in-flight preparation and rejects new preparation', async () => {
        const gate = Promise.withResolvers<void>();
        const fixture = await createFixture({ gate: gate.promise });
        const preparing = fixture.preparation.prepare();
        const releasing = fixture.preparation.cleanup();
        await expect(fixture.preparation.prepare()).rejects.toThrow('closed');
        gate.resolve();
        await preparing;
        await releasing;
        expect(fixture.calls.filter((call) => call === 'runtime.cleanup')).toHaveLength(
            1
        );
        expect(fixture.calls.filter((call) => call === 'runner.cleanup')).toHaveLength(
            1
        );
    });

    for (const mode of ['one-shot', 'session'] as const) {
        for (const allowAuthentication of [false, true]) {
            test(`${mode} ${allowAuthentication ? 'allows' : 'disallows'} first-run authentication only with an explicit interactive gate`, async () => {
                const fixture = await createFixture({
                    mode,
                    allowAuthentication,
                    unauthenticated: true,
                });
                await new ConnectionStore(fixture.home).save(
                    ConnectionStore.context(fixture.workbench),
                    {
                        provider: 'openai',
                        nativeProvider: 'openai',
                        authenticationMethod: 'oauth',
                    }
                );
                try {
                    if (mode === 'session' && allowAuthentication) {
                        expect(
                            (await fixture.preparation.prepare()).authentication
                        ).toMatchObject({
                            provider: 'openai',
                            authenticationMethod: 'oauth',
                        });
                    } else {
                        await expect(fixture.preparation.prepare()).rejects.toThrow(
                            mode === 'session'
                                ? 'Authentication is required'
                                : 'No authenticated route'
                        );
                    }
                } finally {
                    await fixture.preparation.cleanup();
                }
            });
        }
    }
});

interface FixtureOptions {
    repository?: boolean;
    delivery?: 'none' | 'pr';
    runtime?: string;
    runner?: string;
    mode?: 'one-shot' | 'session';
    captureOutcomes?: boolean;
    allowAuthentication?: boolean;
    unauthenticated?: boolean;
    preflightFailure?: Error;
    runtimeFailure?: Error;
    cleanupFailure?: Error;
    gate?: Promise<void>;
}

async function createFixture(options: FixtureOptions = {}) {
    const repository = options.repository ? await checkoutFixture() : undefined;
    const root = repository?.root ?? (await mkdtemp(join(tmpdir(), 'preparation-')));
    directories.push(root);
    const home = join(root, 'home');
    const instructionsPath = join(root, 'instructions.md');
    await writeFile(instructionsPath, 'Follow the user task.');
    const workbench: ResolvedWorkbench = {
        manifestPath: join(root, 'workbench.yml'),
        packageDirectory: repository?.source ?? root,
        repositoryDirectory: root,
        instructionsPath,
        skills: [],
        manifest: {
            spec: 0,
            version: '0.1.0',
            name: 'preparation-fixture',
            runner: options.runner ?? 'opencode',
            model: { id: 'openai/gpt-5.6-terra' },
            runtime: options.runtime ?? 'local',
            instructions: './instructions.md',
            skills: [],
            tools: [],
            mcps: [],
            env: {},
        },
    };
    const calls: string[] = [];
    const runner = new TrackingRunner(workbench.manifest.runner, calls);
    const provider = new TrackingRuntime(workbench.manifest.runtime, calls, options);
    const eventsSeen: Array<{ type: string }> = [];
    const events = new RunEvents({
        runId: RunStore.createId(),
        runner: runner.name,
        onEvent: (event) => {
            eventsSeen.push(event);
        },
    });
    if (repository) {
        repository.binding.delivery = options.delivery ?? 'none';
        await new RunStore(home).create({
            id: events.runId,
            metadata: {
                workbench: 'fixture',
                workbench_version: '0.1.0',
                runner: runner.name,
                model: 'openai/gpt-5.6-terra',
                workspace: root,
                repository: repository.binding,
            },
            request: {
                workbench_path: workbench.manifestPath,
                workspace: root,
                task: 'Audit',
                repository: repository.binding,
            },
        });
    }
    const preparation = new ExecutionPreparation(
        {
            workbench,
            home,
            workspaceDirectory: root,
            events,
            mode: options.mode ?? 'one-shot',
            ...(repository ? { repository: repository.binding } : {}),
            workspaces: repository
                ? []
                : [{ name: 'notes', path: join(root, 'notes'), access: 'read-only' }],
            ...(options.mode === 'session'
                ? {
                      session: {
                          id: 'session-fixture',
                          directory: join(root, 'native'),
                      },
                  }
                : {}),
            ...(options.captureOutcomes !== undefined
                ? { captureOutcomes: options.captureOutcomes }
                : {}),
            ...(options.allowAuthentication !== undefined
                ? { allowAuthentication: options.allowAuthentication }
                : {}),
        },
        {
            environment: options.unauthenticated
                ? {}
                : {
                      OPENROUTER_API_KEY: 'fixture-key',
                      GH_TOKEN: 'github-account-credential',
                      GITHUB_TOKEN: 'github-account-credential',
                      SSH_AUTH_SOCK: '/socket',
                      GIT_CONFIG_VALUE_0: 'poisoned',
                  },
            ...(repository
                ? {
                      repositories: (home, binding, environment) =>
                          new RepositoryWorkspace(
                              home,
                              binding,
                              environment,
                              repository.git,
                              fixtureIdentity
                          ),
                  }
                : {}),
            runners: new RunnerRegistry([runner]),
            runtimes: new RuntimeRegistry([provider]),
        }
    );
    return {
        root,
        home,
        workbench,
        calls,
        events,
        eventsSeen,
        provider,
        preparation,
        repository,
    };
}

class TrackingRunner extends Runner {
    readonly session;
    constructor(
        readonly name: string,
        private readonly calls: string[]
    ) {
        super();
        this.session = RunnerRegistry.standard().resolve(name).session;
    }
    async prepare(
        workbench: ResolvedWorkbench,
        environment: Record<string, string | undefined>
    ): Promise<PreparedRunner> {
        const prepared = await RunnerRegistry.standard().prepare(
            workbench,
            environment
        );
        this.calls.push('runner.prepare');
        return {
            name: prepared.name,
            failureLabel: prepared.failureLabel,
            assets: prepared.assets,
            build: (...args) => prepared.build(...args),
            native: (...args) => prepared.native(...args),
            publicInvocation: (...args) => prepared.publicInvocation(...args),
            events: () => prepared.events(),
            startSession: (...args) => prepared.startSession(...args),
            cleanup: async () => {
                this.calls.push('runner.cleanup');
                await prepared.cleanup();
            },
        };
    }
}

class TrackingRuntime implements RuntimeProvider {
    request: RuntimePrepareRequest | undefined;
    constructor(
        readonly name: string,
        private readonly calls: string[],
        private readonly options: FixtureOptions
    ) {}
    async prepare(request: RuntimePrepareRequest): Promise<PreparedRuntime> {
        this.request = request;
        this.calls.push('runtime.prepare');
        await this.options.gate;
        if (this.options.runtimeFailure) throw this.options.runtimeFailure;
        const unused = (): never => {
            throw new Error('Execution is not part of preparation');
        };
        return {
            name: this.name,
            workbench: request.workbench,
            workspaceDirectory: request.workspaceDirectory,
            environment: request.environment,
            workspaces: [],
            nativeAuthentication: 'persistent',
            pathFor: (path) => path,
            preflight: async () => {
                if (this.options.preflightFailure) throw this.options.preflightFailure;
                return {
                    runner: {
                        name: request.workbench.manifest.runner,
                        path: '/bin/runner',
                    },
                    tools: [],
                    enabledMcps: [],
                    disabledMcps: [],
                    optionalEnvironment: [],
                    workspaces: [],
                };
            },
            execute: async () => ({ code: 0, stdout: '', stderr: '' }),
            interact: unused,
            launch: unused,
            launchSession: (invocation) =>
                Bun.spawn(invocation.command, {
                    cwd: invocation.cwd,
                    env: invocation.env,
                    stdin: 'pipe',
                    stdout: 'pipe',
                    stderr: 'pipe',
                }),
            launchService: unused,
            cancel: (process) => process.kill?.(),
            cleanup: () => {
                this.calls.push('runtime.cleanup');
                if (this.options.cleanupFailure) throw this.options.cleanupFailure;
                return Promise.resolve();
            },
        };
    }
}
