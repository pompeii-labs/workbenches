import { describe, expect, test } from 'bun:test';

import { OpenCodeEventAdapter } from '../src/runners/opencode/events.js';

describe('OpenCode event adapter', () => {
    test('reports a response cut off by the output limit as length', () => {
        const adapter = new OpenCodeEventAdapter();
        expect(
            adapter.consume({ type: 'step_finish', part: { reason: 'max_tokens' } })
                .events
        ).toEqual([{ type: 'turn.completed', data: { reason: 'length' } }]);
        expect(adapter.summary().completionReason).toBe('length');
    });

    test('counts an identified step only once and retains cost without token metadata', () => {
        const adapter = new OpenCodeEventAdapter();
        const step = {
            type: 'step_finish',
            part: { id: 'step_1', reason: 'tool-calls', cost: 0.5 },
        };
        expect(adapter.consume(step).events).toEqual([
            { type: 'usage.updated', data: { kind: 'delta', cost_usd: 0.5 } },
        ]);
        expect(adapter.consume(step).events).toEqual([]);
        expect(
            adapter.consume({ ...step, part: { ...step.part, id: 'step_2' } }).events
        ).toHaveLength(1);
    });

    test('normalizes text and terminal usage without retaining provider metadata', () => {
        const adapter = new OpenCodeEventAdapter();
        const text = adapter.consume({
            type: 'text',
            sessionID: 'ses_123',
            part: {
                id: 'part_123',
                messageID: 'message_123',
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

        expect(text.events).toEqual([
            {
                type: 'output.text',
                data: { id: 'message_123', text: 'Hello' },
            },
        ]);
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
            sessionId: 'ses_123',
            completionReason: 'stop',
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
                data: {
                    id: 'call_1',
                    name: 'write',
                    title: 'Write',
                    target: '/repo/README.md',
                },
            },
            {
                type: 'tool.completed',
                data: {
                    id: 'call_1',
                    name: 'write',
                    title: 'Write',
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

    test('reports the agent plan once when a todo tool call completes', () => {
        const adapter = new OpenCodeEventAdapter();
        const todo = (status: string) => ({
            type: 'tool_use',
            part: {
                tool: 'todowrite',
                callID: 'call_todo',
                state: {
                    status,
                    input: {
                        todos: [
                            {
                                id: '1',
                                content: 'Enlarge the map',
                                status: 'completed',
                                priority: 'high',
                            },
                            {
                                id: '2',
                                content: 'Extend playtest\u001b[31m for pickups',
                                status: 'in_progress',
                            },
                            { id: '3', content: 'Add XP', status: 'pending' },
                            { id: '4', content: 'Old idea', status: 'cancelled' },
                            { id: '5', content: 'Unknown status', status: 'blocked' },
                            { id: '6', content: '   ', status: 'pending' },
                        ],
                    },
                    output: 'PRIVATE_TOOL_OUTPUT',
                },
            },
        });

        expect(
            adapter.consume(todo('running')).events.map((event) => event.type)
        ).toEqual(['tool.started']);
        const completed = adapter.consume(todo('completed')).events;
        expect(completed.map((event) => event.type)).toEqual([
            'tool.completed',
            'plan.updated',
        ]);
        expect(completed[1]).toEqual({
            type: 'plan.updated',
            data: {
                items: [
                    { text: 'Enlarge the map', status: 'completed' },
                    { text: 'Extend playtest for pickups', status: 'in_progress' },
                    { text: 'Add XP', status: 'pending' },
                    { text: 'Old idea', status: 'cancelled' },
                    { text: 'Unknown status', status: 'pending' },
                ],
                completed: 1,
                total: 4,
            },
        });
        expect(JSON.stringify(completed)).not.toContain('PRIVATE_TOOL_OUTPUT');
        expect(adapter.consume(todo('completed')).events).toEqual([]);
    });

    test('reports no plan for a failed todo call or one without a list', () => {
        const adapter = new OpenCodeEventAdapter();
        const failed = adapter.consume({
            type: 'tool_use',
            part: {
                tool: 'todowrite',
                callID: 'call_failed',
                state: {
                    status: 'error',
                    input: { todos: [{ content: 'x', status: 'pending' }] },
                },
            },
        });
        const empty = adapter.consume({
            type: 'tool_use',
            part: {
                tool: 'todowrite',
                callID: 'call_empty',
                state: { status: 'completed', input: {} },
            },
        });
        expect(failed.events.map((event) => event.type)).not.toContain('plan.updated');
        expect(empty.events.map((event) => event.type)).not.toContain('plan.updated');
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

    test('enriches a started tool when the runner later provides its input', () => {
        const adapter = new OpenCodeEventAdapter();
        const started = adapter.consume({
            type: 'tool_use',
            part: {
                tool: 'grep',
                callID: 'call_3',
                state: { status: 'pending' },
            },
        });
        const completed = adapter.consume({
            type: 'tool_use',
            part: {
                tool: 'grep',
                callID: 'call_3',
                state: {
                    status: 'completed',
                    input: { pattern: 'migration', path: '/repo/src' },
                    metadata: { matches: 3 },
                    time: { start: 100, end: 112 },
                },
            },
        });

        expect(started.events).toEqual([
            {
                type: 'tool.started',
                data: { id: 'call_3', name: 'grep', title: 'Grep' },
            },
        ]);
        expect(completed.events).toEqual([
            {
                type: 'tool.completed',
                data: {
                    id: 'call_3',
                    name: 'grep',
                    title: 'Grep "migration"',
                    target: '/repo/src',
                    description: '3 matches',
                    status: 'completed',
                    duration_ms: 12,
                },
            },
        ]);
    });

    test('reports safe permission failures once without exposing native errors', () => {
        const adapter = new OpenCodeEventAdapter();
        const native = {
            type: 'tool_use',
            part: {
                tool: 'read',
                callID: 'call_denied',
                state: {
                    status: 'error',
                    input: { filePath: '/outside/file.ts' },
                    error: 'The user rejected permission. SECRET_NATIVE_DETAIL',
                },
            },
        };
        const first = adapter.consume(native);
        const repeated = adapter.consume(native);

        expect(first.events.at(-1)).toEqual({
            type: 'tool.completed',
            data: {
                id: 'call_denied',
                name: 'read',
                title: 'Read',
                target: '/outside/file.ts',
                status: 'failed',
                error_code: 'permission_denied',
                message: 'Permission denied',
            },
        });
        expect(repeated.events).toEqual([]);
        expect(JSON.stringify([first, repeated])).not.toContain('SECRET_NATIVE_DETAIL');
    });

    test('leaves native question tools to the normalized question lifecycle', () => {
        const adapter = new OpenCodeEventAdapter();
        const result = adapter.consume({
            type: 'tool_use',
            part: {
                tool: 'question',
                callID: 'question_1',
                state: {
                    status: 'error',
                    error: 'Question was answered through the native question endpoint',
                },
            },
        });

        expect(result.events).toEqual([]);
    });

    test('retains a safe provider failure without retaining response metadata', () => {
        const adapter = new OpenCodeEventAdapter();
        const result = adapter.consume({
            type: 'error',
            error: {
                name: 'APIError',
                data: {
                    message: 'Missing Authentication header',
                    statusCode: 401,
                    responseBody: 'SECRET_RESPONSE_BODY',
                    responseHeaders: { authorization: 'SECRET_HEADER' },
                },
            },
        });

        expect(result.events).toEqual([
            {
                type: 'runner.event',
                data: { native_type: 'error', status: 'error' },
            },
        ]);
        expect(adapter.summary()).toEqual({
            finalText: '',
            turnCompleted: false,
            failureMessage: 'HTTP 401: Missing Authentication header',
        });
        expect(JSON.stringify(adapter.summary())).not.toContain('SECRET');
    });
});
