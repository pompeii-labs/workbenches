import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunnerRegistry } from '../src/runners/registry.js';
import { type PreparedRunner, Runner } from '../src/runners/runner.js';
import {
    normalizeRunnerInput,
    type RunnerInput,
    type RunnerSession,
    type RunnerSessionAdapter,
    type RunnerSessionStartOptions,
} from '../src/runners/session.js';
import {
    InteractiveRunWorker,
    RunStore,
    type StoredRun,
    StoredRunHandle,
    type WorkbenchEvent,
} from '../src/runs/index.js';
import type { ResolvedWorkbench } from '../src/types.js';
import { supportedRunnerDeclaration } from './runner-adapter-contract.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('interactive run worker', () => {
    test('preserves one session across steering, queued follow-ups, cancellation, and reconnect', async () => {
        const home = await temporaryHome();
        const stored = await fixtureRun(home);
        const adapter = new ControlledAdapter();
        const worker = workerFor(home, stored.id, adapter);
        const execution = worker.execute({
            environment: { OPENAI_API_KEY: 'fixture-openai-key' },
        });
        const firstHandle = new StoredRunHandle(home, stored.id);

        await waitForReady(home, stored.id);
        const first = firstHandle.send('first turn');
        await adapter.waitForPrompts(1);
        await expect(first).resolves.toMatchObject({ disposition: 'delivered' });
        await expect(firstHandle.followUp('second turn')).resolves.toMatchObject({
            disposition: 'queued',
        });
        await expect(firstHandle.followUp('third turn')).resolves.toMatchObject({
            disposition: 'queued',
        });

        const recovered = new StoredRunHandle(home, stored.id);
        await expect(recovered.steer('change direction')).resolves.toMatchObject({
            disposition: 'delivered',
        });
        await expect(recovered.cancelTurn()).resolves.toMatchObject({
            disposition: 'cancelled',
        });
        await adapter.waitForPrompts(3);
        await expect(recovered.close()).resolves.toMatchObject({
            disposition: 'closed',
        });

        await expect(execution).resolves.toBe(0);
        await expect(firstHandle.result).resolves.toEqual({
            runId: stored.id,
            status: 'completed',
        });
        expect(adapter.prompts).toEqual(['first turn', 'second turn', 'third turn']);
        expect(adapter.steers).toEqual(['change direction']);
        expect(adapter.cancellations).toBe(1);
        expect(adapter.starts).toBe(1);

        const events = await collect(recovered.events);
        expect(events.map((event) => event.sequence)).toEqual(
            events.map((_, index) => index + 1)
        );
        expect(events.filter((event) => event.type === 'input.queued')).toHaveLength(2);
        expect(
            events.filter(
                (event) =>
                    event.type === 'input.delivered' &&
                    field(event.data, 'kind') === 'follow_up'
            )
        ).toHaveLength(2);
        expect(eventIndex(events, 'input.delivered', 'cancel_turn')).toBeLessThan(
            eventIndex(events, 'input.delivered', 'follow_up')
        );
        expect((await new RunStore(home).read(stored.id)).runner_session_id).toBe(
            'native-session-1'
        );
        expect(await storedControlText(home, stored.id)).not.toContain('first turn');
        expect(await storedControlText(home, stored.id)).not.toContain('second turn');
        expect(await storedControlText(home, stored.id)).not.toContain(
            'change direction'
        );
    });

    test('rejects steering while idle with a normalized rejection event', async () => {
        const home = await temporaryHome();
        const stored = await fixtureRun(home);
        const adapter = new ControlledAdapter();
        const execution = workerFor(home, stored.id, adapter).execute({
            environment: { OPENAI_API_KEY: 'fixture-openai-key' },
        });
        const handle = new StoredRunHandle(home, stored.id);
        await waitForReady(home, stored.id);

        await expect(handle.steer('too early')).rejects.toThrow(
            'No Workbench turn is active'
        );
        await handle.close();
        await execution;
        await expect(handle.result).resolves.toMatchObject({ status: 'completed' });

        expect(await collect(handle.events)).toContainEqual(
            expect.objectContaining({
                type: 'input.rejected',
                data: expect.objectContaining({
                    kind: 'steer',
                    code: 'turn_idle',
                }),
            })
        );
    });

    test('treats repeated turn cancellation as idempotent once idle', async () => {
        const home = await temporaryHome();
        const stored = await fixtureRun(home);
        const adapter = new ControlledAdapter();
        const execution = workerFor(home, stored.id, adapter).execute({
            environment: { OPENAI_API_KEY: 'fixture-openai-key' },
        });
        const handle = new StoredRunHandle(home, stored.id);
        await waitForReady(home, stored.id);

        await expect(handle.cancelTurn()).resolves.toMatchObject({
            disposition: 'already_idle',
        });
        await handle.close();
        await execution;
        await expect(handle.result).resolves.toMatchObject({ status: 'completed' });

        expect(await collect(handle.events)).not.toContainEqual(
            expect.objectContaining({
                type: 'input.rejected',
                data: expect.objectContaining({
                    kind: 'cancel_turn',
                    code: 'turn_idle',
                }),
            })
        );
    });

    test('routes permission decisions through the durable control channel', async () => {
        const home = await temporaryHome();
        const stored = await fixtureRun(home);
        const adapter = new ControlledAdapter({ requestPermission: true });
        const execution = workerFor(home, stored.id, adapter).execute({
            environment: { OPENAI_API_KEY: 'fixture-openai-key' },
        });
        const handle = new StoredRunHandle(home, stored.id);
        await waitForReady(home, stored.id);

        const turn = handle.send('inspect outside');
        await adapter.permissionRequested;
        await expect(
            handle.respondToPermission('permission-1', 'allow_once')
        ).resolves.toMatchObject({ disposition: 'delivered' });
        await turn;
        await adapter.waitForPrompts(1);
        await handle.close();
        await execution;
        await expect(handle.result).resolves.toMatchObject({ status: 'completed' });

        expect(adapter.permissionDecisions).toEqual(['allow_once']);
        expect(await collect(handle.events)).toContainEqual(
            expect.objectContaining({
                type: 'input.requested',
                data: expect.objectContaining({ id: 'permission-1' }),
            })
        );
    });

    test('records a normalized terminal event when startup fails', async () => {
        const home = await temporaryHome();
        const stored = await fixtureRun(home);
        const worker = new InteractiveRunWorker(home, stored.id, {
            loadWorkbench: async () => {
                throw new Error('fixture load failed');
            },
        });

        await expect(worker.execute({})).resolves.toBe(1);
        await expect(new StoredRunHandle(home, stored.id).result).resolves.toEqual({
            runId: stored.id,
            status: 'failed',
        });
        expect(await new RunStore(home).readEvents(stored.id)).toEqual([
            expect.objectContaining({
                run_id: stored.id,
                sequence: 1,
                type: 'run.failed',
                data: { message: 'fixture load failed' },
            }),
        ]);
    });

    test('rejects a normal send during an active turn without degrading it', async () => {
        const home = await temporaryHome();
        const stored = await fixtureRun(home);
        const adapter = new ControlledAdapter();
        const execution = workerFor(home, stored.id, adapter).execute({
            environment: { OPENAI_API_KEY: 'fixture-openai-key' },
        });
        const handle = new StoredRunHandle(home, stored.id);
        await waitForReady(home, stored.id);

        await handle.send('first turn');
        await adapter.waitForPrompts(1);
        await expect(handle.send('must not become a follow-up')).rejects.toThrow(
            'Workbench is still responding'
        );
        await handle.cancelTurn();
        await handle.close();
        await execution;
        await expect(handle.result).resolves.toMatchObject({ status: 'completed' });

        expect(adapter.prompts).toEqual(['first turn']);
        expect(await new RunStore(home).readEvents(stored.id)).toContainEqual(
            expect.objectContaining({
                type: 'input.rejected',
                data: expect.objectContaining({ kind: 'send', code: 'turn_active' }),
            })
        );
    });

    test('rejects queued follow-ups before closing an active run', async () => {
        const home = await temporaryHome();
        const stored = await fixtureRun(home);
        const adapter = new ControlledAdapter();
        const execution = workerFor(home, stored.id, adapter).execute({
            environment: { OPENAI_API_KEY: 'fixture-openai-key' },
        });
        const handle = new StoredRunHandle(home, stored.id);
        await waitForReady(home, stored.id);

        await handle.send('first turn');
        await adapter.waitForPrompts(1);
        await handle.followUp('do not deliver');
        await handle.close();
        await execution;
        await expect(handle.result).resolves.toMatchObject({ status: 'completed' });

        const events = await new RunStore(home).readEvents(stored.id);
        expect(adapter.prompts).toEqual(['first turn']);
        expect(events).toContainEqual(
            expect.objectContaining({
                type: 'input.rejected',
                data: expect.objectContaining({
                    kind: 'follow_up',
                    code: 'run_terminal',
                }),
            })
        );
        expect(events.at(-1)?.type).toBe('run.completed');
    });

    test('cancels the durable run instead of completing it', async () => {
        const home = await temporaryHome();
        const stored = await fixtureRun(home);
        const adapter = new ControlledAdapter();
        const execution = workerFor(home, stored.id, adapter).execute({
            environment: { OPENAI_API_KEY: 'fixture-openai-key' },
        });
        const handle = new StoredRunHandle(home, stored.id);
        await waitForReady(home, stored.id);

        await expect(handle.cancel('client left')).resolves.toMatchObject({
            disposition: 'cancelled',
        });
        await expect(execution).resolves.toBe(130);
        await expect(handle.result).resolves.toEqual({
            runId: stored.id,
            status: 'cancelled',
        });
        expect((await new RunStore(home).readEvents(stored.id)).at(-1)).toMatchObject({
            type: 'run.cancelled',
            data: { reason: 'client left' },
        });
    });

    test('delivers an immediate cancel after its preceding send', async () => {
        const home = await temporaryHome();
        const stored = await fixtureRun(home);
        const adapter = new ControlledAdapter();
        const execution = workerFor(home, stored.id, adapter).execute({
            environment: { OPENAI_API_KEY: 'fixture-openai-key' },
        });
        const handle = new StoredRunHandle(home, stored.id);
        await waitForReady(home, stored.id);

        const sent = handle.send('cancel immediately');
        const cancelled = handle.cancelTurn();
        await expect(Promise.all([sent, cancelled])).resolves.toEqual([
            expect.objectContaining({ disposition: 'delivered' }),
            expect.objectContaining({ disposition: 'cancelled' }),
        ]);
        await handle.send('still responsive');
        await adapter.waitForPrompts(2);
        await handle.close();
        await execution;
        await expect(handle.result).resolves.toMatchObject({ status: 'completed' });

        expect(adapter.prompts).toEqual(['cancel immediately', 'still responsive']);
        expect(adapter.cancellations).toBe(1);
    });
});

class ControlledAdapter implements RunnerSessionAdapter {
    readonly runner = 'opencode';
    readonly declaration = supportedRunnerDeclaration('opencode');
    readonly prompts: string[] = [];
    readonly steers: string[] = [];
    readonly permissionDecisions: string[] = [];
    cancellations = 0;
    starts = 0;
    private host?: RunnerSessionStartOptions['host'];
    private releaseFirst?: () => void;
    private readonly promptWaiters: Array<() => void> = [];
    private readonly markPermissionRequested: () => void;
    readonly permissionRequested: Promise<void>;

    constructor(private readonly options: { requestPermission?: boolean } = {}) {
        let markPermissionRequested!: () => void;
        this.permissionRequested = new Promise((resolve) => {
            markPermissionRequested = resolve;
        });
        this.markPermissionRequested = markPermissionRequested;
    }

    async start(options: RunnerSessionStartOptions): Promise<RunnerSession> {
        this.starts += 1;
        this.host = options.host;
        return {
            id: 'native-session-1',
            prompt: (input) => this.prompt(input),
            steer: (input) => this.steer(input),
            cancelTurn: () => this.cancelTurn(),
            close: async () => {},
        };
    }

    async waitForPrompts(count: number): Promise<void> {
        while (this.prompts.length < count) {
            await new Promise<void>((resolve) => this.promptWaiters.push(resolve));
        }
    }

    private async prompt(input: RunnerInput) {
        this.prompts.push(normalizeRunnerInput(input).text);
        for (const resolve of this.promptWaiters.splice(0)) resolve();
        if (this.prompts.length === 1) {
            if (this.options.requestPermission) {
                this.markPermissionRequested();
                const decision = await this.host?.requestPermission({
                    id: 'permission-1',
                    action: 'external_directory',
                    resources: ['/outside/*'],
                    message: 'Allow external directory for /outside/*?',
                    allowAlways: true,
                });
                if (decision) this.permissionDecisions.push(decision);
            } else {
                await new Promise<void>((resolve) => {
                    this.releaseFirst = resolve;
                });
            }
        }
        await this.host?.emit({ type: 'output.text', data: { text: 'done' } });
        return { reason: 'stop' };
    }

    private async steer(input: RunnerInput): Promise<void> {
        this.steers.push(normalizeRunnerInput(input).text);
    }

    private async cancelTurn(): Promise<void> {
        this.cancellations += 1;
        this.releaseFirst?.();
    }
}

class InteractiveWorkerTestRunner extends Runner {
    readonly name = 'opencode';

    constructor(readonly session: RunnerSessionAdapter) {
        super();
    }

    prepare(
        workbench: ResolvedWorkbench,
        environment: Record<string, string | undefined>
    ): Promise<PreparedRunner> {
        return RunnerRegistry.standard()
            .resolve(this.name)
            .prepare(workbench, environment);
    }
}

function workerFor(home: string, runId: string, adapter: RunnerSessionAdapter) {
    return new InteractiveRunWorker(home, runId, {
        loadWorkbench: async () => workbench(),
        findExecutable: (name) => `/bin/${name}`,
        registry: new RunnerRegistry([new InteractiveWorkerTestRunner(adapter)]),
        now: () => new Date('2026-09-01T12:00:00.000Z'),
    });
}

async function temporaryHome(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-interactive-worker-'));
    temporaryDirectories.push(directory);
    return directory;
}

function fixtureRun(home: string): Promise<StoredRun> {
    return new RunStore(home).create({
        metadata: {
            workbench: 'fixture-core',
            workbench_version: '0.1.0',
            runner: 'opencode',
            model: 'openai/gpt-5.6-terra',
            workspace: '/workspace',
            mode: 'interactive',
        },
        request: {
            workbench_path: '/repo/.workbenches/core',
            workspace: '/workspace',
            task: '',
        },
    });
}

function workbench(): ResolvedWorkbench {
    return {
        manifestPath: '/repo/.workbenches/core/workbench.yml',
        packageDirectory: '/repo/.workbenches/core',
        repositoryDirectory: '/repo',
        instructionsPath: '/repo/.workbenches/core/instructions.md',
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
    };
}

async function waitForReady(home: string, runId: string): Promise<void> {
    const store = new RunStore(home);
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const run = await store.read(runId);
        if (run.runner_session_id) return;
        if (RunStore.isTerminal(run.status)) {
            const events = await Bun.file(
                join(home, 'runs', runId, 'events.ndjson')
            ).text();
            throw new Error(`Interactive run became ${run.status}: ${events}`);
        }
        await Bun.sleep(2);
    }
    throw new Error('Timed out waiting for interactive run');
}

async function collect(events: AsyncIterable<WorkbenchEvent>) {
    const collected: WorkbenchEvent[] = [];
    for await (const event of events) collected.push(event);
    return collected;
}

async function storedControlText(home: string, runId: string): Promise<string> {
    const root = join(home, 'runs', runId, 'control');
    const contents: string[] = [];
    for (const directory of ['pending', 'active', 'receipts']) {
        for (const file of await readdir(join(root, directory))) {
            contents.push(await readFile(join(root, directory, file), 'utf8'));
        }
    }
    return contents.join('\n');
}

function field(value: unknown, key: string): string | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === 'string' ? candidate : undefined;
}

function eventIndex(
    events: WorkbenchEvent[],
    type: WorkbenchEvent['type'],
    kind: string
): number {
    return events.findIndex(
        (event) => event.type === type && field(event.data, 'kind') === kind
    );
}
