import { describe, expect, test } from 'bun:test';

import { PiEventAdapter } from '../src/runners/pi/events.js';

describe('Pi JSON event normalization', () => {
    test('streams text while withholding thinking and native snapshots', () => {
        const adapter = new PiEventAdapter();
        const thinking = adapter.consume({
            type: 'message_update',
            assistantMessageEvent: {
                type: 'thinking_delta',
                delta: 'MUST_NOT_RENDER_REASONING',
            },
        });
        const text = adapter.consume({
            type: 'message_start',
            message: { role: 'assistant' },
        });
        const streamed = adapter.consume({
            type: 'message_update',
            assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
            message: { secret: 'MUST_NOT_RENDER_CREDENTIAL' },
        });

        expect(thinking.events).toEqual([]);
        expect(text.events).toEqual([]);
        expect(streamed.events).toEqual([
            {
                type: 'output.text',
                data: {
                    id: expect.stringMatching(/^output_/),
                    text: 'Hello',
                },
            },
        ]);
        expect(JSON.stringify(streamed.events)).not.toContain('MUST_NOT_RENDER');
    });

    test('assigns a distinct output ID to each assistant message', () => {
        const adapter = new PiEventAdapter();
        adapter.consume({ type: 'message_start', message: { role: 'assistant' } });
        const first = adapter.consume({
            type: 'message_update',
            assistantMessageEvent: { type: 'text_delta', delta: 'First' },
        });
        adapter.consume({ type: 'message_end', message: { role: 'assistant' } });
        adapter.consume({ type: 'message_start', message: { role: 'assistant' } });
        const second = adapter.consume({
            type: 'message_update',
            assistantMessageEvent: { type: 'text_delta', delta: 'Second' },
        });

        expect(first.events[0]?.data.id).toMatch(/^output_/);
        expect(second.events[0]?.data.id).toMatch(/^output_/);
        expect(first.events[0]?.data.id).not.toBe(second.events[0]?.data.id);
    });

    test('normalizes tools, file changes, usage, and completion', () => {
        const adapter = new PiEventAdapter();
        const events = [
            ...adapter.consume({
                type: 'tool_execution_start',
                toolCallId: 'call_1',
                toolName: 'write',
                args: {
                    path: '/workspace/result.txt',
                    content: 'MUST_NOT_RENDER_TOOL_OUTPUT',
                },
            }).events,
            ...adapter.consume({
                type: 'tool_execution_end',
                toolCallId: 'call_1',
                toolName: 'write',
                result: { content: 'MUST_NOT_RENDER_TOOL_OUTPUT' },
                isError: false,
            }).events,
            ...adapter.consume({
                type: 'message_end',
                message: {
                    role: 'assistant',
                    usage: {
                        input: 5,
                        output: 7,
                        cacheRead: 2,
                        cacheWrite: 1,
                        totalTokens: 15,
                        cost: { total: 0.001 },
                    },
                },
            }).events,
            ...adapter.consume({
                type: 'turn_end',
                message: { stopReason: 'stop' },
            }).events,
        ];

        expect(events).toContainEqual({
            type: 'tool.started',
            data: {
                id: 'call_1',
                name: 'write',
                target: '/workspace/result.txt',
            },
        });
        expect(events).toContainEqual({
            type: 'tool.completed',
            data: {
                id: 'call_1',
                name: 'write',
                target: '/workspace/result.txt',
                status: 'completed',
            },
        });
        expect(events).toContainEqual({
            type: 'file.changed',
            data: { path: '/workspace/result.txt', operation: 'write' },
        });
        expect(events).toContainEqual({
            type: 'usage.updated',
            data: {
                kind: 'delta',
                total_tokens: 15,
                input_tokens: 5,
                output_tokens: 7,
                cache_read_tokens: 2,
                cache_write_tokens: 1,
                cost_usd: 0.001,
            },
        });
        expect(events).toContainEqual({
            type: 'turn.completed',
            data: { reason: 'stop' },
        });
        expect(JSON.stringify(events)).not.toContain('MUST_NOT_RENDER');
    });

    test('reduces unknown events to a payload-free marker', () => {
        const adapter = new PiEventAdapter();
        expect(
            adapter.consume({ type: 'future.event', credential: 'secret' }).events
        ).toEqual([{ type: 'runner.event', data: { native_type: 'future.event' } }]);
    });
});
