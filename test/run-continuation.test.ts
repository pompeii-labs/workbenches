import { describe, expect, test } from 'bun:test';

import type { RunnerInput } from '../src/runners/session.js';
import {
    type DispatchRunOptions,
    type PrepareRunOptions,
    RunContinuation,
    type RunControlKind,
    type RunControlReceipt,
    type RunHandle,
    type StoredRun,
    type WorkbenchEvent,
} from '../src/runs/index.js';
import type { StoredSession } from '../src/sessions/index.js';
import type { ResolvedWorkbenchReference } from '../src/workbench/index.js';

describe('run continuation', () => {
    test('sends a foreground continuation to the active run', async () => {
        const session = storedSession();
        const active = storedRun(session.latest_run_id, 'running');
        const handle = fakeHandle(active.id);
        let prepared = 0;
        handle.followUp = async (input) => {
            expect(input).toBe('inspect migrations');
            return { ...receipt('follow_up', 'queued'), id: 'ctl_follow_up' };
        };
        const continuation = fixtureContinuation({
            session,
            run: active,
            handle,
            events: [event(7, 'output.text')],
            prepare: async () => {
                prepared += 1;
                throw new Error('must not prepare');
            },
        });

        await expect(
            continuation.submit({
                resolved: resolvedWorkbench(),
                session,
                task: 'inspect migrations',
                mode: 'foreground',
                environment: {},
            })
        ).resolves.toMatchObject({
            sessionId: session.id,
            run: active,
            handle,
            inputId: 'ctl_follow_up',
            afterSequence: 7,
        });
        expect(prepared).toBe(0);
    });

    test('rejects environment changes while continuing an active run', async () => {
        const session = storedSession();
        const active = storedRun(session.latest_run_id, 'running');
        const continuation = fixtureContinuation({
            session,
            run: active,
            handle: fakeHandle(active.id),
            prepare: async () => {
                throw new Error('must not prepare');
            },
        });

        await expect(
            continuation.submit({
                resolved: resolvedWorkbench(),
                session,
                task: 'inspect migrations',
                mode: 'foreground',
                environment: {},
                environmentOverrides: true,
            })
        ).rejects.toThrow(
            'Environment overrides cannot change an active Workbench execution'
        );
    });

    test('starts one linked run when the previous run is complete', async () => {
        const session = storedSession();
        const completed = storedRun(session.latest_run_id, 'completed');
        const next = storedRun('wb_taskcontinuation1234567890123', 'dispatched');
        const handle = fakeHandle(next.id);
        let dispatchedId = '';
        const continuation = fixtureContinuation({
            session,
            run: completed,
            handle,
            prepare: async (options) => {
                expect(options).toMatchObject({
                    task: 'inspect migrations',
                    mode: 'detached',
                    session,
                });
                return next;
            },
            dispatch: async (options) => {
                dispatchedId = options.id;
                return 1;
            },
        });

        await expect(
            continuation.submit({
                resolved: resolvedWorkbench(),
                session,
                task: 'inspect migrations',
                mode: 'detached',
                environment: {},
            })
        ).resolves.toMatchObject({
            sessionId: session.id,
            run: next,
            handle,
            inputId: `input_${next.id}`,
            afterSequence: 0,
        });
        expect(dispatchedId).toBe(next.id);
    });

    test('attaches to an active run without starting another native run', async () => {
        const session = storedSession();
        const active = storedRun(session.latest_run_id, 'running');
        const handle = fakeHandle(active.id);
        let attached = 0;
        let prepared = 0;
        handle.attach = async () => {
            attached += 1;
            return receipt('attach_client', 'attached');
        };
        const continuation = fixtureContinuation({
            session,
            run: active,
            handle,
            prepare: async () => {
                prepared += 1;
                throw new Error('must not prepare');
            },
        });

        await expect(
            continuation.open({
                resolved: resolvedWorkbench(),
                reference: 'lux-ops',
                environment: {},
                session,
            })
        ).resolves.toBe(handle);
        expect(attached).toBe(1);
        expect(prepared).toBe(0);
    });

    test('opens a completed session as one new linked run', async () => {
        const session = storedSession();
        const completed = storedRun(session.latest_run_id, 'completed');
        const next = storedRun('wb_linkedcontinuation1234567890', 'dispatched');
        const handle = fakeHandle(next.id);
        let preparedSession: StoredSession | undefined;
        let dispatchedId = '';
        let attached = 0;
        handle.attach = async () => {
            attached += 1;
            return receipt('attach_client', 'attached');
        };
        const continuation = fixtureContinuation({
            session,
            run: completed,
            handle,
            prepare: async (options) => {
                preparedSession = options.session;
                return next;
            },
            dispatch: async (options) => {
                dispatchedId = options.id;
                return 1;
            },
        });

        await expect(
            continuation.open({
                resolved: resolvedWorkbench(),
                reference: 'lux-ops',
                environment: { FIXTURE: 'ready' },
                session,
            })
        ).resolves.toBe(handle);
        expect(preparedSession).toBe(session);
        expect(dispatchedId).toBe(next.id);
        expect(attached).toBe(1);
    });

    test('starts a new interactive session without acquiring a prior session', async () => {
        const session = storedSession();
        const next = storedRun('wb_newinteractiverun12345678901', 'dispatched');
        const handle = fakeHandle(next.id);
        let prepared = 0;
        const continuation = fixtureContinuation({
            session,
            run: next,
            handle,
            prepare: async (options) => {
                prepared += 1;
                expect(options.session).toBeUndefined();
                return next;
            },
        });

        await expect(
            continuation.open({
                resolved: resolvedWorkbench(),
                reference: 'lux-ops',
                environment: {},
            })
        ).resolves.toBe(handle);
        expect(prepared).toBe(1);
    });
});

function fixtureContinuation(options: {
    session: StoredSession;
    run: StoredRun;
    handle: RunHandle;
    events?: WorkbenchEvent[];
    prepare: (options: PrepareRunOptions) => Promise<StoredRun>;
    dispatch?: (options: DispatchRunOptions) => Promise<number>;
}): RunContinuation {
    return new RunContinuation('/tmp/workbench-run-continuation-tests', {
        dispatcher: {
            prepare: options.prepare,
            dispatch: options.dispatch ?? (async () => 1),
            handle: () => options.handle,
        },
        runs: {
            read: async () => options.run,
            readEvents: async () => options.events ?? [],
            reconcile: async () => options.run,
        },
        sessions: {
            read: async () => options.session,
            exclusive: async (_id, operation) => operation(),
        },
    });
}

function fakeHandle(runId: string): RunHandle {
    const control = async () => receipt('send', 'delivered');
    return {
        runId,
        events: emptyEvents(),
        result: new Promise<never>(() => {}),
        observe: emptyEvents,
        attach: async () => receipt('attach_client', 'attached'),
        detach: async () => receipt('detach_client', 'detached'),
        send: async (_input: RunnerInput) => control(),
        steer: async (_input: RunnerInput) => control(),
        followUp: async (_input: RunnerInput) => control(),
        cancelTurn: control,
        respondToPermission: control,
        respondToQuestion: control,
        close: control,
        cancel: control,
    };
}

async function* emptyEvents() {}

function event(sequence: number, type: WorkbenchEvent['type']): WorkbenchEvent {
    return {
        protocol: 0,
        run_id: 'wb_continuationrun123456789012',
        sequence,
        timestamp: '2026-09-04T00:00:00.000Z',
        type,
        runner: 'opencode',
        data: {},
    };
}

function receipt(
    kind: RunControlKind,
    disposition: NonNullable<RunControlReceipt['disposition']>
): RunControlReceipt {
    return {
        version: 1,
        id: crypto.randomUUID(),
        kind,
        outcome: 'accepted',
        resolved_at: new Date().toISOString(),
        disposition,
    };
}

function storedSession(): StoredSession {
    return {
        version: 1,
        id: 'wb_continuationsession1234567890',
        workbench: 'lux-ops',
        workbench_version: '0.1.0',
        runner: 'opencode',
        model: 'openai/gpt-5.6-terra',
        runtime: 'local',
        reference: 'lux-ops',
        workbench_path: '/repo/.workbenches/ops',
        workspace: '/workspace',
        workspaces: [],
        native_session_id: 'native-session',
        latest_run_id: 'wb_continuationrun123456789012',
        created_at: '2026-09-04T00:00:00.000Z',
        updated_at: '2026-09-04T00:00:00.000Z',
    };
}

function storedRun(id: string, status: StoredRun['status']): StoredRun {
    return {
        version: 1,
        id,
        status,
        workbench: 'lux-ops',
        workbench_version: '0.1.0',
        runner: 'opencode',
        model: 'openai/gpt-5.6-terra',
        workspace: '/workspace',
        mode: 'interactive',
        execution: 'session',
        dispatched_at: '2026-09-04T00:00:00.000Z',
        session_id: 'wb_continuationsession1234567890',
    };
}

function resolvedWorkbench(): ResolvedWorkbenchReference {
    return {
        workspaceDirectory: '/workspace',
        cleanup: async () => {},
        workbench: {
            repositoryDirectory: '/repo',
            packageDirectory: '/repo/.workbenches/ops',
            manifestPath: '/repo/.workbenches/ops/workbench.yml',
            instructionsPath: '/repo/.workbenches/ops/instructions.md',
            skills: [],
            manifest: {
                spec: 0,
                name: 'lux-ops',
                version: '0.1.0',
                runner: 'opencode',
                model: { id: 'openai/gpt-5.6-terra' },
                runtime: 'local',
                instructions: './instructions.md',
                skills: [],
                tools: [],
                mcps: [],
                env: {},
            },
        },
    };
}
