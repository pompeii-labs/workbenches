import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectionStore } from '../../src/connections/store.js';
import { OutcomeStore } from '../../src/outcomes/store.js';
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
import { RuntimeRegistry } from '../../src/runtimes/registry.js';
import type { ResolvedWorkbench } from '../../src/types.js';

const directories: string[] = [];
afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
});

describe('shared execution preparation', () => {
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
    const root = await mkdtemp(join(tmpdir(), 'preparation-'));
    directories.push(root);
    const home = join(root, 'home');
    const instructionsPath = join(root, 'instructions.md');
    await writeFile(instructionsPath, 'Follow the user task.');
    const workbench: ResolvedWorkbench = {
        manifestPath: join(root, 'workbench.yml'),
        packageDirectory: root,
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
    const events = new RunEvents({ runId: RunStore.createId(), runner: runner.name });
    const preparation = new ExecutionPreparation(
        {
            workbench,
            home,
            workspaceDirectory: root,
            events,
            mode: options.mode ?? 'one-shot',
            workspaces: [
                { name: 'notes', path: join(root, 'notes'), access: 'read-only' },
            ],
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
                : { OPENROUTER_API_KEY: 'fixture-key' },
            runners: new RunnerRegistry([runner]),
            runtimes: new RuntimeRegistry([provider]),
        }
    );
    return { root, home, workbench, calls, events, provider, preparation };
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
            launchSession: unused,
            launchService: unused,
            cancel: unused,
            cleanup: () => {
                this.calls.push('runtime.cleanup');
                if (this.options.cleanupFailure) throw this.options.cleanupFailure;
                return Promise.resolve();
            },
        };
    }
}
