import { describe, expect, test } from 'bun:test';

import { OpenCodeEventAdapter } from '../src/opencode-events.js';

describe('OpenCode event adapter', () => {
    test('normalizes text and terminal usage without retaining provider metadata', () => {
        const adapter = new OpenCodeEventAdapter();
        const text = adapter.consume({
            type: 'text',
            part: {
                type: 'text',
                text: 'Hello',
                metadata: { openrouter: { reasoning_details: ['SECRET_BLOB'] } },
            },
        });
        const finish = adapter.consume({
            type: 'step_finish',
            part: {
                reason: 'stop',
                tokens: {
                    total: 12,
                    input: 5,
                    output: 7,
                    reasoning: 2,
                    cache: { read: 3, write: 4 },
                },
                cost: 0.001,
            },
        });

        expect(text.events).toEqual([{ type: 'output.text', data: { text: 'Hello' } }]);
        expect(finish.events).toEqual([
            {
                type: 'usage.updated',
                data: {
                    kind: 'delta',
                    total_tokens: 12,
                    input_tokens: 5,
                    output_tokens: 7,
                    reasoning_tokens: 2,
                    cache_read_tokens: 3,
                    cache_write_tokens: 4,
                    cost_usd: 0.001,
                },
            },
            { type: 'turn.completed', data: { reason: 'stop' } },
        ]);
        expect(JSON.stringify([text, finish])).not.toContain('SECRET_BLOB');
        expect(adapter.summary()).toEqual({
            finalText: 'Hello',
            turnCompleted: true,
        });
    });

    test('synthesizes safe tool lifecycle and file-change events', () => {
        const adapter = new OpenCodeEventAdapter();
        const result = adapter.consume({
            type: 'tool_use',
            part: {
                tool: 'write',
                callID: 'call_1',
                metadata: { token: 'DO_NOT_KEEP' },
                state: {
                    status: 'completed',
                    input: {
                        filePath: '/repo/README.md',
                        content: 'PRIVATE_FILE_CONTENT',
                    },
                    output: 'PRIVATE_TOOL_OUTPUT',
                    title: 'unsafe runner title',
                    time: { start: 100, end: 125 },
                },
            },
        });

        expect(result.events).toEqual([
            {
                type: 'tool.started',
                data: { id: 'call_1', name: 'write', target: '/repo/README.md' },
            },
            {
                type: 'tool.completed',
                data: {
                    id: 'call_1',
                    name: 'write',
                    target: '/repo/README.md',
                    status: 'completed',
                    duration_ms: 25,
                },
            },
            {
                type: 'file.changed',
                data: { path: '/repo/README.md', operation: 'write' },
            },
        ]);
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain('PRIVATE_FILE_CONTENT');
        expect(serialized).not.toContain('PRIVATE_TOOL_OUTPUT');
        expect(serialized).not.toContain('DO_NOT_KEEP');
        expect(serialized).not.toContain('unsafe runner title');
    });

    test('does not expose shell commands or unknown native payloads', () => {
        const adapter = new OpenCodeEventAdapter();
        const tool = adapter.consume({
            type: 'tool_use',
            part: {
                tool: 'bash',
                callID: 'call_2',
                state: {
                    status: 'completed',
                    input: { command: 'curl -H Authorization:SECRET' },
                    output: 'SECRET_OUTPUT',
                },
            },
        });
        const unknown = adapter.consume({ type: 'future_event', secret: 'VALUE' });

        expect(JSON.stringify(tool)).not.toContain('SECRET');
        expect(unknown.events).toEqual([
            { type: 'runner.event', data: { native_type: 'future_event' } },
        ]);
    });
});
