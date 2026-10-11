import { describe, expect, test } from 'bun:test';

import {
    ClaudeCodeCost,
    formatRecordedCost,
    parseRecordedCost,
} from '../src/runners/claude-code/cost.js';
import {
    ClaudeCodeEventAdapter,
    failureMessage,
} from '../src/runners/claude-code/events.js';

function assistant(content: unknown[], id = 'msg_1', parent: string | null = null) {
    return {
        type: 'assistant',
        message: { id, role: 'assistant', content },
        parent_tool_use_id: parent,
    };
}

function toolResult(id: string, isError = false) {
    return {
        type: 'user',
        message: {
            role: 'user',
            content: [
                {
                    type: 'tool_result',
                    tool_use_id: id,
                    content: 'MUST_NOT_RENDER_TOOL_OUTPUT',
                    is_error: isError,
                },
            ],
        },
        parent_tool_use_id: null,
    };
}

function result(fields: Record<string, unknown> = {}) {
    return {
        type: 'result',
        subtype: 'success',
        is_error: false,
        stop_reason: 'end_turn',
        usage: {
            input_tokens: 5,
            output_tokens: 7,
            cache_read_input_tokens: 2,
            cache_creation_input_tokens: 1,
        },
        ...fields,
    };
}

describe('Claude Code stream-json event normalization', () => {
    test('streams main-thread text per message and withholds thinking', () => {
        const adapter = new ClaudeCodeEventAdapter();
        const thinking = adapter.consume(
            assistant([
                {
                    type: 'thinking',
                    thinking: 'MUST_NOT_RENDER_REASONING',
                    signature: 's',
                },
            ])
        );
        const first = adapter.consume(assistant([{ type: 'text', text: 'Hello' }]));
        const same = adapter.consume(assistant([{ type: 'text', text: ' world' }]));
        const next = adapter.consume(
            assistant([{ type: 'text', text: 'Next' }], 'msg_2')
        );

        expect(thinking.events).toEqual([]);
        expect(first.events).toEqual([
            {
                type: 'output.text',
                data: { id: expect.stringMatching(/^output_/), text: 'Hello' },
            },
        ]);
        expect(same.events[0]?.data.id).toBe(first.events[0]?.data.id);
        expect(next.events[0]?.data.id).not.toBe(first.events[0]?.data.id);
        expect(adapter.summary().finalText).toBe('Hello worldNext');
    });

    test('never treats subagent or background text as the reply', () => {
        const adapter = new ClaudeCodeEventAdapter();
        const subagent = adapter.consume(
            assistant([{ type: 'text', text: 'SUBAGENT' }], 'msg_sub', 'toolu_task')
        );
        const background = adapter.consume(
            assistant([{ type: 'text', text: 'BACKGROUND' }], 'msg_bg'),
            false
        );
        expect(subagent.events).toEqual([]);
        expect(background.events).toEqual([]);
        expect(adapter.summary().finalText).toBe('');
    });

    test('normalizes tools and the files each editing tool changes', () => {
        const adapter = new ClaudeCodeEventAdapter();
        const tools = [
            ['Write', { file_path: '/workspace/a.txt', content: 'secret' }, 'write'],
            ['Edit', { file_path: '/workspace/b.txt', old_string: 'x' }, 'edit'],
            ['MultiEdit', { file_path: '/workspace/c.txt', edits: [] }, 'edit'],
            ['NotebookEdit', { notebook_path: '/workspace/d.ipynb' }, 'edit'],
        ] as const;
        const events = tools.flatMap(([name, input], index) => [
            ...adapter.consume(
                assistant([{ type: 'tool_use', id: `tool_${index}`, name, input }])
            ).events,
            ...adapter.consume(toolResult(`tool_${index}`)).events,
        ]);

        expect(events).toContainEqual({
            type: 'tool.started',
            data: {
                id: 'tool_0',
                name: 'Write',
                title: 'Write',
                target: '/workspace/a.txt',
            },
        });
        expect(events).toContainEqual({
            type: 'tool.completed',
            data: {
                id: 'tool_0',
                name: 'Write',
                title: 'Write',
                target: '/workspace/a.txt',
                status: 'completed',
            },
        });
        expect(events.filter((event) => event.type === 'file.changed')).toEqual(
            tools.map(([, input, operation]) => ({
                type: 'file.changed',
                data: {
                    path: 'file_path' in input ? input.file_path : input.notebook_path,
                    operation,
                },
            }))
        );
        expect(JSON.stringify(events)).not.toContain('MUST_NOT_RENDER');
        expect(JSON.stringify(events)).not.toContain('secret');
    });

    test('reports failed tools without a file change and titles shell commands safely', () => {
        const adapter = new ClaudeCodeEventAdapter();
        const events = [
            ...adapter.consume(
                assistant([
                    {
                        type: 'tool_use',
                        id: 'shell',
                        name: 'Bash',
                        input: {
                            command: 'MUST_NOT_RENDER_COMMAND',
                            description: 'List',
                        },
                    },
                    {
                        type: 'tool_use',
                        id: 'denied',
                        name: 'Write',
                        input: { file_path: '/workspace/x' },
                    },
                ])
            ).events,
            ...adapter.consume(toolResult('denied', true)).events,
        ];
        expect(events).toContainEqual({
            type: 'tool.started',
            data: { id: 'shell', name: 'Bash', title: 'List' },
        });
        expect(events).toContainEqual({
            type: 'tool.completed',
            data: {
                id: 'denied',
                name: 'Write',
                title: 'Write',
                target: '/workspace/x',
                status: 'failed',
                error_code: 'runner_error',
                message: 'Tool failed in runner',
            },
        });
        expect(events.some((event) => event.type === 'file.changed')).toBe(false);
        expect(JSON.stringify(events)).not.toContain('MUST_NOT_RENDER');
    });

    test('reports per-turn usage and cost deltas from the cumulative total', () => {
        const adapter = new ClaudeCodeEventAdapter();
        const first = adapter.consume(result({ total_cost_usd: 0.02 }));
        const second = adapter.consume(result({ total_cost_usd: 0.025 }));
        expect(first.events).toContainEqual({
            type: 'usage.updated',
            data: {
                kind: 'delta',
                total_tokens: 15,
                input_tokens: 5,
                output_tokens: 7,
                cache_read_tokens: 2,
                cache_write_tokens: 1,
                cost_usd: 0.02,
            },
        });
        expect(second.events[0]?.data.cost_usd).toBeCloseTo(0.005);
    });

    test('a resumed process reports deltas from the total the last process recorded', async () => {
        let recorded: number | undefined;
        const store = {
            read: async () => recorded,
            write: async (total: number) => {
                recorded = total;
            },
        };
        const first = await ClaudeCodeCost.open('metered', store);
        const process1 = new ClaudeCodeEventAdapter({ cost: first });
        expect(
            process1.consume(result({ total_cost_usd: 0.02 })).events[0]?.data.cost_usd
        ).toBe(0.02);
        process1.consume(result({ total_cost_usd: 0.0232 }));
        await first.flush();
        expect(recorded).toBe(0.0232);

        // The next process's first cumulative total includes everything above.
        const second = await ClaudeCodeCost.open('metered', store);
        const process2 = new ClaudeCodeEventAdapter({ cost: second });
        const resumed = process2.consume(result({ total_cost_usd: 0.0263 }));
        expect(resumed.events[0]?.data.cost_usd).toBeCloseTo(0.0031);
        expect(resumed.events[0]?.data.total_tokens).toBe(15);
        await second.flush();
        expect(recorded).toBe(0.0263);
    });

    test('a subscription route reports no spend but records its totals', async () => {
        let recorded: number | undefined;
        const cost = await ClaudeCodeCost.open('subscription', {
            read: async () => undefined,
            write: async (total) => {
                recorded = total;
            },
        });
        const adapter = new ClaudeCodeEventAdapter({ cost });
        expect(
            adapter.consume(result({ total_cost_usd: 0.4 })).events[0]?.data.cost_usd
        ).toBe(0);
        expect(adapter.consume(result()).events[0]?.data.cost_usd).toBe(0);
        await cost.flush();
        expect(recorded).toBe(0.4);
    });

    test('a lower total restarts the count, and a failed record never fails a turn', async () => {
        const cost = await ClaudeCodeCost.open('metered', {
            read: async () => {
                throw new Error('unreadable');
            },
            write: async () => {
                throw new Error('unwritable');
            },
        });
        expect(cost.delta(0.5)).toBe(0.5);
        expect(cost.delta(0.2)).toBe(0.2);
        expect(cost.delta(0.3)).toBeCloseTo(0.1);
        expect(cost.delta(undefined)).toBeUndefined();
        await cost.flush();
    });

    test('parses only a recorded non-negative total', () => {
        expect(parseRecordedCost(formatRecordedCost(1.25))).toBe(1.25);
        for (const text of [
            '',
            'null',
            '{"total_cost_usd":-1}',
            '{"total_cost_usd":"1"}',
        ]) {
            expect(parseRecordedCost(text)).toBeUndefined();
        }
    });

    test('maps the output limit to length and keeps other stop reasons', () => {
        for (const [native, reason] of [
            ['max_tokens', 'length'],
            ['end_turn', 'end_turn'],
        ]) {
            const adapter = new ClaudeCodeEventAdapter();
            adapter.beginTurn();
            expect(
                adapter.consume(result({ stop_reason: native })).events
            ).toContainEqual({
                type: 'turn.completed',
                data: { reason },
            });
            expect(adapter.summary()).toMatchObject({
                completionReason: reason,
                turnCompleted: true,
            });
        }
    });

    test('summarizes a failed result without leaking long tokens', () => {
        const adapter = new ClaudeCodeEventAdapter();
        adapter.beginTurn();
        const events = adapter.consume(
            result({
                is_error: true,
                result: 'API Error: 401 key sk-ant-abcdefghijklmnopqrstuvwxyz rejected',
            })
        ).events;
        expect(events.some((event) => event.type === 'turn.completed')).toBe(false);
        expect(adapter.summary().failureMessage).toBe(
            'Claude Code session failed: API Error: 401 key [redacted] rejected'
        );
        adapter.beginTurn();
        expect(adapter.summary().failureMessage).toBeUndefined();
    });

    test('ignores a background result in the turn summary', () => {
        const adapter = new ClaudeCodeEventAdapter();
        adapter.beginTurn();
        adapter.consume(result({ is_error: true, result: 'not this turn' }), false);
        expect(adapter.summary()).toEqual({ finalText: '', turnCompleted: false });
    });

    test('reduces unknown events to a payload-free marker and ignores quiet ones', () => {
        const adapter = new ClaudeCodeEventAdapter();
        expect(
            adapter.consume({ type: 'future.event', credential: 'secret' }).events
        ).toEqual([{ type: 'runner.event', data: { native_type: 'future.event' } }]);
        expect(
            adapter.consume({ type: 'system', subtype: 'compact_boundary', data: 'x' })
                .events
        ).toEqual([
            { type: 'runner.event', data: { native_type: 'system.compact_boundary' } },
        ]);
        expect(adapter.consume({ type: 'bad type with spaces' }).events).toEqual([
            { type: 'runner.event', data: { native_type: 'unknown' } },
        ]);
        expect(adapter.consume('not json').events).toEqual([
            { type: 'runner.event', data: { native_type: 'malformed' } },
        ]);
        for (const quiet of [
            { type: 'rate_limit_event', rate_limit_info: {} },
            { type: 'keep_alive' },
            { type: 'system', subtype: 'thinking_tokens' },
            { type: 'system', subtype: 'task_notification' },
            { type: 'system', subtype: 'background_tasks_changed' },
            {
                type: 'user',
                message: { role: 'user', content: 'echo' },
                isReplay: true,
            },
        ]) {
            expect(adapter.consume(quiet).events).toEqual([]);
        }
    });

    test('puts the error line first and redacts named credentials', () => {
        expect(
            failureMessage(
                ['error: bad key short-key', 'Claude Code exited with code 1'],
                ['short-key', 'x']
            )
        ).toBe(
            'Claude Code session failed: error: bad key [redacted] Claude Code exited with code 1'
        );
        expect(failureMessage([undefined, ' '])).toBe('Claude Code session failed');
    });
});
