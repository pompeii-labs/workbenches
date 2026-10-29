import { describe, expect, test } from 'bun:test';

import { ToolDetails } from '../src/runners/details.js';
import { PiEventAdapter } from '../src/runners/pi/events.js';

describe('Pi JSON event normalization', () => {
    test('reports every provider spelling of the output limit as length', () => {
        for (const stopReason of ['length', 'max_tokens']) {
            const adapter = new PiEventAdapter();
            expect(
                adapter.consume({ type: 'turn_end', message: { stopReason } }).events
            ).toEqual([{ type: 'turn.completed', data: { reason: 'length' } }]);
            expect(adapter.summary().completionReason).toBe('length');
        }
    });

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
                args: { path: '/workspace/result.txt', content: 'done\n' },
            }).events,
            ...adapter.consume({
                type: 'tool_execution_end',
                toolCallId: 'call_1',
                toolName: 'write',
                result: {
                    content: [
                        { type: 'text', text: 'Wrote result.txt' },
                        { type: 'image', data: 'MUST_NOT_RENDER_IMAGE_DATA' },
                    ],
                    details: { thinking: 'MUST_NOT_RENDER_REASONING' },
                },
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
                title: 'Write',
                target: '/workspace/result.txt',
                input: { path: '/workspace/result.txt', content: 'done\n' },
            },
        });
        expect(events).toContainEqual({
            type: 'tool.completed',
            data: {
                id: 'call_1',
                name: 'write',
                title: 'Write',
                target: '/workspace/result.txt',
                status: 'completed',
                input: { path: '/workspace/result.txt', content: 'done\n' },
                output: 'Wrote result.txt',
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

    test("diffs an edit against the run's earlier write, or places it at the first changed line", () => {
        const adapter = new PiEventAdapter({
            details: new ToolDetails({ workspace: '/workspace' }),
        });
        const tool = (id: string, toolName: string, args: Record<string, unknown>) => [
            ...adapter.consume({
                type: 'tool_execution_start',
                toolCallId: id,
                toolName,
                args,
            }).events,
            ...adapter.consume({
                type: 'tool_execution_end',
                toolCallId: id,
                toolName,
                result: {
                    content: [{ type: 'text', text: 'ok' }],
                    details: { firstChangedLine: 10 },
                },
                isError: false,
            }).events,
        ];
        tool('call_write', 'write', {
            path: '/workspace/a.txt',
            content: 'one\ntwo\n',
        });
        const known = tool('call_edit', 'edit', {
            path: '/workspace/a.txt',
            oldText: 'two',
            newText: 'three',
        });
        const excerpt = tool('call_other', 'edit', {
            path: '/workspace/b.txt',
            oldText: 'keep\nold',
            newText: 'keep\nnew',
        });

        expect(known.at(-1)?.data).toEqual({
            path: '/workspace/a.txt',
            operation: 'edit',
            patch: '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n',
            additions: 1,
            deletions: 1,
        });
        expect(excerpt.at(-1)?.data).toEqual({
            path: '/workspace/b.txt',
            operation: 'edit',
            patch: '--- a/b.txt\n+++ b/b.txt\n@@ -9,2 +9,2 @@\n keep\n-old\n+new\n',
            additions: 1,
            deletions: 1,
        });
    });

    test('reduces unknown events to a payload-free marker', () => {
        const adapter = new PiEventAdapter();
        expect(
            adapter.consume({ type: 'future.event', credential: 'secret' }).events
        ).toEqual([{ type: 'runner.event', data: { native_type: 'future.event' } }]);
    });
});
