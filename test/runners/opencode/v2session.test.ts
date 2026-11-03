import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { OpenCodeServerSession } from '../../../src/runners/opencode/session.js';
import type {
    RunnerPermissionDecision,
    RunnerPermissionRequest,
    RunnerQuestionRequest,
    RunnerQuestionResponse,
    RunnerSessionHost,
} from '../../../src/runners/session.js';
import type { WorkbenchEventDraft } from '../../../src/runs/index.js';
import { fixtureConfiguration, fixtureWorkbench, settled } from './fixture.js';
import { FakeOpenCodeV2Server } from './v2fixture.js';

// The behaviors the OpenCode 1 suites prove, against the OpenCode 2 protocol.

const root = await mkdtemp(join(tmpdir(), 'opencode-v2-session-'));
const packageDirectory = join(root, '.workbenches', 'core');
await mkdir(packageDirectory, { recursive: true });
await writeFile(join(packageDirectory, 'instructions.md'), '# OpenCode instructions\n');
afterAll(() => rm(root, { recursive: true, force: true }));

const workbench = fixtureWorkbench(packageDirectory, root);

class RecordingHost implements RunnerSessionHost {
    readonly events: WorkbenchEventDraft[] = [];
    readonly permissions: RunnerPermissionRequest[] = [];
    readonly questions: RunnerQuestionRequest[] = [];
    readonly withdrawn: string[] = [];
    /** Event types whose next emit throws, once each, without recording the event. */
    readonly failOnce = new Set<string>();
    decide: (
        request: RunnerPermissionRequest
    ) => RunnerPermissionDecision | Promise<RunnerPermissionDecision> = () =>
        'allow_once';
    answer: (request: RunnerQuestionRequest) => RunnerQuestionResponse = () => ({
        outcome: 'rejected',
    });

    async emit(event: WorkbenchEventDraft): Promise<void> {
        if (this.failOnce.delete(event.type)) throw new Error('host storage failed');
        this.events.push(event);
    }

    async requestPermission(request: RunnerPermissionRequest) {
        this.permissions.push(request);
        return this.decide(request);
    }

    async requestQuestion(request: RunnerQuestionRequest) {
        this.questions.push(request);
        return this.answer(request);
    }

    async withdrawRequest(id: string): Promise<void> {
        this.withdrawn.push(id);
    }

    ofType(type: string) {
        return this.events.filter((event) => event.type === type);
    }

    get texts() {
        return this.ofType('output.text').map((event) => event.data.text);
    }
}

async function start(
    server: FakeOpenCodeV2Server,
    host: RecordingHost,
    options: { resume?: boolean; environment?: Record<string, string> } = {}
) {
    return (await server.adapter().start({
        workbench,
        workspaceDirectory: '/workspace',
        environment: options.environment ?? {},
        configuration: fixtureConfiguration(workbench),
        host,
        ...(options.resume
            ? {
                  session: {
                      id: 'session_fixture',
                      directory: '/tmp/session-fixture',
                      nativeSessionId: 'ses_native_1',
                  },
              }
            : {}),
    })) as OpenCodeServerSession;
}

const permission = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    action: 'external_directory',
    resources: ['/outside/*'],
    save: ['/outside/*'],
    ...extra,
});

async function until(condition: () => boolean) {
    for (let tries = 0; tries < 200 && !condition(); tries++) await Bun.sleep(1);
}

describe('OpenCode 2 permissions', () => {
    test('pauses for a host decision and replies on the session before continuing', async () => {
        const server = new FakeOpenCodeV2Server();
        const host = new RecordingHost();
        const session = await start(server, host);
        server.onPrompt = () => {
            const answer = server.begin();
            server.tool(
                answer,
                'call_1',
                'read',
                { filePath: '/outside/file.ts' },
                'running'
            );
            server.emit('permission.asked', permission('per_1'));
        };
        server.onPermissionReply = () => {
            server.emit('session.tool.success', {
                assistantMessageID: server.answerFor(server.currentInputMessageId()),
                id: 'call_1',
            });
            server.completeTurn('done');
        };
        await session.prompt('inspect outside');
        await session.close();

        expect(host.permissions).toEqual([
            {
                id: 'per_1',
                action: 'external_directory',
                resources: ['/outside/*'],
                message: 'Allow external directory for /outside/*?',
                allowAlways: true,
            },
        ]);
        expect(server.permissionReplies).toEqual([
            {
                path: '/api/session/ses_native_1/permission/per_1/reply',
                body: { decision: 'once' },
            },
        ]);
        expect(host.ofType('tool.completed')).toEqual([
            {
                type: 'tool.completed',
                data: {
                    id: 'call_1',
                    name: 'read',
                    title: 'Read',
                    target: '/outside/file.ts',
                    status: 'completed',
                },
            },
        ]);
    });

    test('coalesces concurrent requests covered by an always decision', async () => {
        const server = new FakeOpenCodeV2Server();
        const host = new RecordingHost();
        host.decide = () => 'allow_always';
        const session = await start(server, host);
        server.onPrompt = () => {
            for (const id of ['per_1', 'per_2', 'per_3'])
                server.emit('permission.asked', permission(id));
        };
        server.onPermissionReply = () => server.completeTurn('done');
        await session.prompt('inspect in parallel');
        await session.close();

        expect(host.permissions).toHaveLength(1);
        expect(server.permissionReplies.map((reply) => reply.body)).toEqual([
            { decision: 'always' },
        ]);
    });

    test('releases an unanswered request on cancellation so the next turn can ask', async () => {
        const server = new FakeOpenCodeV2Server();
        const host = new RecordingHost();
        let asked = 0;
        host.decide = () => (++asked === 1 ? new Promise(() => {}) : 'allow_once');
        const session = await start(server, host);
        server.onPrompt = () =>
            server.emit(
                'permission.asked',
                permission(`per_${server.promptBodies.length}`)
            );
        const first = session.prompt('first');
        await until(() => host.permissions.length === 1);
        await session.cancelTurn();
        expect(await first).toEqual({ reason: 'cancelled' });
        expect(host.withdrawn).toEqual(['per_1']);
        server.onPermissionReply = () => server.completeTurn('second');
        await session.prompt('second');
        await session.close();

        expect(asked).toBe(2);
        expect(server.permissionReplies.map((reply) => reply.body)).toEqual([
            { decision: 'once' },
        ]);
    });

    test('does not fail a turn when OpenCode already resolved the permission', async () => {
        const server = new FakeOpenCodeV2Server();
        server.permissionReplyStatus = 404;
        const session = await start(server, new RecordingHost());
        server.onPrompt = () =>
            server.emit('permission.asked', permission('per_stale'));
        server.onPermissionReply = () => server.completeTurn('done');
        await expect(session.prompt('inspect')).resolves.toEqual({ reason: 'stop' });
        await session.close();
    });

    for (const [resources, allowed] of [
        [['/outbox/*'], true],
        [['/outbox/../secrets/*'], false],
    ] as const) {
        test(`answers an outbox request for ${resources.join(', ')} ${allowed ? 'itself' : 'through the host'}`, async () => {
            const server = new FakeOpenCodeV2Server();
            const host = new RecordingHost();
            host.decide = () => 'reject';
            const session = await start(server, host, {
                environment: { WORKBENCH_OUTPUT_DIR: '/outbox' },
            });
            server.onPrompt = () =>
                server.emit(
                    'permission.asked',
                    permission('per_outbox', { resources })
                );
            server.onPermissionReply = () => server.completeTurn('done');
            await session.prompt('return a report');
            await session.close();

            expect(host.permissions).toHaveLength(allowed ? 0 : 1);
            expect(server.permissionReplies.map((reply) => reply.body)).toEqual([
                { decision: allowed ? 'once' : 'reject' },
            ]);
        });
    }

    test('ignores a permission of a session this one does not own', async () => {
        const server = new FakeOpenCodeV2Server();
        server.sessions.set('ses_other', { id: 'ses_other' });
        const host = new RecordingHost();
        const session = await start(server, host);
        server.onPrompt = () => {
            server.emit(
                'permission.asked',
                permission('per_other', { sessionID: 'ses_other' })
            );
            server.completeTurn('done');
        };
        await session.prompt('work');
        await session.close();

        expect(host.permissions).toEqual([]);
        expect(server.permissionReplies).toEqual([]);
    });

    test('can close while the host has not answered a permission', async () => {
        const server = new FakeOpenCodeV2Server();
        const host = new RecordingHost();
        host.decide = () => new Promise(() => {});
        const session = await start(server, host);
        server.onPrompt = () =>
            server.emit('permission.asked', permission('per_pending'));
        const turn = session.prompt('inspect');
        await until(() => host.permissions.length === 1);
        await session.close();
        await expect(turn).resolves.toEqual({ reason: 'cancelled' });
        expect(server.permissionReplies).toEqual([]);
    });
});

describe('OpenCode 2 questions', () => {
    test('puts form fields to the host and replies with their option values', async () => {
        const server = new FakeOpenCodeV2Server();
        const host = new RecordingHost();
        host.answer = () => ({
            outcome: 'answered',
            answers: [['Production'], ['Email', 'Push']],
        });
        const session = await start(server, host);
        server.onPrompt = () =>
            server.emitForm('form_1', [
                {
                    key: 'target',
                    type: 'string',
                    title: 'Where should this deploy?',
                    custom: false,
                    options: [
                        {
                            value: 'production',
                            label: 'Production',
                            description: 'Deploy for customers',
                        },
                        { value: 'staging', label: 'Staging' },
                    ],
                },
                {
                    key: 'channels',
                    type: 'multiselect',
                    description: 'Which channels should be enabled?',
                    options: [
                        { value: 'email', label: 'Email' },
                        { value: 'push', label: 'Push' },
                    ],
                },
            ]);
        server.onFormReply = () => server.completeTurn('configured');
        await session.prompt('configure deployment');
        await session.close();

        // A field's key names its answer, so it is not shown as a header.
        expect(host.questions).toEqual([
            {
                id: 'form_1',
                questions: [
                    {
                        question: 'Where should this deploy?',
                        options: [
                            {
                                label: 'Production',
                                description: 'Deploy for customers',
                            },
                            { label: 'Staging' },
                        ],
                        multiple: false,
                        custom: false,
                    },
                    {
                        question: 'Which channels should be enabled?',
                        options: [{ label: 'Email' }, { label: 'Push' }],
                        multiple: true,
                        custom: false,
                    },
                ],
            },
        ]);
        expect(server.formReplies).toEqual([
            {
                path: '/api/session/ses_native_1/form/form_1/reply',
                method: 'POST',
                body: { answer: { target: 'production', channels: ['email', 'push'] } },
            },
        ]);
    });

    test('dismisses a form the host rejected', async () => {
        const server = new FakeOpenCodeV2Server();
        const session = await start(server, new RecordingHost());
        server.onPrompt = () =>
            server.emitForm('form_dismissed', [
                {
                    key: 'continue',
                    type: 'string',
                    title: 'Continue?',
                    options: [{ value: 'yes', label: 'Yes' }],
                },
            ]);
        server.onFormReply = () => server.completeTurn('dismissed');
        await session.prompt('ask before continuing');
        await session.close();

        expect(server.formReplies).toEqual([
            { path: '/api/session/ses_native_1/form/form_dismissed', method: 'DELETE' },
        ]);
    });

    test('fails the turn on a field it cannot answer faithfully', async () => {
        const server = new FakeOpenCodeV2Server();
        const host = new RecordingHost();
        const session = await start(server, host);
        server.onPrompt = () =>
            server.emitForm('form_typed', [
                { key: 'count', type: 'number', title: 'How many?' },
            ]);
        await expect(session.prompt('ask a number')).rejects.toThrow(
            'OpenCode event stream failed'
        );
        await session.close();
        expect(host.questions).toEqual([]);
    });
});

describe('OpenCode 2 steering', () => {
    test('delivers steering through the inbox and keeps each answer its own output', async () => {
        const server = new FakeOpenCodeV2Server();
        const host = new RecordingHost();
        const session = await start(server, host);
        server.onPrompt = () => {};
        const turn = session.prompt('first input');
        await server.prompted;
        const steering = await session.steer({
            text: 'steered input',
            images: [
                { data: 'aW1hZ2U=', mimeType: 'image/png', name: 'direction.png' },
            ],
        });
        const [original, steered] = server.promptBodies.map((body) => String(body.id));
        expect(server.promptBodies[1]).toEqual({
            id: expect.stringMatching(/^msg_[a-f0-9]{26}$/),
            text: 'steered input',
            files: [{ uri: 'data:image/png;base64,aW1hZ2U=', name: 'direction.png' }],
            delivery: 'steer',
        });

        server.text(server.begin(original), 0, 'First reply.');
        await Bun.sleep(0);
        expect(await settled(steering.delivered)).toBeFalse();
        const answer = server.begin(steered);
        await expect(steering.delivered).resolves.toBeUndefined();
        server.text(answer, 0, 'Steered reply.');
        server.finish(answer);
        server.emit('session.execution.succeeded', {});

        await expect(turn).resolves.toEqual({ reason: 'stop' });
        await session.close();
        const output = host.ofType('output.text');
        expect(output.map((event) => event.data.text)).toEqual([
            'First reply.',
            'Steered reply.',
        ]);
        expect(output[0]?.data.id).not.toBe(output[1]?.data.id);
    });

    test('delivers queued steering once OpenCode answers the latest input', async () => {
        const server = new FakeOpenCodeV2Server();
        const session = await start(server, new RecordingHost());
        server.onPrompt = () => {};
        const turn = session.prompt('original input');
        await server.prompted;
        const deliveries = [];
        for (const text of ['first', 'second', 'third'])
            deliveries.push((await session.steer(text)).delivered);
        await Bun.sleep(0);
        expect(server.promptBodies.map((body) => body.text)).toEqual([
            'original input',
            'first',
            'second',
            'third',
        ]);
        for (const delivery of deliveries) expect(await settled(delivery)).toBeFalse();

        server.completeTurn('Done.');
        await expect(Promise.all(deliveries)).resolves.toEqual([
            undefined,
            undefined,
            undefined,
        ]);
        await expect(turn).resolves.toEqual({ reason: 'stop' });
        await session.close();
    });

    test('fails steering the turn finished without consuming', async () => {
        const server = new FakeOpenCodeV2Server();
        const session = await start(server, new RecordingHost());
        server.onPrompt = () => {};
        const turn = session.prompt('original input');
        await server.prompted;
        const { delivered } = await session.steer('too late');
        server.completeTurn('Done.', String(server.promptBodies[0]?.id));
        await expect(turn).resolves.toEqual({ reason: 'stop' });
        await expect(delivered).rejects.toThrow(
            'OpenCode completed before consuming steering input'
        );
        await session.close();
    });
});

describe('OpenCode 2 cancellation', () => {
    test('interrupts an active turn and closes the private server once', async () => {
        const server = new FakeOpenCodeV2Server();
        const session = await start(server, new RecordingHost());
        server.onPrompt = () => {};
        const turn = session.prompt('wait');
        await server.prompted;
        await session.cancelTurn();
        await expect(turn).resolves.toEqual({ reason: 'cancelled' });
        await session.close();
        await session.close();
        expect(server.interrupts).toBe(1);
        expect(server.kills).toBe(1);
    });

    test('waits for the interrupted execution, and a late status settles nothing', async () => {
        const server = new FakeOpenCodeV2Server();
        server.autoInterruptOnRequest = false;
        const host = new RecordingHost();
        const session = await start(server, host);
        server.onPrompt = () => {};
        const first = session.prompt('cancel immediately');
        await server.prompted;
        let cancelled = false;
        const cancellation = session.cancelTurn().then(() => {
            cancelled = true;
        });
        await server.interrupted;
        server.emit('session.status', { status: 'idle' });
        server.emit('session.idle', {});
        await Bun.sleep(0);
        expect(cancelled).toBeFalse();
        server.emit('session.execution.interrupted', { reason: 'user' });
        await cancellation;
        await expect(first).resolves.toEqual({ reason: 'cancelled' });

        server.onPrompt = () => {
            server.emit('session.status', { status: 'idle' });
            server.emit('session.idle', {});
        };
        const next = session.prompt('try again');
        await Bun.sleep(5);
        expect(await settled(next)).toBeFalse();
        server.completeTurn('recovered');
        await expect(next).resolves.toEqual({ reason: 'stop' });
        await session.close();
        expect(host.texts).toEqual(['recovered']);
    });

    test('does not hide a native failure during cancellation', async () => {
        const server = new FakeOpenCodeV2Server();
        server.autoInterruptOnRequest = false;
        const session = await start(server, new RecordingHost());
        server.onPrompt = () => {};
        const turn = session.prompt('cancel during a failure');
        await server.prompted;
        const failures = Promise.allSettled([turn, session.cancelTurn()]);
        await server.interrupted;
        server.emit('session.execution.failed', {
            error: { type: 'ProviderError', message: 'Provider unavailable' },
        });
        const message = 'OpenCode session failed: Provider unavailable';
        expect(await failures).toEqual([
            { status: 'rejected', reason: expect.objectContaining({ message }) },
            { status: 'rejected', reason: expect.objectContaining({ message }) },
        ]);
        await session.close();
    });
});

/** What the server holds of a turn that finished while the stream was down. */
function finishedTranscript(input: string, answer = `answer_${input}`) {
    return [
        { id: input, type: 'user', text: 'work' },
        {
            id: answer,
            type: 'assistant',
            content: [
                { type: 'text', text: 'Hello, world' },
                {
                    type: 'tool',
                    id: 'call_contract',
                    name: 'write',
                    state: {
                        status: 'completed',
                        input: { filePath: '/workspace/output.txt' },
                    },
                },
            ],
            finish: 'stop',
            time: { created: 1, completed: 2 },
            tokens: { total: 12, input: 5, output: 7 },
            cost: 0.001,
        },
        { id: 'idle_1', type: 'idle', outcome: 'succeeded' },
    ];
}

/** A turn that dropped its stream after `Hello` and a running tool call. */
function dropAfterHello(server: FakeOpenCodeV2Server) {
    server.onPrompt = () => {
        const answer = server.begin();
        server.emit('session.text.started', { assistantMessageID: answer, ordinal: 0 });
        server.emit('session.text.delta', {
            assistantMessageID: answer,
            ordinal: 0,
            delta: 'Hello',
        });
        server.tool(
            answer,
            'call_contract',
            'write',
            { filePath: '/workspace/output.txt' },
            'running'
        );
        setTimeout(() => server.failEventStream(), 5);
    };
}

describe('OpenCode 2 turn resume', () => {
    test('delivers what was produced while the stream was down, once, across pages', async () => {
        const server = new FakeOpenCodeV2Server();
        const host = new RecordingHost();
        const session = await start(server, host, { resume: true });
        dropAfterHello(server);
        await expect(session.prompt('work')).rejects.toThrow(
            'OpenCode event stream failed'
        );
        expect(host.texts).toEqual(['Hello']);
        expect(host.ofType('tool.started')).toHaveLength(1);

        const input = server.currentInputMessageId();
        server.transcript = finishedTranscript(input);
        await expect(session.resumeTurn()).resolves.toEqual({ reason: 'stop' });

        expect(server.eventSubscriptions).toBe(2);
        expect(
            server.requests
                .filter((request) => request.path.endsWith('/message'))
                .map((request) => request.query.toString())
        ).toEqual(['order=asc', 'cursor=1']);
        expect(host.texts).toEqual(['Hello', ', world']);
        expect(host.ofType('tool.started')).toHaveLength(1);
        expect(host.ofType('tool.completed')).toHaveLength(1);
        expect(host.ofType('usage.updated')).toEqual([
            {
                type: 'usage.updated',
                data: {
                    kind: 'delta',
                    total_tokens: 12,
                    input_tokens: 5,
                    output_tokens: 7,
                    cost_usd: 0.001,
                },
            },
        ]);
        expect(session.progress().text).toEqual({ [`answer_${input}:0`]: 12 });
        await session.close();
    });

    test('progress survives a restart: the next session emits only what is new', async () => {
        const server = new FakeOpenCodeV2Server();
        const first = await start(server, new RecordingHost(), { resume: true });
        dropAfterHello(server);
        await expect(first.prompt('work')).rejects.toThrow('event stream failed');
        const input = server.currentInputMessageId();
        const saved = JSON.parse(JSON.stringify(first.progress()));
        expect(saved).toEqual({
            sessionId: 'ses_native_1',
            inputMessageId: input,
            text: { [`answer_${input}:0`]: 5 },
            startedTools: ['call_contract'],
            completedTools: [],
            finishedSteps: [],
        });

        server.transcript = finishedTranscript(input);
        const host = new RecordingHost();
        const second = await start(server, host, { resume: true });
        second.restoreProgress(saved);
        await expect(second.resumeTurn()).resolves.toEqual({ reason: 'stop' });
        expect(host.texts).toEqual([', world']);
        expect(host.ofType('tool.started')).toEqual([]);
        expect(host.ofType('tool.completed')).toHaveLength(1);
        expect(host.ofType('usage.updated')).toHaveLength(1);
        const count = host.events.length;
        await second.resumeTurn();
        expect(host.events.length).toBe(count);
        await second.close();
    });

    test('a retry after a failed resume repeats no tool or usage event', async () => {
        const server = new FakeOpenCodeV2Server();
        server.transcript = finishedTranscript('msg_input_1');
        const host = new RecordingHost();
        host.failOnce.add('usage.updated');
        const session = await start(server, host, { resume: true });
        await expect(session.resumeTurn()).rejects.toThrow('host storage failed');
        expect(host.ofType('usage.updated')).toEqual([]);
        await expect(session.resumeTurn()).resolves.toEqual({ reason: 'stop' });
        expect(host.texts).toEqual(['Hello, world']);
        expect(host.ofType('tool.started')).toHaveLength(1);
        expect(host.ofType('usage.updated')).toHaveLength(1);
        expect(session.progress().finishedSteps).toEqual(['answer_msg_input_1:finish']);
        await session.close();
    });

    for (const [outcome, settle] of [
        ['interrupted', { resolves: { reason: 'cancelled' } }],
        ['failed', { rejects: 'OpenCode session failed' }],
    ] as const) {
        test(`settles from a transcript whose execution ${outcome}`, async () => {
            const server = new FakeOpenCodeV2Server();
            server.transcript = [
                { id: 'msg_input_1', type: 'user', text: 'work' },
                { id: 'answer_1', type: 'assistant', content: [] },
                { id: 'idle_1', type: 'idle', outcome },
            ];
            const session = await start(server, new RecordingHost(), { resume: true });
            const resumed = session.resumeTurn();
            if ('resolves' in settle)
                await expect(resumed).resolves.toEqual(settle.resolves);
            else await expect(resumed).rejects.toThrow(settle.rejects);
            await session.close();
        });
    }

    test('follows a running turn without repeating text the transcript holds', async () => {
        const server = new FakeOpenCodeV2Server();
        server.transcript = [
            { id: 'msg_input_1', type: 'user', text: 'work' },
            {
                id: 'answer_msg_input_1',
                type: 'assistant',
                content: [{ type: 'text', text: 'Hello again' }],
            },
        ];
        // Generated before the read was answered, so it is in the transcript too.
        server.onTranscriptRead = () =>
            server.emit('session.text.delta', {
                assistantMessageID: 'answer_msg_input_1',
                ordinal: 0,
                delta: ' again',
            });
        const host = new RecordingHost();
        const session = await start(server, host, { resume: true });
        const resumed = session.resumeTurn();
        await Bun.sleep(5);
        expect(await settled(resumed)).toBeFalse();
        server.emit('session.text.delta', {
            assistantMessageID: 'answer_msg_input_1',
            ordinal: 0,
            delta: '!',
        });
        server.finish('answer_msg_input_1');
        server.emit('session.execution.succeeded', {});
        await expect(resumed).resolves.toEqual({ reason: 'stop' });
        expect(host.texts.join('')).toBe('Hello again!');
        await session.close();
    });

    test('asks again for a form OpenCode still waits on', async () => {
        const server = new FakeOpenCodeV2Server();
        server.transcript = [{ id: 'msg_input_1', type: 'user', text: 'work' }];
        server.pendingForms = [
            {
                id: 'form_waiting',
                sessionID: 'ses_native_1',
                title: 'Choose',
                fields: [
                    {
                        key: 'target',
                        type: 'string',
                        title: 'Target',
                        options: [{ value: 'prod', label: 'Production' }],
                    },
                ],
            },
        ];
        server.onFormReply = () => server.completeTurn('Resumed', 'msg_input_1');
        const host = new RecordingHost();
        host.answer = () => ({ outcome: 'answered', answers: [['Production']] });
        const session = await start(server, host, { resume: true });
        await expect(session.resumeTurn()).resolves.toEqual({ reason: 'stop' });
        expect(host.questions.map((question) => question.id)).toEqual(['form_waiting']);
        expect(server.formReplies.map((reply) => reply.body)).toEqual([
            { answer: { target: 'prod' } },
        ]);
        expect(
            server.requests
                .filter((request) => request.path === '/api/form')
                .map((request) => request.query.get('location[directory]'))
        ).toEqual(['/workspace']);
        await session.close();
    });
});

describe('OpenCode 2 child sessions', () => {
    test('streams descendant tools and usage once without completing the parent', async () => {
        const server = new FakeOpenCodeV2Server();
        const host = new RecordingHost();
        const session = await start(server, host);
        server.onPrompt = () => {
            server.emit('session.created', {
                info: { id: 'ses_child', parentID: 'ses_native_1' },
            });
            server.emit('session.created', {
                info: { id: 'ses_grandchild', parentID: 'ses_child' },
            });
            for (const sessionID of ['ses_grandchild', 'ses_unrelated']) {
                const child = { sessionID, assistantMessageID: `child_${sessionID}` };
                server.emit('session.step.started', child);
                server.emit('session.text.started', { ...child, ordinal: 0 });
                server.emit('session.text.ended', {
                    ...child,
                    ordinal: 0,
                    text: 'Not the parent answer',
                });
                server.emit('session.tool.input.started', {
                    ...child,
                    id: 'call_1',
                    name: 'read',
                });
                server.emit('session.tool.called', {
                    ...child,
                    id: 'call_1',
                    input: { filePath: '/outside/file.ts' },
                });
                server.emit('session.tool.success', { ...child, id: 'call_1' });
                const step = {
                    ...child,
                    finish: 'stop',
                    cost: sessionID === 'ses_unrelated' ? 100 : 0.5,
                    tokens: { total: 100 },
                };
                server.emit('session.step.ended', step);
                server.emit('session.step.ended', step);
                server.emit('session.execution.succeeded', { sessionID });
            }
        };
        const turn = session.prompt('delegate');
        await until(() => host.ofType('usage.updated').length > 0);
        await Bun.sleep(10);
        expect(await settled(turn)).toBeFalse();
        expect(host.ofType('usage.updated')).toEqual([
            {
                type: 'usage.updated',
                data: {
                    kind: 'delta',
                    total_tokens: 100,
                    cost_usd: 0.5,
                    native_session_id: 'ses_grandchild',
                },
            },
        ]);
        expect(host.ofType('tool.completed').map((event) => event.data.id)).toEqual([
            'ses_grandchild:call_1',
        ]);
        expect(host.texts).toEqual([]);
        server.completeTurn('Parent answer');
        await expect(turn).resolves.toEqual({ reason: 'stop' });
        expect(host.texts).toEqual(['Parent answer']);
        await session.close();
    });

    test('resolves resumed child ancestry and surfaces its permissions and forms', async () => {
        const server = new FakeOpenCodeV2Server();
        server.sessions.set('ses_child', { id: 'ses_child', parentID: 'ses_native_1' });
        const host = new RecordingHost();
        const session = await start(server, host);
        server.onPrompt = () => {
            server.emit(
                'permission.asked',
                permission('child_permission', { sessionID: 'ses_child', save: [] })
            );
            server.emitForm(
                'child_form',
                [
                    {
                        key: 'continue',
                        type: 'string',
                        title: 'Continue?',
                        options: [{ value: 'yes', label: 'Yes' }],
                    },
                ],
                'ses_child'
            );
        };
        server.onFormReply = () => server.completeTurn('done');
        await session.prompt('delegate');
        await session.close();

        expect(host.permissions.map((request) => request.id)).toEqual([
            'child_permission',
        ]);
        expect(host.questions.map((request) => request.id)).toEqual(['child_form']);
        expect(server.permissionReplies).toEqual([
            {
                path: '/api/session/ses_child/permission/child_permission/reply',
                body: { decision: 'once' },
            },
        ]);
        expect(server.formReplies).toEqual([
            { path: '/api/session/ses_child/form/child_form', method: 'DELETE' },
        ]);
    });
});

describe('OpenCode 2 unrecognized events', () => {
    test('reduce to their type, while status and look-alike names stay silent', async () => {
        const server = new FakeOpenCodeV2Server();
        const host = new RecordingHost();
        const session = await start(server, host);
        server.onPrompt = () => {
            server.emit('future.event', { secret: 'MUST_NOT_RENDER_CREDENTIAL' });
            server.emit('session.status', { status: 'busy' });
            server.emit('session.updated', { info: { id: 'ses_native_1' } });
            // Names the adapter uses inside must not act when OpenCode 2 sends them.
            server.emit('session.error', { error: { message: 'not a failure' } });
            server.emit('message.updated', { info: { id: 'x', role: 'assistant' } });
            server.emit('future.event', { sessionID: 'ses_other' });
            server.emit('session.tool.input.delta', {
                assistantMessageID: 'unknown_message',
                delta: '{',
            });
            server.completeTurn('done');
        };
        await expect(session.prompt('future event')).resolves.toEqual({
            reason: 'stop',
        });
        await session.close();

        expect(host.ofType('runner.event')).toEqual([
            { type: 'runner.event', data: { native_type: 'future.event' } },
        ]);
        expect(JSON.stringify(host.events)).not.toContain('MUST_NOT_RENDER');
        // Another session's unrecognized event costs no ancestry lookup.
        expect(server.requests.map((request) => request.path)).not.toContain(
            '/api/session/ses_other'
        );
    });
});
