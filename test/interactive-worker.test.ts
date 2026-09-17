import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConnectionStore } from '../src/connections/store.js';
import { RunnerRegistry } from '../src/runners/registry.js';
import { type PreparedRunner, Runner } from '../src/runners/runner.js';
import {
    normalizeRunnerInput,
    type RunnerInput,
    type RunnerQuestionResponse,
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
import { LocalRuntimeProvider, RuntimeRegistry } from '../src/runtimes/index.js';
import { SessionStore } from '../src/sessions/index.js';
import type { ResolvedWorkbench } from '../src/types.js';
import { supportedRunnerDeclaration } from './runner-adapter-contract.js';

const temporaryDirectories: string[] = [];
const instructionDirectory = await mkdtemp(join(tmpdir(), 'worker-instructions-'));
const instructionsPath = join(instructionDirectory, 'instructions.md');
await writeFile(instructionsPath, 'Follow the user task.\n');
afterAll(() => rm(instructionDirectory, { recursive: true, force: true }));

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('interactive run worker', () => {
    test('passes a configured unauthenticated connection into a foreground runner session', async () => {
        const home = await temporaryHome();
        await new ConnectionStore(home).save(
            { runner: 'opencode', runtime: 'local' },
            {
                provider: 'openai',
                nativeProvider: 'openai',
                authenticationMethod: 'oauth',
                method: 'chatgpt',
                nativeMethod: 'ChatGPT Pro/Plus (headless)',
            }
        );
        const stored = await fixtureRun(home, {
            mode: 'foreground',
            task: 'authenticated task',
        });
        const adapter = new ControlledAdapter({ autoComplete: true });

        await expect(
            workerFor(home, stored.id, adapter).execute({ environment: {} })
        ).resolves.toBe(0);
        expect(adapter.authentication).toEqual({
            provider: 'openai',
            nativeProvider: 'openai',
            authenticationMethod: 'oauth',
            method: 'chatgpt',
            nativeMethod: 'ChatGPT Pro/Plus (headless)',
        });
        expect(adapter.prompts).toEqual(['authenticated task']);
    });

    test('does not start an invisible authentication flow for a detached run', async () => {
        const home = await temporaryHome();
        await new ConnectionStore(home).save(
            { runner: 'opencode', runtime: 'local' },
            {
                provider: 'openai',
                nativeProvider: 'openai',
                authenticationMethod: 'oauth',
                method: 'chatgpt',
                nativeMethod: 'ChatGPT Pro/Plus (headless)',
            }
        );
        const stored = await fixtureRun(home, {
            mode: 'detached',
            task: 'must wait for authentication',
        });
        const adapter = new ControlledAdapter({ autoComplete: true });

        await expect(
            workerFor(home, stored.id, adapter).execute({ environment: {} })
        ).resolves.toBe(1);
        expect(adapter.starts).toBe(0);
        expect(await new RunStore(home).readEvents(stored.id)).toContainEqual(
            expect.objectContaining({
                type: 'run.failed',
                data: {
                    message:
                        'Authentication is required for openai. Start this Workbench interactively once to finish openai sign-in.',
                },
            })
        );
    });

    test('executes an initial detached task as a resumable native session', async () => {
        const home = await temporaryHome();
        const stored = await fixtureRun(home, {
            mode: 'detached',
            task: 'initial task',
        });
        const adapter = new ControlledAdapter({ autoComplete: true });

        await expect(
            workerFor(home, stored.id, adapter).execute({
                environment: { OPENAI_API_KEY: 'fixture-openai-key' },
            })
        ).resolves.toBe(0);

        const run = await new RunStore(home).read(stored.id);
        expect(run).toMatchObject({ status: 'completed', exit_code: 0 });
        expect(adapter.prompts).toEqual(['initial task']);
        expect(adapter.starts).toBe(1);
        expect(run.runner_session_id).toBe('native-session-1');
        const events = await new RunStore(home).readEvents(stored.id);
        const started = events.find((event) => event.type === 'turn.started');
        const completed = events.find((event) => event.type === 'turn.completed');
        const delivered = events.find(
            (event) =>
                event.type === 'input.delivered' && field(event.data, 'kind') === 'send'
        );
        const accepted = events.find(
            (event) =>
                event.type === 'input.accepted' && field(event.data, 'kind') === 'send'
        );
        expect(delivered?.data).toMatchObject({
            id: `input_${stored.id}`,
            text: 'initial task',
            images: [],
        });
        expect(field(accepted?.data, 'text')).toBeUndefined();
        expect(started?.data).toMatchObject({
            input_id: `input_${stored.id}`,
        });
        expect(completed?.data).toMatchObject({
            input_id: `input_${stored.id}`,
        });
        expect(events.at(-1)?.type).toBe('run.completed');
    });

    test('does not deliver an initial task after its client already cancelled', async () => {
        const home = await temporaryHome();
        const stored = await fixtureRun(home, {
            mode: 'foreground',
            task: 'must not run',
        });
        const adapter = new ControlledAdapter({ autoComplete: true });
        const controller = new AbortController();
        controller.abort();

        await expect(
            workerFor(home, stored.id, adapter).execute({
                environment: { OPENAI_API_KEY: 'fixture-openai-key' },
                signal: controller.signal,
            })
        ).resolves.toBe(130);

        expect(adapter.prompts).toEqual([]);
        expect(await new RunStore(home).read(stored.id)).toMatchObject({
            status: 'cancelled',
            exit_code: 130,
        });
        expect((await new RunStore(home).readEvents(stored.id)).at(-1)).toMatchObject({
            type: 'run.cancelled',
            data: { reason: 'interrupted' },
        });
    });

    test('reports a registry launch after the native session starts', async () => {
        const home = await temporaryHome();
        const stored = await fixtureRun(home, {
            mode: 'detached',
            task: 'reported task',
            registry: true,
        });
        const adapter = new ControlledAdapter({ autoComplete: true });
        const reports: Array<{ url: string; idempotencyKey: string }> = [];

        await workerFor(home, stored.id, adapter, async (registry, idempotencyKey) => {
            reports.push({ url: registry.url, idempotencyKey });
        }).execute({
            environment: { OPENAI_API_KEY: 'fixture-openai-key' },
        });

        expect(reports).toEqual([
            {
                url: 'https://api.workbenches.dev',
                idempotencyKey: 'event_fixture_launch',
            },
        ]);
    });

    test('keeps an attached session alive and completes it after detachment', async () => {
        const home = await temporaryHome();
        const stored = await fixtureRun(home);
        const adapter = new ControlledAdapter({ autoComplete: true });
        const execution = workerFor(home, stored.id, adapter).execute({
            environment: { OPENAI_API_KEY: 'fixture-openai-key' },
        });
        const handle = new StoredRunHandle(home, stored.id);
        await waitForReady(home, stored.id);

        await expect(handle.attach()).resolves.toMatchObject({
            disposition: 'attached',
        });
        const receipt = await handle.send('attached turn');
        await waitForEventType(home, stored.id, 'turn.completed');
        expect((await new RunStore(home).read(stored.id)).status).toBe('running');
        expect(
            (await new RunStore(home).readEvents(stored.id)).find(
                (event) => event.type === 'turn.completed'
            )?.data
        ).toMatchObject({ input_id: receipt.id });

        await expect(handle.detach()).resolves.toMatchObject({
            disposition: 'detached',
        });
        await expect(execution).resolves.toBe(0);
        await expect(handle.result).resolves.toMatchObject({ status: 'completed' });
    });

    test('accepts a client attachment while the native session is starting', async () => {
        const home = await temporaryHome();
        const stored = await fixtureRun(home);
        const startup = deferred<void>();
        const adapter = new ControlledAdapter({ startAfter: startup.promise });
        const execution = workerFor(home, stored.id, adapter).execute({
            environment: { OPENAI_API_KEY: 'fixture-openai-key' },
        });
        const handle = new StoredRunHandle(home, stored.id);
        await waitForRunning(home, stored.id);

        await expect(handle.attach()).resolves.toMatchObject({
            disposition: 'attached',
        });
        expect((await new RunStore(home).read(stored.id)).runner_session_id).toBe(
            undefined
        );

        await expect(handle.detach()).resolves.toMatchObject({
            disposition: 'detached',
        });
        startup.resolve();
        await expect(execution).resolves.toBe(0);
        await expect(handle.result).resolves.toMatchObject({ status: 'completed' });
    });

    test('cancels cleanly while the native session is starting', async () => {
        const home = await temporaryHome();
        const stored = await fixtureRun(home);
        const startup = deferred<void>();
        const adapter = new ControlledAdapter({ startAfter: startup.promise });
        const execution = workerFor(home, stored.id, adapter).execute({
            environment: { OPENAI_API_KEY: 'fixture-openai-key' },
        });
        const handle = new StoredRunHandle(home, stored.id);
        await waitForRunning(home, stored.id);

        await expect(handle.cancel('cancel during startup')).resolves.toMatchObject({
            disposition: 'cancelled',
        });
        startup.resolve();

        await expect(execution).resolves.toBe(130);
        await expect(handle.result).resolves.toMatchObject({ status: 'cancelled' });
        expect((await new RunStore(home).readEvents(stored.id)).at(-1)).toMatchObject({
            type: 'run.cancelled',
            data: { reason: 'cancel during startup' },
        });
    });

    test('lets an active turn finish after its controlling client detaches', async () => {
        const home = await temporaryHome();
        const stored = await fixtureRun(home);
        const adapter = new ControlledAdapter();
        const execution = workerFor(home, stored.id, adapter).execute({
            environment: { OPENAI_API_KEY: 'fixture-openai-key' },
        });
        const handle = new StoredRunHandle(home, stored.id);
        await waitForReady(home, stored.id);
        await handle.attach();
        await handle.send('finish in background');
        await adapter.waitForPrompts(1);

        await handle.detach();
        expect((await new RunStore(home).read(stored.id)).status).toBe('running');
        adapter.completeFirst();
        await expect(execution).resolves.toBe(0);
        expect(adapter.cancellations).toBe(0);
        await expect(handle.result).resolves.toMatchObject({ status: 'completed' });
    });

    test('reopens native state from the stable Workbench session', async () => {
        const home = await temporaryHome();
        const sessionId = 'wb_workersession12345678901';
        const sessions = new SessionStore(home);
        await sessions.create({
            id: sessionId,
            workbench: 'fixture-core',
            workbench_version: '0.1.0',
            runner: 'opencode',
            model: 'openai/gpt-5.6-terra',
            runtime: 'local',
            reference: 'fixture-core',
            workbench_path: '/repo/.workbenches/core',
            workspace: '/workspace',
            workspaces: [],
            native_session_id: 'native-session-before',
            latest_run_id: sessionId,
        });
        const stored = await new RunStore(home).create({
            metadata: {
                workbench: 'fixture-core',
                workbench_version: '0.1.0',
                runner: 'opencode',
                model: 'openai/gpt-5.6-terra',
                workspace: '/workspace',
                mode: 'interactive',
                session_id: sessionId,
                resumed_from: sessionId,
            },
            request: {
                workbench_path: '/repo/.workbenches/core',
                workspace: '/workspace',
                task: '',
                session_id: sessionId,
                native_session_id: 'native-session-before',
            },
        });
        const adapter = new ControlledAdapter();
        const execution = workerFor(home, stored.id, adapter).execute({
            environment: { OPENAI_API_KEY: 'fixture-openai-key' },
        });
        const handle = new StoredRunHandle(home, stored.id);

        await waitForReady(home, stored.id);
        expect(adapter.session).toEqual({
            id: sessionId,
            directory: sessions.nativeDirectory(sessionId),
            nativeSessionId: 'native-session-before',
        });
        expect(await sessions.read(sessionId)).toMatchObject({
            native_session_id: 'native-session-1',
            latest_run_id: stored.id,
        });

        await handle.close();
        await expect(execution).resolves.toBe(0);
    });

    test('names an unnamed resumed session from its first CLI input', async () => {
        const home = await temporaryHome();
        const sessionId = 'wb_workername123456789012';
        const sessions = new SessionStore(home);
        await sessions.create({
            id: sessionId,
            workbench: 'fixture-core',
            workbench_version: '0.1.0',
            runner: 'opencode',
            model: 'openai/gpt-5.6-terra',
            runtime: 'local',
            reference: 'fixture-core',
            workbench_path: '/repo/.workbenches/core',
            workspace: '/workspace',
            workspaces: [],
            native_session_id: 'native-session-before',
            latest_run_id: sessionId,
        });
        const stored = await new RunStore(home).create({
            metadata: {
                workbench: 'fixture-core',
                workbench_version: '0.1.0',
                runner: 'opencode',
                model: 'openai/gpt-5.6-terra',
                workspace: '/workspace',
                mode: 'interactive',
                session_id: sessionId,
                resumed_from: sessionId,
            },
            request: {
                workbench_path: '/repo/.workbenches/core',
                workspace: '/workspace',
                task: '',
                session_id: sessionId,
                native_session_id: 'native-session-before',
            },
        });
        const adapter = new ControlledAdapter();
        const execution = workerFor(home, stored.id, adapter).execute({
            environment: { OPENAI_API_KEY: 'fixture-openai-key' },
        });
        const handle = new StoredRunHandle(home, stored.id);

        await waitForReady(home, stored.id);
        await handle.send('Audit Docker cleanup behavior');
        await adapter.waitForPrompts(1);
        await waitForSessionName(home, sessionId);
        expect(await sessions.read(sessionId)).toMatchObject({
            name: 'Audit Docker cleanup behavior',
        });

        await handle.cancelTurn();
        await handle.close();
        await expect(execution).resolves.toBe(0);
    });

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
            disposition: 'queued',
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
        await expect(recovered.result).resolves.toEqual({
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
        expect(
            events.filter(
                (event) =>
                    event.type === 'input.queued' &&
                    field(event.data, 'kind') === 'follow_up'
            )
        ).toHaveLength(2);
        expect(
            events.filter(
                (event) =>
                    event.type === 'input.queued' &&
                    field(event.data, 'kind') === 'steer'
            )
        ).toHaveLength(1);
        expect(
            events.filter(
                (event) =>
                    event.type === 'input.delivered' &&
                    field(event.data, 'kind') === 'steer'
            )
        ).toHaveLength(1);
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

    test('reports steering as queued until the runner consumes it', async () => {
        const home = await temporaryHome();
        const stored = await fixtureRun(home);
        const adapter = new ControlledAdapter({ deferSteeringDelivery: true });
        const execution = workerFor(home, stored.id, adapter).execute({
            environment: { OPENAI_API_KEY: 'fixture-openai-key' },
        });
        const handle = new StoredRunHandle(home, stored.id);
        await waitForReady(home, stored.id);

        await handle.send('first turn');
        await adapter.waitForPrompts(1);
        await expect(handle.steer('change direction')).resolves.toMatchObject({
            disposition: 'queued',
        });

        let events = await new RunStore(home).readEvents(stored.id);
        expect(eventIndex(events, 'input.queued', 'steer')).toBeGreaterThan(-1);
        expect(eventIndex(events, 'input.delivered', 'steer')).toBe(-1);

        adapter.deliverSteering();
        await waitForEvent(home, stored.id, 'input.delivered', 'steer');
        events = await new RunStore(home).readEvents(stored.id);
        expect(eventIndex(events, 'input.queued', 'steer')).toBeLessThan(
            eventIndex(events, 'input.delivered', 'steer')
        );

        await handle.cancelTurn();
        await handle.close();
        await execution;
        await expect(handle.result).resolves.toMatchObject({ status: 'completed' });
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

    test('routes question answers through the durable control channel', async () => {
        const home = await temporaryHome();
        const stored = await fixtureRun(home);
        const adapter = new ControlledAdapter({ requestQuestion: true });
        const execution = workerFor(home, stored.id, adapter).execute({
            environment: { OPENAI_API_KEY: 'fixture-openai-key' },
        });
        const handle = new StoredRunHandle(home, stored.id);
        await waitForReady(home, stored.id);

        const turn = handle.send('configure deployment');
        await adapter.questionRequested;
        await expect(
            handle.respondToQuestion('question-1', {
                outcome: 'answered',
                answers: [['private answer']],
            })
        ).resolves.toMatchObject({ disposition: 'delivered' });
        await turn;
        await handle.close();
        await execution;
        await expect(handle.result).resolves.toMatchObject({ status: 'completed' });

        expect(adapter.questionResponses).toEqual([
            { outcome: 'answered', answers: [['private answer']] },
        ]);
        const events = await collect(handle.events);
        expect(events).toContainEqual(
            expect.objectContaining({
                type: 'question.requested',
                data: expect.objectContaining({ id: 'question-1' }),
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

    test('rejects an active question when its turn is cancelled', async () => {
        const home = await temporaryHome();
        const stored = await fixtureRun(home);
        const adapter = new ControlledAdapter({ requestQuestion: true });
        const execution = workerFor(home, stored.id, adapter).execute({
            environment: { OPENAI_API_KEY: 'fixture-openai-key' },
        });
        const handle = new StoredRunHandle(home, stored.id);
        await waitForReady(home, stored.id);

        const turn = handle.send('configure deployment');
        await adapter.questionRequested;
        await expect(handle.cancelTurn()).resolves.toMatchObject({
            disposition: 'cancelled',
        });
        await turn;
        await handle.close();
        await execution;
        await expect(handle.result).resolves.toMatchObject({ status: 'completed' });

        expect(adapter.questionResponses).toEqual([{ outcome: 'rejected' }]);
        const events = await collect(handle.events);
        expect(events).toContainEqual(
            expect.objectContaining({
                type: 'question.rejected',
                data: { id: 'question-1' },
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
    readonly questionResponses: RunnerQuestionResponse[] = [];
    cancellations = 0;
    starts = 0;
    session: RunnerSessionStartOptions['session'];
    authentication: RunnerSessionStartOptions['authentication'];
    private host?: RunnerSessionStartOptions['host'];
    private releaseFirst?: () => void;
    private readonly promptWaiters: Array<() => void> = [];
    private readonly markPermissionRequested: () => void;
    readonly permissionRequested: Promise<void>;
    private readonly markQuestionRequested: () => void;
    readonly questionRequested: Promise<void>;

    private readonly steeringDelivery: Promise<void>;
    private readonly resolveSteeringDelivery: () => void;

    constructor(
        private readonly options: {
            requestPermission?: boolean;
            requestQuestion?: boolean;
            deferSteeringDelivery?: boolean;
            autoComplete?: boolean;
            startAfter?: Promise<void>;
        } = {}
    ) {
        let markPermissionRequested!: () => void;
        this.permissionRequested = new Promise((resolve) => {
            markPermissionRequested = resolve;
        });
        this.markPermissionRequested = markPermissionRequested;
        let markQuestionRequested!: () => void;
        this.questionRequested = new Promise((resolve) => {
            markQuestionRequested = resolve;
        });
        this.markQuestionRequested = markQuestionRequested;
        let resolveSteeringDelivery!: () => void;
        this.steeringDelivery = new Promise((resolve) => {
            resolveSteeringDelivery = resolve;
        });
        this.resolveSteeringDelivery = resolveSteeringDelivery;
    }

    async start(options: RunnerSessionStartOptions): Promise<RunnerSession> {
        this.starts += 1;
        this.host = options.host;
        this.session = options.session;
        this.authentication = options.authentication;
        await this.options.startAfter;
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

    deliverSteering(): void {
        this.resolveSteeringDelivery();
    }

    completeFirst(): void {
        this.releaseFirst?.();
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
            } else if (this.options.requestQuestion) {
                this.markQuestionRequested();
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
            } else if (!this.options.autoComplete) {
                await new Promise<void>((resolve) => {
                    this.releaseFirst = resolve;
                });
            }
        }
        await this.host?.emit({ type: 'output.text', data: { text: 'done' } });
        return { reason: 'stop' };
    }

    private async steer(input: RunnerInput) {
        this.steers.push(normalizeRunnerInput(input).text);
        return {
            delivered: this.options.deferSteeringDelivery
                ? this.steeringDelivery
                : Promise.resolve(),
        };
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
                    ...(options.authentication
                        ? { authentication: options.authentication }
                        : {}),
                    host: options.host,
                    ...(options.session ? { session: options.session } : {}),
                }),
            cleanup: () => prepared.cleanup(),
        };
    }
}

function workerFor(
    home: string,
    runId: string,
    adapter: RunnerSessionAdapter,
    reportLaunch?: NonNullable<
        ConstructorParameters<typeof InteractiveRunWorker>[2]
    >['reportLaunch']
) {
    return new InteractiveRunWorker(home, runId, {
        loadWorkbench: async () => workbench(),
        findExecutable: (name) => `/bin/${name}`,
        registry: new RunnerRegistry([new InteractiveWorkerTestRunner(adapter)]),
        runtimeRegistry: new RuntimeRegistry([
            new LocalRuntimeProvider({
                findExecutable: (name) => `/bin/${name}`,
                spawn: () => ({
                    exited: Promise.resolve(0),
                    stdout: new Blob(['No credentials found\n']).stream(),
                    stderr: new Blob([]).stream(),
                }),
            }),
        ]),
        now: () => new Date('2026-09-01T12:00:00.000Z'),
        captureOutcomes: false,
        ...(reportLaunch ? { reportLaunch } : {}),
    });
}

async function temporaryHome(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-interactive-worker-'));
    temporaryDirectories.push(directory);
    return directory;
}

function fixtureRun(
    home: string,
    options: {
        mode?: 'foreground' | 'detached' | 'interactive';
        task?: string;
        registry?: boolean;
    } = {}
): Promise<StoredRun> {
    return new RunStore(home).create({
        metadata: {
            workbench: 'fixture-core',
            workbench_version: '0.1.0',
            runner: 'opencode',
            model: 'openai/gpt-5.6-terra',
            workspace: '/workspace',
            mode: options.mode ?? 'interactive',
            execution: 'session',
            ...(options.registry
                ? {
                      registry: {
                          url: 'https://api.workbenches.dev',
                          publisher: 'fixture',
                          workbench: 'core',
                          version_id: 'version_fixture',
                      },
                      registry_event_id: 'event_fixture_launch',
                  }
                : {}),
        },
        request: {
            workbench_path: '/repo/.workbenches/core',
            workspace: '/workspace',
            task: options.task ?? '',
        },
    });
}

function workbench(): ResolvedWorkbench {
    return {
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

async function waitForRunning(home: string, runId: string): Promise<void> {
    const store = new RunStore(home);
    for (let attempt = 0; attempt < 200; attempt += 1) {
        if ((await store.read(runId)).status === 'running') return;
        await Bun.sleep(2);
    }
    throw new Error('Timed out waiting for interactive worker ownership');
}

async function waitForSessionName(home: string, sessionId: string): Promise<void> {
    const store = new SessionStore(home);
    for (let attempt = 0; attempt < 200; attempt += 1) {
        if ((await store.read(sessionId)).name) return;
        await Bun.sleep(2);
    }
    throw new Error('Timed out waiting for Workbench session name');
}

async function waitForEvent(
    home: string,
    runId: string,
    type: WorkbenchEvent['type'],
    kind: string
): Promise<void> {
    const store = new RunStore(home);
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const events = await store.readEvents(runId);
        if (eventIndex(events, type, kind) >= 0) return;
        await Bun.sleep(2);
    }
    throw new Error(`Timed out waiting for ${type}:${kind}`);
}

async function waitForEventType(
    home: string,
    runId: string,
    type: WorkbenchEvent['type']
): Promise<void> {
    const store = new RunStore(home);
    for (let attempt = 0; attempt < 200; attempt += 1) {
        if ((await store.readEvents(runId)).some((event) => event.type === type))
            return;
        await Bun.sleep(2);
    }
    throw new Error(`Timed out waiting for ${type}`);
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

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((next) => {
        resolve = next;
    });
    return { promise, resolve };
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
