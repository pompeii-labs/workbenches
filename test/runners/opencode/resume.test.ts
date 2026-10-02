import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { OpenCodeServerSession } from '../../../src/runners/opencode/session.js';
import type {
    RunnerPermissionDecision,
    RunnerPermissionRequest,
    RunnerSessionHost,
} from '../../../src/runners/session.js';
import type { WorkbenchEventDraft } from '../../../src/runs/index.js';
import {
    contractToolPart,
    FakeOpenCodeServer,
    fixtureConfiguration,
    fixtureWorkbench,
    settled,
} from './fixture.js';

const root = await mkdtemp(join(tmpdir(), 'opencode-resume-'));
const packageDirectory = join(root, '.workbenches', 'core');
await mkdir(packageDirectory, { recursive: true });
await writeFile(join(packageDirectory, 'instructions.md'), '# OpenCode instructions\n');
afterAll(() => rm(root, { recursive: true, force: true }));

const workbench = fixtureWorkbench(packageDirectory, root);

/** A host that records events and lets a test fail or answer what it is asked. */
class RecordingHost implements RunnerSessionHost {
    readonly events: WorkbenchEventDraft[] = [];
    /** Event types whose next emit throws, once each, without recording the event. */
    readonly failOnce = new Set<string>();
    /** Storing this output text fails, once, after `textGate` settles. */
    failText: string | undefined;
    textGate: Promise<void> | undefined;
    /** Permission ids that are never answered. */
    readonly unanswered = new Set<string>();
    readonly permissions: string[] = [];

    async emit(event: WorkbenchEventDraft): Promise<void> {
        if (this.failOnce.delete(event.type)) throw new Error('host storage failed');
        if (this.failText !== undefined && event.data.text === this.failText) {
            this.failText = undefined;
            await this.textGate;
            throw new Error('host storage failed');
        }
        this.events.push(event);
    }

    async requestPermission(
        request: RunnerPermissionRequest
    ): Promise<RunnerPermissionDecision> {
        this.permissions.push(request.id);
        if (this.unanswered.has(request.id)) return new Promise(() => {});
        return 'allow_once';
    }

    async requestQuestion() {
        return { outcome: 'rejected' as const };
    }

    ofType(type: string) {
        return this.events.filter((event) => event.type === type);
    }

    get texts() {
        return this.ofType('output.text').map((event) => event.data.text);
    }
}

const start = async (server: FakeOpenCodeServer, host: RecordingHost) =>
    (await server.adapter().start({
        workbench,
        workspaceDirectory: '/workspace',
        environment: {},
        configuration: fixtureConfiguration(workbench),
        host,
        session: {
            id: 'session_fixture',
            directory: '/tmp/session-fixture',
            nativeSessionId: 'ses_native_1',
        },
    })) as OpenCodeServerSession;

/** What the server holds once the turn has finished. */
function finishedTranscript(input: string, text = 'Hello, world') {
    return [
        { info: { id: input, role: 'user' }, parts: [] },
        {
            info: {
                id: 'message_1',
                role: 'assistant',
                parentID: input,
                finish: 'stop',
                time: { created: 1, completed: 2 },
            },
            parts: [
                { id: 'step_start_1', messageID: 'message_1', type: 'step-start' },
                {
                    id: 'part_message_1',
                    messageID: 'message_1',
                    type: 'text',
                    text,
                },
                { ...contractToolPart('completed'), id: 'tool_part_1' },
                {
                    id: 'finish_1',
                    messageID: 'message_1',
                    type: 'step-finish',
                    reason: 'stop',
                    tokens: { total: 12, input: 5, output: 7 },
                    cost: 0.001,
                },
            ],
        },
    ];
}

/** A turn that dropped its stream after `Hello` and a running tool call. */
function dropAfterHello(server: FakeOpenCodeServer) {
    server.onPrompt = () => {
        server.emit('session.status', { status: { type: 'busy' } });
        server.emitAssistantText('message_1', server.currentInputMessageId(), 'Hello');
        server.emit('message.part.updated', {
            part: contractToolPart('running'),
        });
        // The connection drops here. The rest of the turn happens unseen.
        setTimeout(() => server.failEventStream(), 5);
    };
}

describe('OpenCode turn resume', () => {
    test('delivers output and usage produced while the stream was down, once and in order', async () => {
        const server = new FakeOpenCodeServer();
        const host = new RecordingHost();
        const session = await start(server, host);
        dropAfterHello(server);
        await expect(session.prompt('work')).rejects.toThrow(
            'OpenCode event stream failed'
        );
        expect(host.texts).toEqual(['Hello']);
        expect(host.ofType('tool.started')).toHaveLength(1);

        server.transcript = finishedTranscript(server.currentInputMessageId());
        await expect(session.resumeTurn()).resolves.toEqual({ reason: 'stop' });

        expect(server.eventSubscriptions).toBe(2);
        expect(host.texts).toEqual(['Hello', ', world']);
        // The tool call started before the drop is not reported again.
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
        expect(host.ofType('output.text').map((event) => event.data.id)).toEqual([
            'output_message_1',
            'output_message_1',
        ]);
        expect(session.progress().text).toEqual({ part_message_1: 12 });
        await session.close();
    });

    test('recovers from a stream that ended without an error', async () => {
        const server = new FakeOpenCodeServer();
        const host = new RecordingHost();
        const session = await start(server, host);
        server.onPrompt = () => {
            server.emit('session.status', { status: { type: 'busy' } });
            server.emitAssistantText(
                'message_1',
                server.currentInputMessageId(),
                'Hello'
            );
            server.endEventStream();
        };
        const turn = session.prompt('work');
        await server.prompted;
        await Bun.sleep(5);
        // Nothing failed, and nothing will ever arrive on this stream.
        expect(await settled(turn)).toBe(false);
        server.transcript = finishedTranscript(server.currentInputMessageId());
        // The catch-up settles the prompt that was waiting.
        await expect(session.resumeTurn()).resolves.toEqual({ reason: 'stop' });
        await expect(turn).resolves.toEqual({ reason: 'stop' });
        expect(host.texts).toEqual(['Hello', ', world']);
        expect(server.eventSubscriptions).toBe(2);
        await session.close();
    });

    test('a fresh session replays the whole turn', async () => {
        const server = new FakeOpenCodeServer();
        server.transcript = finishedTranscript('msg_input_1');
        const host = new RecordingHost();
        const session = await start(server, host);

        await expect(session.resumeTurn()).resolves.toEqual({ reason: 'stop' });

        expect(host.texts).toEqual(['Hello, world']);
        expect(host.ofType('usage.updated')).toHaveLength(1);
        await session.close();
    });

    test('progress survives a restart: a session given the saved progress emits only what is new', async () => {
        const server = new FakeOpenCodeServer();
        const firstHost = new RecordingHost();
        const first = await start(server, firstHost);
        dropAfterHello(server);
        await expect(first.prompt('work')).rejects.toThrow('event stream failed');
        // The host saves progress, through JSON as a store would hold it.
        const saved = JSON.parse(JSON.stringify(first.progress()));
        expect(saved).toEqual({
            sessionId: 'ses_native_1',
            inputMessageId: server.currentInputMessageId(),
            text: { part_message_1: 5 },
            startedTools: ['call_contract'],
            completedTools: [],
            finishedSteps: [],
        });

        // The engine restarts. The turn finishes while it is down.
        server.transcript = finishedTranscript(server.currentInputMessageId());
        const secondHost = new RecordingHost();
        const second = await start(server, secondHost);
        second.restoreProgress(saved);
        await expect(second.resumeTurn()).resolves.toEqual({ reason: 'stop' });

        expect(secondHost.texts).toEqual([', world']);
        expect(secondHost.ofType('tool.started')).toEqual([]);
        expect(secondHost.ofType('tool.completed')).toHaveLength(1);
        expect(secondHost.ofType('usage.updated')).toHaveLength(1);
        // Progress round trips, and a restored session that resumes again adds nothing.
        expect(second.progress().text).toEqual({ part_message_1: 12 });
        const count = secondHost.events.length;
        await second.resumeTurn();
        expect(secondHost.events.length).toBe(count);
        // The first session's server is the one the fake replaced, so only the
        // second needs closing.
        await second.close();
    });

    test('restoring progress refuses another session or another turn', async () => {
        const server = new FakeOpenCodeServer();
        const session = await start(server, new RecordingHost());
        const empty = {
            text: {},
            startedTools: [],
            completedTools: [],
            finishedSteps: [],
        };
        expect(() =>
            session.restoreProgress({ ...empty, sessionId: 'ses_other' })
        ).toThrow('belongs to session ses_other, not ses_native_1');
        server.onPrompt = () => server.completeTurn('done');
        await session.prompt('work');
        expect(() =>
            session.restoreProgress({
                ...empty,
                sessionId: 'ses_native_1',
                inputMessageId: 'msg_other',
            })
        ).toThrow('belongs to turn msg_other');
        // Progress of the turn the session is tracking is accepted.
        session.restoreProgress(session.progress());
        await session.close();
    });

    test('a failed resubscribe leaves the session failed, so a later prompt rejects at once', async () => {
        const server = new FakeOpenCodeServer();
        const session = await start(server, new RecordingHost());
        server.onPrompt = () => {
            server.emit('session.status', { status: { type: 'busy' } });
            setTimeout(() => server.failEventStream(), 5);
        };
        await expect(session.prompt('work')).rejects.toThrow(
            'OpenCode event stream failed'
        );

        server.eventStatus = 503;
        await expect(session.resumeTurn()).rejects.toThrow(
            'OpenCode event stream failed with HTTP 503'
        );
        await expect(session.prompt('next')).rejects.toThrow(
            'OpenCode event stream failed with HTTP 503'
        );

        // The stream comes back, and a later catch-up recovers the session.
        server.eventStatus = 200;
        server.transcript = finishedTranscript(server.currentInputMessageId());
        await expect(session.resumeTurn()).resolves.toEqual({ reason: 'stop' });
        await session.close();
    });

    test('a failed transcript read leaves the session failed, so a later prompt rejects at once', async () => {
        const server = new FakeOpenCodeServer();
        const session = await start(server, new RecordingHost());
        server.onTranscriptRead = () => {
            throw new Error('transcript unavailable');
        };
        await expect(session.resumeTurn()).rejects.toThrow('transcript unavailable');
        await expect(session.prompt('next')).rejects.toThrow('transcript unavailable');
        await session.close();
    });

    test('resuming a finished turn again reports nothing new', async () => {
        const server = new FakeOpenCodeServer();
        server.transcript = finishedTranscript('msg_input_1');
        const host = new RecordingHost();
        const session = await start(server, host);
        await session.resumeTurn();
        const before = host.events.length;
        await expect(session.resumeTurn()).resolves.toEqual({ reason: 'stop' });
        expect(host.events.length).toBe(before);
        await session.close();
    });

    test('follows a turn that is still running and adds only what is new', async () => {
        const server = new FakeOpenCodeServer();
        const host = new RecordingHost();
        const session = await start(server, host);
        server.transcript = [
            { info: { id: 'msg_input_1', role: 'user' }, parts: [] },
            {
                info: {
                    id: 'message_1',
                    role: 'assistant',
                    parentID: 'msg_input_1',
                    time: { created: 1 },
                },
                parts: [
                    {
                        id: 'part_message_1',
                        messageID: 'message_1',
                        type: 'text',
                        text: 'Hello',
                    },
                ],
            },
        ];
        const resumed = session.resumeTurn();
        await Bun.sleep(5);
        expect(await settled(resumed)).toBe(false);
        expect(host.texts).toEqual(['Hello']);

        server.emit('message.part.delta', {
            messageID: 'message_1',
            partID: 'part_message_1',
            field: 'text',
            delta: ', world',
        });
        server.emit('message.part.updated', {
            part: {
                id: 'finish_1',
                messageID: 'message_1',
                type: 'step-finish',
                reason: 'stop',
                tokens: { total: 3 },
            },
        });
        server.emit('session.status', { status: { type: 'idle' } });
        await expect(resumed).resolves.toEqual({ reason: 'stop' });
        expect(host.texts).toEqual(['Hello', ', world']);
        expect(host.ofType('usage.updated')).toHaveLength(1);
        await session.close();
    });

    test('does not repeat a delta that the transcript already holds', async () => {
        const server = new FakeOpenCodeServer();
        const host = new RecordingHost();
        const session = await start(server, host);
        server.transcript = [
            { info: { id: 'msg_input_1', role: 'user' }, parts: [] },
            {
                info: {
                    id: 'message_1',
                    role: 'assistant',
                    parentID: 'msg_input_1',
                    time: { created: 1 },
                },
                parts: [
                    {
                        id: 'part_message_1',
                        messageID: 'message_1',
                        type: 'text',
                        text: 'Hello again',
                    },
                ],
            },
        ];
        // The server generated " again" before it answered the transcript request,
        // so it arrives on the stream as well as in the transcript.
        server.onTranscriptRead = () =>
            server.emit('message.part.delta', {
                messageID: 'message_1',
                partID: 'part_message_1',
                field: 'text',
                delta: ' again',
            });
        const resumed = session.resumeTurn();
        await Bun.sleep(5);
        server.emit('message.part.delta', {
            messageID: 'message_1',
            partID: 'part_message_1',
            field: 'text',
            delta: '!',
        });
        server.emit('message.part.updated', {
            part: {
                id: 'finish_1',
                messageID: 'message_1',
                type: 'step-finish',
                reason: 'stop',
            },
        });
        server.emit('session.status', { status: { type: 'idle' } });
        await resumed;
        expect(host.texts.join('')).toBe('Hello again!');
        await session.close();
    });

    test('ends as cancelled when the transcript shows an aborted message', async () => {
        const server = new FakeOpenCodeServer();
        server.transcript = [
            { info: { id: 'msg_input_1', role: 'user' }, parts: [] },
            {
                info: {
                    id: 'message_1',
                    role: 'assistant',
                    parentID: 'msg_input_1',
                    error: { name: 'MessageAbortedError' },
                    time: { created: 1, completed: 2 },
                },
                parts: [],
            },
        ];
        const session = await start(server, new RecordingHost());
        await expect(session.resumeTurn()).resolves.toEqual({ reason: 'cancelled' });
        await session.close();
    });

    test('fails when the transcript shows a provider error', async () => {
        const server = new FakeOpenCodeServer();
        server.transcript = [
            { info: { id: 'msg_input_1', role: 'user' }, parts: [] },
            {
                info: {
                    id: 'message_1',
                    role: 'assistant',
                    parentID: 'msg_input_1',
                    error: { name: 'ProviderAuthError' },
                    time: { created: 1, completed: 2 },
                },
                parts: [],
            },
        ];
        const session = await start(server, new RecordingHost());
        await expect(session.resumeTurn()).rejects.toThrow('OpenCode session failed');
        await session.close();
    });

    test('rejects when the input message is not in the transcript', async () => {
        const server = new FakeOpenCodeServer();
        server.transcript = finishedTranscript('msg_input_1');
        const session = await start(server, new RecordingHost());
        await expect(
            session.resumeTurn({ inputMessageId: 'msg_stale' })
        ).rejects.toThrow('no turn to resume for message msg_stale');
        // The session stays usable: the stale id is the caller's mistake, not a failure.
        await expect(session.resumeTurn()).resolves.toEqual({ reason: 'stop' });
        await session.close();
    });

    test('needs a turn to resume and an open session', async () => {
        const server = new FakeOpenCodeServer();
        const session = await start(server, new RecordingHost());
        await expect(session.resumeTurn()).rejects.toThrow('no turn to resume');
        await session.close();
        await expect(session.resumeTurn()).rejects.toThrow('closed');
    });

    test('a failed resume settles its turn, so a request it was waiting on ends and the next prompt is served', async () => {
        const server = new FakeOpenCodeServer();
        const host = new RecordingHost();
        host.unanswered.add('perm_old');
        const session = await start(server, host);
        server.transcript = [
            { info: { id: 'msg_input_1', role: 'user' }, parts: [] },
            {
                info: {
                    id: 'message_1',
                    role: 'assistant',
                    parentID: 'msg_input_1',
                    time: { created: 1 },
                },
                parts: [
                    {
                        id: 'part_message_1',
                        messageID: 'message_1',
                        type: 'text',
                        text: 'Hello',
                    },
                ],
            },
        ];
        // While the transcript is read, a permission request and more text arrive.
        server.onTranscriptRead = () => {
            server.emit('permission.asked', {
                id: 'perm_old',
                permission: 'external_directory',
                patterns: ['/outside/*'],
                always: [],
            });
            server.emit('message.part.delta', {
                messageID: 'message_1',
                partID: 'part_message_1',
                field: 'text',
                delta: ', world',
            });
        };
        // Storing the text that follows the transcript's fails, but only once the
        // permission request is waiting on the host.
        host.failText = ', world';
        let release!: () => void;
        host.textGate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const resumed = session.resumeTurn().catch((error: Error) => error);
        for (let tries = 0; tries < 200 && host.permissions.length === 0; tries++) {
            await Bun.sleep(1);
        }
        expect(host.permissions).toEqual(['perm_old']);
        release();
        expect(String(await resumed)).toContain('host storage failed');

        // The next turn asks for a permission, which must reach the host and be answered.
        server.onTranscriptRead = undefined;
        server.onPrompt = () => {
            server.emit('session.status', { status: { type: 'busy' } });
            server.emit('permission.asked', {
                id: 'perm_new',
                permission: 'external_directory',
                patterns: ['/outside/*'],
                always: [],
            });
        };
        server.onPermissionReply = () => server.completeTurn('approved');
        await expect(session.prompt('next')).resolves.toEqual({ reason: 'stop' });
        expect(host.permissions).toEqual(['perm_old', 'perm_new']);
        await session.close();
    });

    test('two overlapping resumes share one catch-up and deliver events once', async () => {
        const server = new FakeOpenCodeServer();
        server.transcript = finishedTranscript('msg_input_1');
        const host = new RecordingHost();
        const session = await start(server, host);
        let release!: () => void;
        server.transcriptGate = new Promise<void>((resolve) => {
            release = resolve;
        });

        const first = session.resumeTurn();
        const second = session.resumeTurn();
        expect(second).toBe(first);
        release();
        await expect(first).resolves.toEqual({ reason: 'stop' });
        await expect(second).resolves.toEqual({ reason: 'stop' });

        expect(server.transcriptReads).toBe(1);
        // The session's own stream, and the one the catch-up opened.
        expect(server.eventSubscriptions).toBe(2);
        expect(host.texts).toEqual(['Hello, world']);
        expect(host.ofType('usage.updated')).toHaveLength(1);
        await session.close();
    });

    test('closing during the transcript read ends the resume and leaves nothing running', async () => {
        const server = new FakeOpenCodeServer();
        server.transcript = finishedTranscript('msg_input_1');
        const host = new RecordingHost();
        const session = await start(server, host);
        let release!: () => void;
        server.transcriptGate = new Promise<void>((resolve) => {
            release = resolve;
        });

        const resumed = session.resumeTurn();
        await Bun.sleep(5);
        expect(server.transcriptReads).toBe(1);
        const closing = session.close();
        release();
        await expect(resumed).rejects.toThrow('closed');
        await closing;

        // It began no turn: nothing was emitted, and no stream is left open.
        expect(host.events).toEqual([]);
        expect(server.openEventStreams).toBe(0);
        expect(server.eventSubscriptions).toBe(2);
        await expect(session.resumeTurn()).rejects.toThrow('closed');
        expect(server.eventSubscriptions).toBe(2);
    });

    test('a steering input sent before the drop is answered during the gap and the turn follows it', async () => {
        const server = new FakeOpenCodeServer();
        const host = new RecordingHost();
        const session = await start(server, host);
        let prompts = 0;
        server.onPrompt = () => {
            prompts += 1;
            if (prompts > 1) return;
            server.emit('session.status', { status: { type: 'busy' } });
            server.emitAssistantText(
                'message_1',
                server.currentInputMessageId(),
                'One'
            );
        };
        // Outcomes are read after the drop, because a rejects assertion on a promise
        // that is still pending would wait for it.
        const turn = session.prompt('work').catch((error: Error) => error);
        await server.prompted;
        await Bun.sleep(5);
        const { delivered } = await session.steer('more');
        const steering = delivered.catch((error: Error) => error);
        server.failEventStream();
        expect(String(await turn)).toContain('event stream failed');
        expect(await steering).toBeInstanceOf(Error);
        expect(host.texts).toEqual(['One']);

        const main = String(server.promptBodies[0]?.messageID);
        const steer = String(server.promptBodies[1]?.messageID);
        server.transcript = [
            { info: { id: main, role: 'user' }, parts: [] },
            {
                info: {
                    id: 'message_1',
                    role: 'assistant',
                    parentID: main,
                    finish: 'tool-calls',
                    time: { created: 1, completed: 2 },
                },
                parts: [
                    {
                        id: 'part_message_1',
                        messageID: 'message_1',
                        type: 'text',
                        text: 'One',
                    },
                ],
            },
            // The next user message is the steering input, not another turn.
            { info: { id: steer, role: 'user' }, parts: [] },
            {
                info: {
                    id: 'message_2',
                    role: 'assistant',
                    parentID: steer,
                    finish: 'stop',
                    time: { created: 3, completed: 4 },
                },
                parts: [
                    {
                        id: 'part_message_2',
                        messageID: 'message_2',
                        type: 'text',
                        text: 'Two',
                    },
                ],
            },
        ];
        await expect(session.resumeTurn()).resolves.toEqual({ reason: 'stop' });
        expect(host.texts).toEqual(['One', 'Two']);
        await session.close();
    });

    test('the turn is not finished while its last steering input is unanswered', async () => {
        const server = new FakeOpenCodeServer();
        const host = new RecordingHost();
        const session = await start(server, host);
        let prompts = 0;
        server.onPrompt = () => {
            prompts += 1;
            if (prompts > 1) return;
            server.emit('session.status', { status: { type: 'busy' } });
            server.emitAssistantText(
                'message_1',
                server.currentInputMessageId(),
                'One'
            );
        };
        const turn = session.prompt('work').catch((error: Error) => error);
        await server.prompted;
        await Bun.sleep(5);
        const { delivered } = await session.steer('more');
        const steering = delivered.catch((error: Error) => error);
        server.failEventStream();
        expect(String(await turn)).toContain('event stream failed');
        expect(await steering).toBeInstanceOf(Error);

        const main = String(server.promptBodies[0]?.messageID);
        const steer = String(server.promptBodies[1]?.messageID);
        // The first answer finished, but the steering input after it has no answer yet.
        server.transcript = [
            { info: { id: main, role: 'user' }, parts: [] },
            {
                info: {
                    id: 'message_1',
                    role: 'assistant',
                    parentID: main,
                    finish: 'stop',
                    time: { created: 1, completed: 2 },
                },
                parts: [
                    {
                        id: 'part_message_1',
                        messageID: 'message_1',
                        type: 'text',
                        text: 'One',
                    },
                ],
            },
            { info: { id: steer, role: 'user' }, parts: [] },
        ];
        const resumed = session.resumeTurn();
        await Bun.sleep(5);
        expect(await settled(resumed)).toBe(false);

        server.emitAssistantText('message_2', steer, 'Two');
        server.emit('message.part.updated', {
            part: {
                id: 'finish_2',
                messageID: 'message_2',
                type: 'step-finish',
                reason: 'stop',
            },
        });
        server.emit('session.status', { status: { type: 'idle' } });
        await expect(resumed).resolves.toEqual({ reason: 'stop' });
        expect(host.texts).toEqual(['One', 'Two']);
        await session.close();
    });

    test('a retry after a failed resume does not repeat tool or usage events, and progress shows what was emitted', async () => {
        const server = new FakeOpenCodeServer();
        server.transcript = finishedTranscript('msg_input_1');
        const host = new RecordingHost();
        const session = await start(server, host);
        // Text and the tool call are stored, then storing the usage fails.
        host.failOnce.add('usage.updated');
        await expect(session.resumeTurn()).rejects.toThrow('host storage failed');
        expect(host.texts).toEqual(['Hello, world']);
        expect(host.ofType('tool.started')).toHaveLength(1);
        expect(host.ofType('tool.completed')).toHaveLength(1);
        expect(host.ofType('usage.updated')).toEqual([]);
        expect(session.progress()).toEqual({
            sessionId: 'ses_native_1',
            inputMessageId: 'msg_input_1',
            text: { part_message_1: 12 },
            startedTools: ['call_contract'],
            completedTools: ['call_contract'],
            finishedSteps: [],
        });

        await expect(session.resumeTurn()).resolves.toEqual({ reason: 'stop' });
        expect(host.texts).toEqual(['Hello, world']);
        expect(host.ofType('tool.started')).toHaveLength(1);
        expect(host.ofType('tool.completed')).toHaveLength(1);
        expect(host.ofType('usage.updated')).toHaveLength(1);
        expect(session.progress().finishedSteps).toEqual(['finish_1']);
        await session.close();
    });
});
