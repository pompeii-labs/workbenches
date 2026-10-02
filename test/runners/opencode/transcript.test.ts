import { describe, expect, test } from 'bun:test';

import {
    OpenCodeTranscript,
    outputIdFor,
} from '../../../src/runners/opencode/transcript.js';

const user = (id: string) => ({ info: { id, role: 'user' }, parts: [] });

const assistant = (
    id: string,
    parentID: string,
    extra: Record<string, unknown> = {},
    parts: unknown[] = []
) => ({ info: { id, role: 'assistant', parentID, ...extra }, parts });

const delta = (partID: string, text: string) => ({
    type: 'message.part.delta',
    properties: { partID, field: 'text', delta: text },
});

const textPart = (id: string, text: string) => ({ id, type: 'text', text });

describe('OpenCodeTranscript', () => {
    test('treats a body that is not a list as empty', () => {
        expect(new OpenCodeTranscript({ error: 'x' }).latestUserMessageId()).toBe(
            undefined
        );
        expect(new OpenCodeTranscript(null).latestUserMessageId()).toBe(undefined);
    });

    test('finds the latest user message', () => {
        const transcript = new OpenCodeTranscript([
            user('msg_1'),
            assistant('a_1', 'msg_1'),
            user('msg_2'),
        ]);
        expect(transcript.latestUserMessageId()).toBe('msg_2');
    });

    test('lists the answers to one turn and stops at the next user message', () => {
        const transcript = new OpenCodeTranscript([
            user('msg_1'),
            assistant('a_1', 'msg_1'),
            assistant('a_2', 'msg_1'),
            assistant('a_other', 'msg_elsewhere'),
            user('msg_2'),
            assistant('a_3', 'msg_2'),
        ]);
        const ids = (input: string) =>
            transcript.turnOf(input).answers.map((answer) => answer.id);
        expect(ids('msg_1')).toEqual(['a_1', 'a_2']);
        expect(ids('msg_2')).toEqual(['a_3']);
    });

    test('keeps each answer parts and the input it answers', () => {
        const transcript = new OpenCodeTranscript([
            user('msg_1'),
            assistant('a_1', 'msg_1', {}, [textPart('p_1', 'hi')]),
            { info: { id: 'a_2', role: 'assistant', parentID: 'msg_1' } },
        ]);
        const [first, second] = transcript.turnOf('msg_1').answers;
        expect(first?.parts).toEqual([textPart('p_1', 'hi')]);
        expect(first?.parentId).toBe('msg_1');
        expect(second?.parts).toEqual([]);
    });

    test('rejects an input message the transcript does not hold', () => {
        const transcript = new OpenCodeTranscript([user('msg_1')]);
        expect(() => transcript.turnOf('msg_stale')).toThrow(
            'no turn to resume for message msg_stale'
        );
    });

    test('covers the steering inputs of a turn and their answers', () => {
        const transcript = new OpenCodeTranscript([
            user('msg_1'),
            assistant('a_1', 'msg_1'),
            user('steer_1'),
            assistant('a_2', 'steer_1'),
            user('msg_2'),
            assistant('a_3', 'msg_2'),
        ]);
        expect(
            transcript.turnOf('msg_1', ['steer_1']).answers.map((answer) => answer.id)
        ).toEqual(['a_1', 'a_2']);
        // Without the steering input the next user message ends the turn.
        expect(transcript.turnOf('msg_1').answers.map((answer) => answer.id)).toEqual([
            'a_1',
        ]);
    });

    test('judges the end from the latest answer to the last input only', () => {
        const finished = { finish: 'stop', time: { created: 1, completed: 2 } };
        const answered = new OpenCodeTranscript([
            user('msg_1'),
            assistant('a_1', 'msg_1', finished),
            user('steer_1'),
            assistant('a_2', 'steer_1', {
                finish: 'tool-calls',
                time: { completed: 3 },
            }),
        ]);
        expect(answered.turnOf('msg_1', ['steer_1']).end).toBe(undefined);

        const unanswered = new OpenCodeTranscript([
            user('msg_1'),
            assistant('a_1', 'msg_1', finished),
            user('steer_1'),
        ]);
        expect(unanswered.turnOf('msg_1', ['steer_1']).end).toBe(undefined);

        const done = new OpenCodeTranscript([
            user('msg_1'),
            assistant('a_1', 'msg_1', { finish: 'tool-calls', time: { completed: 2 } }),
            user('steer_1'),
            assistant('a_2', 'steer_1', finished),
        ]);
        expect(done.turnOf('msg_1', ['steer_1']).end).toEqual({
            kind: 'completed',
            finish: 'stop',
        });
    });

    test('is cancelled for an aborted message and failed for another error', () => {
        const aborted = new OpenCodeTranscript([
            user('msg_1'),
            assistant('a_1', 'msg_1', { error: { name: 'MessageAbortedError' } }),
        ]);
        expect(aborted.turnOf('msg_1').end).toEqual({ kind: 'cancelled' });
        const failed = new OpenCodeTranscript([
            user('msg_1'),
            assistant('a_1', 'msg_1', { error: { name: 'ProviderAuthError' } }),
        ]);
        expect(failed.turnOf('msg_1').end).toEqual({ kind: 'failed' });
    });

    test('is still running until the message is finished, and when it paused for tool calls', () => {
        const running = new OpenCodeTranscript([
            user('msg_1'),
            assistant('a_1', 'msg_1', { time: { created: 1 } }),
        ]);
        expect(running.turnOf('msg_1').end).toBe(undefined);
        const paused = new OpenCodeTranscript([
            user('msg_1'),
            assistant('a_1', 'msg_1', { finish: 'tool-calls', time: { completed: 2 } }),
        ]);
        expect(paused.turnOf('msg_1').end).toBe(undefined);
    });

    test('drops the leading deltas the transcript text already ends with', () => {
        const transcript = new OpenCodeTranscript([
            user('msg_1'),
            assistant('a_1', 'msg_1', {}, [textPart('p_1', 'Hello again')]),
        ]);
        const held = [delta('p_1', ' again'), delta('p_1', '!'), { type: 'other' }];
        expect(transcript.withoutCoveredDeltas(held)).toEqual([
            delta('p_1', '!'),
            held[2],
        ]);
    });

    test('keeps deltas for a part the transcript does not hold', () => {
        const transcript = new OpenCodeTranscript([user('msg_1')]);
        const held = [delta('p_new', 'x')];
        expect(transcript.withoutCoveredDeltas(held)).toEqual(held);
    });
});

describe('outputIdFor', () => {
    test('derives a stable output id from the native message id', () => {
        expect(outputIdFor('message_1')).toBe('output_message_1');
    });
});
