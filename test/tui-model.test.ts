import { describe, expect, test } from 'bun:test';

import type { WorkbenchEvent } from '../src/runs/index.js';
import {
    addUserMessage,
    emptyTranscript,
    reduceTranscript,
    reduceTranscriptDuringCancellation,
    TranscriptEventBuffer,
} from '../src/tui/model.js';

describe('TUI transcript model', () => {
    test('coalesces streamed text and updates tool state immutably', () => {
        let state = addUserMessage(emptyTranscript(), 'Inspect this', 'user-1');
        state = reduceTranscript(state, event(1, 'turn.started', { index: 1 }));
        state = reduceTranscript(state, event(2, 'output.text', { text: 'Hello' }));
        state = reduceTranscript(state, event(3, 'output.text', { text: ' world' }));
        state = reduceTranscript(
            state,
            event(4, 'tool.started', {
                id: 'tool-1',
                title: 'Read manifest',
                target: '/repo/workbench.yml',
            })
        );
        state = reduceTranscript(
            state,
            event(5, 'tool.completed', { id: 'tool-1', status: 'completed' })
        );
        state = reduceTranscript(
            state,
            event(6, 'usage.updated', { total_tokens: 42, cost_usd: 0.001 })
        );
        state = reduceTranscript(
            state,
            event(7, 'turn.completed', { reason: 'end_turn' })
        );

        expect(state).toMatchObject({
            busy: false,
            status: 'Ready',
            totalTokens: 42,
            costUsd: 0.001,
        });
        expect(state.items).toEqual([
            { id: 'user-1', kind: 'user', text: 'Inspect this' },
            { id: 'assistant-2', kind: 'assistant', text: 'Hello world' },
            {
                id: 'tool-1',
                kind: 'tool',
                title: 'Read manifest',
                target: '/repo/workbench.yml',
                status: 'completed',
            },
        ]);
    });

    test('represents ready, failed, cancelled, and failed-tool states', () => {
        let state = reduceTranscript(emptyTranscript(), event(1, 'run.ready', {}));
        expect(state.status).toBe('Ready');

        state = reduceTranscript(
            state,
            event(2, 'tool.started', { id: 'tool-2', name: 'shell_command' })
        );
        state = reduceTranscript(
            state,
            event(3, 'tool.completed', {
                id: 'tool-2',
                status: 'failed',
                message: 'Permission denied',
            })
        );
        expect(state.items.at(-1)).toMatchObject({
            kind: 'tool',
            title: 'Shell command',
            status: 'failed',
            detail: 'Permission denied',
        });

        state = reduceTranscript(
            state,
            event(4, 'input.requested', { message: 'Allow file access?' })
        );
        expect(state).toMatchObject({ busy: true, status: 'Needs permission' });

        state = reduceTranscript(
            state,
            event(5, 'run.failed', { message: 'Runner disconnected' })
        );
        expect(state).toMatchObject({ busy: false, status: 'Failed' });
        expect(state.items.at(-1)).toMatchObject({
            kind: 'notice',
            text: 'Runner disconnected',
            tone: 'error',
        });

        state = reduceTranscript(state, event(6, 'run.cancelled', {}));
        expect(state).toMatchObject({ busy: false, status: 'Cancelled' });
        expect(state.items.at(-1)).toMatchObject({
            kind: 'notice',
            text: 'Turn cancelled',
            tone: 'muted',
        });
        expect(reduceTranscript(state, event(7, 'runner.event', {}))).toBe(state);
    });

    test('distinguishes an interrupted turn from a completed turn', () => {
        const thinking = addUserMessage(emptyTranscript(), 'Stop this turn');
        const interrupted = reduceTranscript(
            thinking,
            event(1, 'turn.completed', { reason: 'cancelled' })
        );

        expect(interrupted).toMatchObject({
            busy: false,
            status: 'Interrupted',
        });
    });

    test('keeps multiple assistant messages from one steered turn separate', () => {
        let state = addUserMessage(emptyTranscript(), 'Start here', 'user-1');
        state = reduceTranscript(
            state,
            event(1, 'output.text', { id: 'output-1', text: 'First reply.' })
        );
        state = addUserMessage(state, 'Change direction', 'user-2');
        state = reduceTranscript(
            state,
            event(2, 'output.text', { id: 'output-1', text: ' Done.' })
        );
        state = reduceTranscript(
            state,
            event(3, 'output.text', { id: 'output-2', text: 'Steered reply.' })
        );

        expect(state.items).toEqual([
            { id: 'user-1', kind: 'user', text: 'Start here' },
            { id: 'output-1', kind: 'assistant', text: 'First reply.' },
            { id: 'user-2', kind: 'user', text: 'Change direction' },
            { id: 'output-1', kind: 'assistant', text: ' Done.' },
            { id: 'output-2', kind: 'assistant', text: 'Steered reply.' },
        ]);
    });

    test('does not regress to thinking while cancellation is pending', () => {
        const cancelling = {
            ...addUserMessage(emptyTranscript(), 'Stop this turn'),
            status: 'Cancelling',
        };
        const delayedStart = reduceTranscriptDuringCancellation(
            cancelling,
            event(1, 'turn.started', { index: 1 })
        );

        expect(delayedStart).toMatchObject({
            busy: true,
            status: 'Cancelling',
        });
    });

    test('batches text deltas but flushes before lifecycle events', () => {
        const callbacks: Array<() => void> = [];
        const consumed: WorkbenchEvent[] = [];
        const buffer = new TranscriptEventBuffer(
            (next) => consumed.push(next),
            40,
            (callback) => {
                callbacks.push(callback);
                return callbacks.length as unknown as ReturnType<typeof setTimeout>;
            },
            () => {}
        );

        buffer.push(event(1, 'output.text', { text: 'Hello' }));
        buffer.push(event(2, 'output.text', { text: ' world' }));
        expect(consumed).toHaveLength(0);
        expect(callbacks).toHaveLength(1);

        callbacks.shift()?.();
        expect(consumed).toHaveLength(1);
        expect(consumed[0]?.data).toEqual({ text: 'Hello world' });

        buffer.push(event(3, 'output.text', { text: 'Before tool' }));
        buffer.push(event(4, 'tool.started', { id: 'tool-1' }));
        expect(consumed.slice(1).map((next) => next.type)).toEqual([
            'output.text',
            'tool.started',
        ]);
        expect(consumed[1]?.data).toEqual({ text: 'Before tool' });

        buffer.push(event(5, 'output.text', { id: 'output-1', text: 'First' }));
        buffer.push(event(6, 'output.text', { id: 'output-2', text: 'Second' }));
        expect(consumed.at(-1)?.data).toEqual({
            id: 'output-1',
            text: 'First',
        });

        buffer.push(event(7, 'output.text', { text: 'discard me' }));
        buffer.dispose();
        callbacks.at(-1)?.();
        expect(consumed).toHaveLength(5);
    });
});

function event(
    sequence: number,
    type: WorkbenchEvent['type'],
    data: unknown
): WorkbenchEvent {
    return {
        protocol: 0,
        run_id: 'wb_test12345678901234567890',
        sequence,
        timestamp: '2026-08-18T00:00:00.000Z',
        type,
        runner: 'opencode',
        data,
    };
}
