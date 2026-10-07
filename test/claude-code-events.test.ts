import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ClaudeCodeEventAdapter } from '../src/runners/claude-code/events.js';

describe('Claude Code stream event normalization', () => {
    test('emits per-turn cost deltas from cumulative process totals', () => {
        const adapter = new ClaudeCodeEventAdapter();
        const first = adapter.consume({
            type: 'result',
            subtype: 'success',
            total_cost_usd: 0.0203,
            usage: { input_tokens: 1, output_tokens: 1 },
        });
        const second = adapter.consume({
            type: 'result',
            subtype: 'success',
            total_cost_usd: 0.0232,
            usage: { input_tokens: 1, output_tokens: 1 },
        });

        expect(first.events[0]?.data.cost_usd).toBeCloseTo(0.0203);
        expect(second.events[0]?.data.cost_usd).toBeCloseTo(0.0029);
    });
    test('preserves trace-derived command and native turn ordering', () => {
        expect(protocolSequence('lifecycle-basic.jsonl')).toEqual([
            'command-1:queued',
            'command-1:started',
            'system:init',
            'user:command-1',
            'assistant',
            'result:success',
            'command-1:completed',
            'command-2:queued',
            'command-2:started',
            'system:init',
            'user:command-2',
            'result:success',
            'command-2:completed',
        ]);
        expect(protocolSequence('lifecycle-steer-folded.jsonl')).toEqual([
            'command-main:queued',
            'command-main:started',
            'system:init',
            'user:command-main',
            'assistant',
            'command-steer:queued',
            'user',
            'user:command-steer',
            'command-steer:started',
            'assistant',
            'command-steer:completed',
            'result:success',
            'command-main:completed',
        ]);
        expect(protocolSequence('lifecycle-steer-separate.jsonl')).toEqual([
            'command-main:queued',
            'command-main:started',
            'system:init',
            'user:command-main',
            'assistant',
            'command-steer:queued',
            'user',
            'result:success',
            'command-main:completed',
            'command-steer:started',
            'system:init',
            'user:command-steer',
            'result:success',
            'command-steer:completed',
        ]);
        expect(protocolSequence('lifecycle-interrupt.jsonl')).toEqual([
            'command-main:queued',
            'command-main:started',
            'system:init',
            'command-queued:queued',
            'command-queued:cancelled',
            'control_response',
            'user',
            'result:error_during_execution',
            'command-main:cancelled',
        ]);
        expect(protocolSequence('lifecycle-request-cancel.jsonl')).toContain(
            'control_cancel_request:permission-1'
        );
        expect(protocolSequence('lifecycle-background.jsonl')).toEqual([
            'command-main:queued',
            'command-main:started',
            'system:init',
            'result:success',
            'command-main:completed',
            'system:task_notification',
            'system:background_tasks_changed',
            'system:init',
            'assistant',
            'result:success',
        ]);
    });

    test('normalizes text, tools, usage, cost, session, and completion safely', () => {
        const adapter = new ClaudeCodeEventAdapter();
        const events = fixture('success.jsonl').flatMap(
            (message) => adapter.consume(message).events
        );

        expect(events.filter((event) => event.type === 'output.text')).toEqual([
            { type: 'output.text', data: { id: 'msg-1', text: 'Hello ' } },
            { type: 'output.text', data: { id: 'msg-2', text: 'world' } },
        ]);
        expect(events).toContainEqual({
            type: 'tool.started',
            data: {
                id: 'toolu-1',
                name: 'Write',
                title: 'Write',
                target: '/workspace/result.txt',
            },
        });
        expect(events).toContainEqual({
            type: 'tool.completed',
            data: {
                id: 'toolu-1',
                name: 'Write',
                title: 'Write',
                target: '/workspace/result.txt',
                status: 'completed',
            },
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
            data: { reason: 'end_turn' },
        });
        expect(adapter.summary()).toMatchObject({
            finalText: 'Hello world',
            sessionId: 'claude-session-1',
            completionReason: 'end_turn',
            turnCompleted: true,
        });
        expect(JSON.stringify(events)).not.toContain('MUST_NOT_RENDER');
    });

    test('maps max token stops to length and ignores unknown messages safely', () => {
        const adapter = new ClaudeCodeEventAdapter();
        const events = [
            ...fixture('max-tokens.jsonl').flatMap(
                (message) => adapter.consume(message).events
            ),
            ...adapter.consume({ type: 'future', credential: 'MUST_NOT_RENDER' })
                .events,
        ];

        expect(events).toContainEqual({
            type: 'turn.completed',
            data: { reason: 'length' },
        });
        expect(events).toContainEqual({
            type: 'runner.event',
            data: { native_type: 'future' },
        });
        expect(adapter.summary()).toMatchObject({
            completionReason: 'length',
            turnCompleted: true,
        });
        expect(JSON.stringify(events)).not.toContain('MUST_NOT_RENDER');
    });

    test('uses result stop reason, reports diagnostics, and excludes subagent text', () => {
        const adapter = new ClaudeCodeEventAdapter();
        const events = [
            adapter.consume({
                type: 'assistant',
                parent_tool_use_id: 'toolu-parent',
                message: {
                    id: 'msg-child',
                    stop_reason: 'max_tokens',
                    content: [
                        { type: 'text', text: 'child response' },
                        {
                            type: 'tool_use',
                            id: 'tool-child',
                            name: 'Read',
                            input: { file_path: '/workspace/child.txt' },
                        },
                    ],
                },
            }),
            adapter.consume({
                type: 'assistant',
                parent_tool_use_id: null,
                message: {
                    id: 'msg-main',
                    content: [{ type: 'text', text: 'main response' }],
                },
            }),
            adapter.consume({
                type: 'result',
                subtype: 'error_during_execution',
                is_error: true,
                stop_reason: 'max_tokens',
                errors: ['provider refused request', 'retry limit reached'],
                usage: {},
            }),
        ].flatMap((result) => result.events);

        expect(events.filter((event) => event.type === 'output.text')).toEqual([
            {
                type: 'output.text',
                data: { id: 'msg-main', text: 'main response' },
            },
        ]);
        expect(adapter.summary()).toMatchObject({
            finalText: 'main response',
            completionReason: 'length',
            failureMessage:
                'Claude Code session failed (error_during_execution): provider refused request; retry limit reached',
        });
        expect(events).toContainEqual({
            type: 'tool.started',
            data: {
                id: 'tool-child',
                name: 'Read',
                title: 'Read',
                target: '/workspace/child.txt',
                description: 'Subagent activity under toolu-parent',
            },
        });
    });

    test('uses the result text for errors reported with a success subtype', () => {
        const adapter = new ClaudeCodeEventAdapter();
        for (const message of fixture('error-success.jsonl')) adapter.consume(message);

        expect(adapter.summary()).toMatchObject({
            failureMessage: 'Authentication failed: run claude auth login',
            turnCompleted: false,
        });
    });

    test('maps MultiEdit and NotebookEdit to file edits', () => {
        for (const [name, input] of [
            ['MultiEdit', { file_path: '/workspace/MultiEdit.txt' }],
            ['NotebookEdit', { notebook_path: '/workspace/NotebookEdit.ipynb' }],
        ] as const) {
            const adapter = new ClaudeCodeEventAdapter();
            const events = [
                adapter.consume({
                    type: 'assistant',
                    message: {
                        id: `msg-${name}`,
                        content: [
                            {
                                type: 'tool_use',
                                id: `tool-${name}`,
                                name,
                                input,
                            },
                        ],
                    },
                }),
                adapter.consume({
                    type: 'user',
                    message: {
                        content: [
                            {
                                type: 'tool_result',
                                tool_use_id: `tool-${name}`,
                            },
                        ],
                    },
                }),
            ].flatMap((result) => result.events);
            expect(events).toContainEqual({
                type: 'file.changed',
                data: {
                    path:
                        name === 'NotebookEdit'
                            ? '/workspace/NotebookEdit.ipynb'
                            : '/workspace/MultiEdit.txt',
                    operation: 'edit',
                },
            });
        }
    });

    test('does not use a subagent stop reason for the main completion', () => {
        const adapter = new ClaudeCodeEventAdapter();
        adapter.consume({
            type: 'assistant',
            parent_tool_use_id: 'parent',
            message: { content: [], stop_reason: 'max_tokens' },
        });
        adapter.consume({
            type: 'assistant',
            parent_tool_use_id: null,
            message: { content: [], stop_reason: 'end_turn' },
        });
        adapter.consume({ type: 'result', subtype: 'success', is_error: false });

        expect(adapter.summary()).toMatchObject({ completionReason: 'end_turn' });
    });
});

function fixture(name: string): unknown[] {
    return readFileSync(join(import.meta.dir, 'fixtures', 'claude-code', name), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
}

function protocolSequence(name: string): string[] {
    return fixture(name).map((value) => {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            return 'invalid';
        }
        const message = Object.fromEntries(Object.entries(value));
        if (message.type === 'command_lifecycle') {
            return `${String(message.command_uuid)}:${String(message.state)}`;
        }
        if (message.type === 'system') return `system:${String(message.subtype)}`;
        if (message.type === 'result') return `result:${String(message.subtype)}`;
        if (message.type === 'control_cancel_request') {
            return `control_cancel_request:${String(message.request_id)}`;
        }
        if (message.type === 'user' && message.isReplay === true) {
            return `user:${String(message.uuid)}`;
        }
        return String(message.type);
    });
}
