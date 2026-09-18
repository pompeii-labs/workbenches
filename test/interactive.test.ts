import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutcomeStore } from '../src/outcomes/store.js';
import { RunnerRegistry } from '../src/runners/registry.js';
import { type PreparedRunner, Runner } from '../src/runners/runner.js';
import {
    normalizeRunnerInput,
    type RunnerInput,
    type RunnerSession,
    type RunnerSessionAdapter,
    type RunnerSessionStartOptions,
} from '../src/runners/session.js';
import { InteractiveRun, type WorkbenchEvent } from '../src/runs/index.js';
import type {
    PreparedRuntime,
    RuntimePrepareRequest,
    RuntimeProvider,
} from '../src/runtimes/contracts.js';
import { RuntimeRegistry } from '../src/runtimes/index.js';
import type { ResolvedWorkbench, SpawnedRunner } from '../src/types.js';
import type { ResolvedWorkbenchReference } from '../src/workbench/index.js';
import { supportedRunnerDeclaration } from './runner-adapter-contract.js';

const instructionDirectory = await mkdtemp(join(tmpdir(), 'interactive-instructions-'));
const instructionsPath = join(instructionDirectory, 'instructions.md');
await writeFile(instructionsPath, 'Follow the user task.\n');
afterAll(() => rm(instructionDirectory, { recursive: true, force: true }));

describe('runner-neutral interactive host', () => {
    test('collects partial runtime results after failed preflight and preserves the startup error', async () => {
        const home = await mkdtemp(join(tmpdir(), 'interactive-startup-'));
        const adapter = new FakeAdapter();
        const provider = new CapturingRuntimeProvider({
            preflightFailure: new Error('startup failed'),
            cleanupFailure: new Error('release failed'),
        });
        const resolved = reference();
        resolved.workbench.manifest.runtime = 'docker';
        const events: WorkbenchEvent[] = [];
        try {
            await expect(
                InteractiveRun.start({
                    home,
                    resolved,
                    onEvent: (event) => void events.push(event),
                    dependencies: {
                        ...dependencies(adapter),
                        runtimeRegistry: new RuntimeRegistry([provider]),
                    },
                })
            ).rejects.toThrow('startup failed');
            expect(provider.collectionCount).toBe(1);
            expect(provider.cleanupCount).toBe(1);
            expect(adapter.startOptions).toBeUndefined();
            expect(events.at(-1)).toMatchObject({
                type: 'run.failed',
                data: { message: 'startup failed' },
            });
            const store = new OutcomeStore(home);
            try {
                const outcome = await store.findFinalByRun(events[0]?.run_id ?? '');
                expect(outcome).toMatchObject({
                    completeness: 'partial',
                    summary: 'Startup diagnostics',
                });
            } finally {
                await store.close();
            }
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });
    test('saves results before each turn completes and keeps the session alive after a collection error', async () => {
        const home = await mkdtemp(join(tmpdir(), 'workbench-live-interactive-'));
        const events: WorkbenchEvent[] = [];
        const adapter = new FakeAdapter();
        const session = await InteractiveRun.start({
            home,
            resolved: { ...reference(), workspaceDirectory: instructionDirectory },
            onEvent: (event) => void events.push(event),
            dependencies: dependencies(adapter),
        });
        const store = new OutcomeStore(home);
        const outbox = adapter.startOptions?.environment.WORKBENCH_OUTPUT_DIR;
        if (!outbox) throw new Error('Missing interactive outbox');
        try {
            await writeFile(join(outbox, 'report.txt'), 'first');
            await session.send('first', 'input-first');
            const first = events.find((event) => event.type === 'outcome.available');
            expect(first?.data).toMatchObject({
                turn_index: 1,
                artifacts: 1,
                application_state: 'present',
            });
            expect(
                events.findIndex((event) => event.type === 'outcome.available')
            ).toBeLessThan(
                events.findIndex((event) => event.type === 'turn.completed')
            );
            expect(adapter.closes).toBe(0);
            expect(session.busy).toBeFalse();
            await writeFile(join(outbox, 'outcome.json'), '{');
            await session.send('second');
            expect(
                events.find((event) => event.type === 'outcome.failed')?.data
            ).toMatchObject({ turn_index: 2 });
            expect(events.some((event) => event.type === 'run.failed')).toBeFalse();
            expect(adapter.closes).toBe(0);
            await writeFile(join(outbox, 'outcome.json'), '{"version":1}');
            await writeFile(join(outbox, 'report.txt'), 'revised');
            await session.send('third');
            expect(
                events.filter((event) => event.type === 'outcome.available')
            ).toHaveLength(2);
            const snapshots = await store.listByRun(session.runId);
            expect(snapshots.map((outcome) => outcome.turn_index)).toEqual([3, 1]);
            await session.close();
            expect((await store.findFinalByRun(session.runId))?.completeness).toBe(
                'complete'
            );
        } finally {
            await session.close().catch(() => {});
            await rm(home, { recursive: true, force: true });
        }
    });

    test('does not publish an interrupted turn as finished results', async () => {
        const home = await mkdtemp(join(tmpdir(), 'workbench-live-cancel-'));
        const events: WorkbenchEvent[] = [];
        const adapter = new FakeAdapter({ waitForCancellation: true });
        const session = await InteractiveRun.start({
            home,
            resolved: { ...reference(), workspaceDirectory: instructionDirectory },
            onEvent: (event) => void events.push(event),
            dependencies: dependencies(adapter),
        });
        try {
            const outbox = adapter.startOptions?.environment.WORKBENCH_OUTPUT_DIR;
            if (!outbox) throw new Error('Missing outbox');
            await writeFile(join(outbox, 'unfinished.txt'), 'unfinished');
            const turn = session.send('wait');
            await adapter.started;
            await session.cancelTurn();
            await turn;
            expect(
                events.some((event) => event.type === 'outcome.available')
            ).toBeFalse();
            expect(session.busy).toBeFalse();
            expect(adapter.closes).toBe(0);
        } finally {
            await session.cancel();
            await rm(home, { recursive: true, force: true });
        }
    });
    test('normalizes runner permission requests and returns the host decision', async () => {
        const events: WorkbenchEvent[] = [];
        const decisions: string[] = [];
        const adapter = new FakeAdapter({ requestPermission: true });
        const session = await InteractiveRun.start({
            resolved: reference(),
            onEvent: (event) => void events.push(event),
            onPermission: async (request) => {
                expect(request.action).toBe('external_directory');
                return 'allow_once' as const;
            },
            dependencies: dependencies(adapter),
        });

        await session.send('inspect');
        decisions.push(...adapter.permissionDecisions);
        await session.close();

        expect(decisions).toEqual(['allow_once']);
        expect(events.find((event) => event.type === 'input.requested')).toMatchObject({
            data: {
                id: 'permission-1',
                kind: 'permission',
                action: 'external_directory',
                resources: ['/outside/*'],
                options: ['allow_once', 'allow_always', 'reject'],
            },
        });
    });

    test('rejects a permission safely when no interactive handler exists', async () => {
        const adapter = new FakeAdapter({ requestPermission: true });
        const session = await InteractiveRun.start({
            resolved: reference(),
            onEvent: () => {},
            dependencies: dependencies(adapter),
        });

        await session.send('inspect');
        await session.close();
        expect(adapter.permissionDecisions).toEqual(['reject']);
    });

    test('normalizes runner questions without persisting answer text', async () => {
        const events: WorkbenchEvent[] = [];
        const adapter = new FakeAdapter({ requestQuestion: true });
        const session = await InteractiveRun.start({
            resolved: reference(),
            onEvent: (event) => void events.push(event),
            onQuestion: async () => ({
                outcome: 'answered',
                answers: [['private answer']],
            }),
            dependencies: dependencies(adapter),
        });

        await session.send('inspect');
        await session.close();

        expect(adapter.questionResponses).toEqual([
            { outcome: 'answered', answers: [['private answer']] },
        ]);
        expect(events).toContainEqual(
            expect.objectContaining({
                type: 'question.requested',
                data: expect.objectContaining({
                    id: 'question-1',
                    questions: [
                        expect.objectContaining({
                            question: 'Which environment?',
                        }),
                    ],
                }),
            })
        );
        expect(events).toContainEqual(
            expect.objectContaining({
                type: 'question.answered',
                data: { id: 'question-1', answer_count: 1 },
            })
        );
        expect(JSON.stringify(events)).not.toContain('private answer');
    });

    test('owns Workbench lifecycle while an adapter owns native transport', async () => {
        const events: WorkbenchEvent[] = [];
        const adapter = new FakeAdapter();
        const session = await InteractiveRun.start({
            resolved: reference(),
            onEvent: (event) => {
                events.push(event);
            },
            dependencies: dependencies(adapter),
        });

        await session.send('  first turn  ');
        expect(session.runnerSessionId).toBe('native-session-1');
        await session.close();

        expect(adapter.prompts).toEqual(['first turn']);
        expect(events.map((event) => event.type)).toEqual([
            'run.started',
            'run.ready',
            'turn.started',
            'output.text',
            'turn.completed',
            'run.completed',
        ]);
        expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
        expect(events[4]?.data).toEqual({ index: 1, reason: 'stop' });
    });

    test('normalizes turn cancellation without terminating the session', async () => {
        const events: WorkbenchEvent[] = [];
        const adapter = new FakeAdapter({ waitForCancellation: true });
        const session = await InteractiveRun.start({
            resolved: reference(),
            onEvent: (event) => {
                events.push(event);
            },
            dependencies: dependencies(adapter),
        });

        const turn = session.send('long turn');
        await adapter.started;
        await session.cancelTurn();
        await turn;
        await session.send('next turn');
        await session.close();

        expect(adapter.cancellations).toBe(1);
        expect(events.filter((event) => event.type === 'turn.completed')).toEqual([
            expect.objectContaining({ data: { index: 1, reason: 'cancelled' } }),
            expect.objectContaining({ data: { index: 2, reason: 'stop' } }),
        ]);
        expect(events.at(-1)?.type).toBe('run.completed');
    });

    test('turn failures terminate the Workbench run truthfully', async () => {
        const events: WorkbenchEvent[] = [];
        const adapter = new FakeAdapter({
            failure: new Error('native transport failed'),
        });
        const session = await InteractiveRun.start({
            resolved: reference(),
            onEvent: (event) => {
                events.push(event);
            },
            dependencies: dependencies(adapter),
        });

        await expect(session.send('fail')).rejects.toThrow('native transport failed');
        await expect(session.send('too late')).rejects.toThrow('session is closed');
        expect(events.at(-1)).toMatchObject({
            type: 'run.failed',
            data: { message: 'native transport failed' },
        });
        expect(adapter.closes).toBe(1);
    });

    test('close failures terminate the Workbench run truthfully', async () => {
        const events: WorkbenchEvent[] = [];
        const adapter = new FakeAdapter({
            closeFailure: new Error('native cleanup failed'),
        });
        const session = await InteractiveRun.start({
            resolved: reference(),
            onEvent: (event) => {
                events.push(event);
            },
            dependencies: dependencies(adapter),
        });

        await expect(session.close()).rejects.toThrow('native cleanup failed');
        expect(events.at(-1)).toMatchObject({
            type: 'run.failed',
            data: { message: 'native cleanup failed' },
        });
        expect(adapter.closes).toBe(1);
    });

    test('keeps the declared runtime alive for the native session lifecycle', async () => {
        const events: WorkbenchEvent[] = [];
        const adapter = new FakeAdapter();
        const provider = new CapturingRuntimeProvider();
        const resolved = reference();
        resolved.workbench.manifest.runtime = 'docker';
        resolved.workbench.manifest.image = 'ghcr.io/example/session:1.0.0';
        const nativeDirectory = '/host/session/native';

        const session = await InteractiveRun.start({
            resolved,
            session: { id: 'wb_runtime_lifecycle', directory: nativeDirectory },
            allowHostDocker: true,
            onEvent: (event) => void events.push(event),
            dependencies: {
                ...dependencies(adapter),
                runtimeRegistry: new RuntimeRegistry([provider]),
            },
        });

        expect(provider.request?.authorizations).toEqual({ hostDocker: true });
        expect(provider.request?.purpose).toBe('run');
        expect(provider.request?.assets).toContainEqual({
            path: nativeDirectory,
            access: 'read-write',
            state: true,
        });
        expect(adapter.startOptions?.session).toEqual({
            id: 'wb_runtime_lifecycle',
            directory: `/runtime${nativeDirectory}`,
        });
        expect(provider.cleanupCount).toBe(0);

        await session.close();
        expect(provider.cleanupCount).toBe(1);
        expect(provider.infrastructureCount).toBe(1);
        expect(events.at(-1)).toMatchObject({
            type: 'run.completed',
            data: {
                infrastructure: {
                    provider: 'docker',
                    duration_ms: 2_500,
                    cost: { kind: 'unavailable', currency: 'USD' },
                },
            },
        });
    });
});

class FakeAdapter implements RunnerSessionAdapter {
    readonly runner = 'opencode';
    readonly declaration = supportedRunnerDeclaration('opencode');
    readonly prompts: string[] = [];
    cancellations = 0;
    closes = 0;
    readonly permissionDecisions: string[] = [];
    readonly questionResponses: unknown[] = [];
    startOptions: RunnerSessionStartOptions | undefined;
    private host?: RunnerSessionStartOptions['host'];
    private release?: () => void;
    private readonly markStarted: () => void;
    readonly started: Promise<void>;
    private readonly options: {
        waitForCancellation?: boolean;
        failure?: Error;
        closeFailure?: Error;
        requestPermission?: boolean;
        requestQuestion?: boolean;
    };

    constructor(
        options: {
            waitForCancellation?: boolean;
            failure?: Error;
            closeFailure?: Error;
            requestPermission?: boolean;
            requestQuestion?: boolean;
        } = {}
    ) {
        this.options = options;
        let markStarted!: () => void;
        this.started = new Promise((resolve) => {
            markStarted = resolve;
        });
        this.markStarted = markStarted;
    }

    async start(options: RunnerSessionStartOptions): Promise<RunnerSession> {
        this.startOptions = options;
        this.host = options.host;
        return {
            id: 'native-session-1',
            prompt: (input) => this.prompt(input),
            cancelTurn: () => this.cancelTurn(),
            close: () => this.close(),
        };
    }

    private async prompt(input: RunnerInput) {
        this.prompts.push(normalizeRunnerInput(input).text);
        this.markStarted();
        if (this.options.failure) throw this.options.failure;
        if (this.options.waitForCancellation && this.prompts.length === 1) {
            await new Promise<void>((resolve) => {
                this.release = resolve;
            });
        }
        if (this.options.requestPermission) {
            const decision = await this.host?.requestPermission({
                id: 'permission-1',
                action: 'external_directory',
                resources: ['/outside/*'],
                message: 'Allow external directory for /outside/*?',
                allowAlways: true,
            });
            if (decision) this.permissionDecisions.push(decision);
        }
        if (this.options.requestQuestion) {
            const response = await this.host?.requestQuestion({
                id: 'question-1',
                questions: [
                    {
                        question: 'Which environment?',
                        options: [{ label: 'Production' }, { label: 'Staging' }],
                        multiple: false,
                        custom: true,
                    },
                ],
            });
            if (response) this.questionResponses.push(response);
        }
        await this.host?.emit({ type: 'output.text', data: { text: 'done' } });
        return { reason: 'stop' };
    }

    private async cancelTurn() {
        this.cancellations += 1;
        this.release?.();
    }

    private async close() {
        this.closes += 1;
        if (this.options.closeFailure) throw this.options.closeFailure;
    }
}

class CapturingRuntimeProvider implements RuntimeProvider {
    readonly name = 'docker';
    request: RuntimePrepareRequest | undefined;
    cleanupCount = 0;
    infrastructureCount = 0;
    collectionCount = 0;

    constructor(
        private readonly options: {
            preflightFailure?: Error;
            cleanupFailure?: Error;
        } = {}
    ) {}

    async prepare(request: RuntimePrepareRequest): Promise<PreparedRuntime> {
        this.request = request;
        const runtimeWorkbench = structuredClone(request.workbench);
        return {
            name: this.name,
            nativeAuthentication: 'persistent',
            workbench: runtimeWorkbench,
            workspaceDirectory: '/runtime/workspace',
            environment: request.environment,
            workspaces: [],
            preparation: {
                kind: 'image',
                reference: 'ghcr.io/example/session:1.0.0',
                immutableReference: 'ghcr.io/example/session@sha256:fixture',
                action: 'cache-hit',
            },
            pathFor: (path) => `/runtime${path}`,
            preflight: async () => {
                if (this.options.preflightFailure) throw this.options.preflightFailure;
                return {
                    runner: { name: 'opencode', path: '/usr/bin/opencode' },
                    tools: [],
                    enabledMcps: [],
                    disabledMcps: [],
                    optionalEnvironment: [],
                    workspaces: [],
                };
            },
            execute: async () => ({ code: 0, stdout: '', stderr: '' }),
            interact: async () => 0,
            launch: () => CapturingRuntimeProvider.process(),
            launchSession: () => CapturingRuntimeProvider.process(),
            launchService: () => ({
                process: CapturingRuntimeProvider.process(),
                resolveUrl: async (url) => url,
            }),
            cancel: () => {},
            collectOutcome: async () => {
                expect(this.cleanupCount).toBe(0);
                this.collectionCount += 1;
                return {
                    application_state: 'present',
                    summary: 'Startup diagnostics',
                    artifacts: [],
                    links: [],
                    changesets: [],
                    warnings: [],
                };
            },
            infrastructure: async () => {
                this.infrastructureCount += 1;
                return {
                    provider: 'docker',
                    duration_ms: 2_500,
                    cost: { kind: 'unavailable', currency: 'USD' },
                };
            },
            cleanup: async () => {
                this.cleanupCount += 1;
                if (this.options.cleanupFailure) throw this.options.cleanupFailure;
            },
        };
    }

    private static process(): SpawnedRunner {
        return { exited: Promise.resolve(0), kill() {} };
    }
}

function dependencies(adapter: RunnerSessionAdapter) {
    return {
        env: { OPENROUTER_API_KEY: 'fixture-openrouter-key' },
        findExecutable: (name: string) => `/bin/${name}`,
        registry: new RunnerRegistry([new InteractiveTestRunner(adapter)]),
        now: () => new Date('2026-08-18T12:00:00.000Z'),
    };
}

class InteractiveTestRunner extends Runner {
    readonly name = 'opencode';
    readonly session: RunnerSessionAdapter;

    constructor(session: RunnerSessionAdapter) {
        super();
        this.session = session;
    }

    async prepare(
        workbench: ResolvedWorkbench,
        environment: Record<string, string | undefined>
    ): Promise<PreparedRunner> {
        const prepared = await RunnerRegistry.standard()
            .resolve(this.name)
            .prepare(workbench, environment);
        return {
            name: prepared.name,
            failureLabel: prepared.failureLabel,
            assets: prepared.assets,
            build: (...args) => prepared.build(...args),
            native: (...args) => prepared.native(...args),
            publicInvocation: (...args) => prepared.publicInvocation(...args),
            events: () => prepared.events(),
            startSession: (runtime, options) =>
                this.session.start({
                    workbench: runtime.workbench,
                    workspaceDirectory: runtime.workspaceDirectory,
                    environment: runtime.environment,
                    configuration: options.configuration,
                    host: options.host,
                    ...(options.session ? { session: options.session } : {}),
                }),
            cleanup: () => prepared.cleanup(),
        };
    }
}

function reference(): ResolvedWorkbenchReference {
    return {
        workspaceDirectory: '/workspace',
        cleanup: async () => {},
        workbench: {
            manifestPath: '/repo/.workbenches/core/workbench.yml',
            packageDirectory: '/repo/.workbenches/core',
            repositoryDirectory: '/repo',
            instructionsPath,
            skills: [],
            manifest: {
                spec: 0,
                version: '0.1.0',
                name: 'fixture-core',
                runner: 'opencode',
                model: { id: 'openai/gpt-5.6-terra' },
                instructions: './instructions.md',
                skills: [],
                tools: [],
                mcps: [],
                env: {},
                runtime: 'local',
            },
        },
    };
}
