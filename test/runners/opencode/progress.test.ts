import { describe, expect, test } from 'bun:test';

import {
    type OpenCodeProgress,
    TurnProgress,
} from '../../../src/runners/opencode/progress.js';
import { createActiveTurn } from '../../../src/runners/opencode/turn.js';
import type { WorkbenchEventDraft } from '../../../src/runs/index.js';

const session = 'ses_1';

function setup(failing: string[] = []) {
    const events: WorkbenchEventDraft[] = [];
    const progress = new TurnProgress({
        emit: async (event) => {
            const at = failing.indexOf(event.type);
            if (at !== -1) {
                failing.splice(at, 1);
                throw new Error('host storage failed');
            }
            events.push(event);
        },
    });
    progress.begin('msg_input');
    const turn = createActiveTurn('msg_input');
    turn.assistantOutputIds.set('message_1', 'output_message_1');
    return { events, progress, turn };
}

const textPart = (text: string) => ({
    id: 'part_1',
    messageID: 'message_1',
    type: 'text',
    text,
});

const toolPart = (status: string) => ({
    type: 'tool',
    messageID: 'message_1',
    tool: 'write',
    callID: 'call_1',
    state: { status, input: { filePath: '/workspace/a.txt' } },
});

const texts = (events: WorkbenchEventDraft[]) =>
    events
        .filter((event) => event.type === 'output.text')
        .map((event) => event.data.text);

describe('TurnProgress', () => {
    test('emits a text part only past what it already emitted', async () => {
        const { events, progress, turn } = setup();
        await progress.part(turn, textPart('Hello'), session);
        await progress.part(turn, textPart('Hello, world'), session);
        await progress.part(turn, textPart('Hello, world'), session);
        expect(texts(events)).toEqual(['Hello', ', world']);
        expect(progress.snapshot(session).text).toEqual({ part_1: 12 });
    });

    test('counts text only after the host stored it', async () => {
        const { events, progress, turn } = setup(['output.text']);
        await expect(progress.part(turn, textPart('Hello'), session)).rejects.toThrow(
            'host storage failed'
        );
        expect(progress.snapshot(session).text).toEqual({});
        // The same part, offered again, is emitted in full.
        await progress.part(turn, textPart('Hello'), session);
        expect(texts(events)).toEqual(['Hello']);
        expect(progress.snapshot(session).text).toEqual({ part_1: 5 });
    });

    test('counts text in UTF-16 code units and does not resend a rewrite', async () => {
        const { events, progress, turn } = setup();
        await progress.part(turn, textPart('a\u{1F600}'), session);
        expect(progress.snapshot(session).text).toEqual({ part_1: 3 });
        // The part now says something else of the same length: nothing is sent.
        await progress.part(turn, textPart('bcd'), session);
        expect(texts(events)).toEqual(['a\u{1F600}']);
    });

    test('ignores a part whose message is not an answer to the turn', async () => {
        const { events, progress, turn } = setup();
        await progress.part(
            turn,
            { ...textPart('stray'), messageID: 'other' },
            session
        );
        expect(events).toEqual([]);
        expect(progress.knowsText('part_1')).toBe(false);
    });

    test('streams a delta after its part is known and counts it', async () => {
        const { events, progress, turn } = setup();
        await progress.part(turn, textPart('Hello'), session);
        expect(progress.knowsText('part_1')).toBe(true);
        await progress.delta('output_message_1', 'part_1', ', world');
        expect(texts(events)).toEqual(['Hello', ', world']);
        expect(progress.snapshot(session).text).toEqual({ part_1: 12 });
    });

    test('reports each tool call once through the adapter', async () => {
        const { events, progress, turn } = setup();
        await progress.part(turn, toolPart('running'), session);
        await progress.part(turn, toolPart('running'), session);
        await progress.part(turn, toolPart('completed'), session);
        expect(events.map((event) => event.type)).toEqual([
            'tool.started',
            'tool.completed',
            'file.changed',
        ]);
        expect(progress.snapshot(session)).toMatchObject({
            startedTools: ['call_1'],
            completedTools: ['call_1'],
        });
    });

    test('a tool part whose events were not all stored is reported again in full', async () => {
        const { events, progress, turn } = setup(['tool.completed']);
        await expect(
            progress.part(turn, toolPart('completed'), session)
        ).rejects.toThrow('host storage failed');
        expect(progress.snapshot(session)).toMatchObject({
            startedTools: [],
            completedTools: [],
        });
        events.length = 0;
        await progress.part(turn, toolPart('completed'), session);
        expect(events.map((event) => event.type)).toEqual([
            'tool.started',
            'tool.completed',
            'file.changed',
        ]);
    });

    test('a snapshot names its session and turn and survives JSON', async () => {
        const first = setup();
        await first.progress.part(first.turn, textPart('Hello'), session);
        await first.progress.part(first.turn, toolPart('running'), session);
        const saved: OpenCodeProgress = JSON.parse(
            JSON.stringify(first.progress.snapshot(session))
        );
        expect(saved).toEqual({
            sessionId: session,
            inputMessageId: 'msg_input',
            text: { part_1: 5 },
            startedTools: ['call_1'],
            completedTools: [],
            finishedSteps: [],
        });

        const second = setup();
        second.progress.restore(saved, session, undefined);
        await second.progress.part(second.turn, textPart('Hello, world'), session);
        await second.progress.part(second.turn, toolPart('completed'), session);
        expect(texts(second.events)).toEqual([', world']);
        expect(second.events.map((event) => event.type)).toEqual([
            'output.text',
            'tool.completed',
            'file.changed',
        ]);
    });

    test('restoring refuses another session or another turn', () => {
        const { progress } = setup();
        const saved: OpenCodeProgress = {
            sessionId: session,
            inputMessageId: 'msg_other',
            text: {},
            startedTools: [],
            completedTools: [],
            finishedSteps: [],
        };
        expect(() => progress.restore(saved, 'ses_2', undefined)).toThrow(
            'belongs to session ses_1, not ses_2'
        );
        expect(() => progress.restore(saved, session, 'msg_input')).toThrow(
            'belongs to turn msg_other, but this session is tracking turn msg_input'
        );
        // With no turn tracked, the snapshot's turn becomes the one tracked.
        progress.restore(saved, session, undefined);
        expect(progress.inputMessageId).toBe('msg_other');
    });

    test('restoring never moves a part backwards and keeps ids already reported', async () => {
        const { progress, turn } = setup();
        await progress.part(turn, textPart('Hello, world'), session);
        await progress.part(turn, toolPart('running'), session);
        progress.restore(
            {
                sessionId: session,
                inputMessageId: 'msg_input',
                text: { part_1: 3 },
                startedTools: ['call_9'],
                completedTools: [],
                finishedSteps: [],
            },
            session,
            'msg_input'
        );
        const snapshot = progress.snapshot(session);
        expect(snapshot.text).toEqual({ part_1: 12 });
        expect([...snapshot.startedTools].sort()).toEqual(['call_1', 'call_9']);
    });

    test('beginning another turn forgets the earlier turn', async () => {
        const { progress, turn } = setup();
        await progress.part(turn, textPart('Hello'), session);
        progress.begin('msg_next');
        expect(progress.snapshot(session)).toEqual({
            sessionId: session,
            inputMessageId: 'msg_next',
            text: {},
            startedTools: [],
            completedTools: [],
            finishedSteps: [],
        });
        expect(progress.knowsText('part_1')).toBe(false);
    });
});
