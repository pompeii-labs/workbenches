import { expect, test } from 'bun:test';
import type {
    RunnerSession,
    RunnerSessionHost,
    RunnerSessionProgress,
} from '../../../src/runners/session.js';
import type { StdinProgress } from '../../../src/runners/stdin/progress.js';
import type { WorkbenchEventDraft } from '../../../src/runs/events.js';
import { drain, start, Transcript } from './fixture.js';

for (const runner of ['claude-code', 'pi'] as const) {
    test(`${runner} rebuilds earlier turns before following the active turn`, async () => {
        const native = new Transcript();
        const baseline: WorkbenchEventDraft[] = [];
        const original = await start(runner, native, baseline);
        const finish = (
            process: Transcript,
            command: unknown,
            text: string,
            total: number
        ) => {
            if (runner === 'claude-code') {
                process.send({
                    type: 'command_lifecycle',
                    command_uuid: command,
                    state: 'started',
                });
                process.send({
                    type: 'assistant',
                    message: {
                        id: text,
                        role: 'assistant',
                        content: [{ type: 'text', text }],
                    },
                });
                process.send({
                    type: 'result',
                    subtype: 'success',
                    stop_reason: 'end_turn',
                    total_cost_usd: total,
                });
            } else {
                process.send({
                    type: 'message_update',
                    assistantMessageEvent: { type: 'text_delta', delta: text },
                });
                process.send({ type: 'agent_settled' });
            }
        };
        const first = original.prompt('first');
        await drain();
        finish(
            native,
            native.writes.find((value) => value.type === 'user')?.uuid,
            'first',
            0.1
        );
        await first;
        const second = original.prompt('second');
        await drain();
        const progress = original.progress?.();
        if (!progress) throw new Error('Expected progress');
        const lines = [...native.output];
        const events = [...baseline];
        const command = native.writes
            .filter((value) => value.type === 'user')
            .at(-1)?.uuid;
        finish(native, command, 'second', 0.3);
        const result = await second;
        await drain();
        const attached = new Transcript();
        const starting = start(runner, attached, events, progress);
        attached.replay(lines);
        const resumed = await starting;
        const following = resumed.resumeTurn?.();
        finish(attached, command, 'second', 0.3);
        await expect(following).resolves.toEqual(result);
        expect(events).toEqual(baseline);
        expect(attached.writes).toEqual([]);
        await resumed.close();
        await original.close();
    });

    test(`${runner} keeps an uncommitted line outside progress when host emission fails`, async () => {
        const native = new Transcript();
        const gate = Promise.withResolvers<void>();
        const original = await start(runner, native, [], undefined, {
            host: {
                emit: async (event) => {
                    if (event.type === 'output.text') await gate.promise;
                },
                requestPermission: () => new Promise(() => {}),
                requestQuestion: () => new Promise(() => {}),
            },
        });
        const turn = original.prompt('work');
        void turn.catch(() => {});
        await drain();
        if (runner === 'claude-code')
            native.send({
                type: 'command_lifecycle',
                command_uuid: native.writes.find((value) => value.type === 'user')
                    ?.uuid,
                state: 'started',
            });
        native.send(
            runner === 'claude-code'
                ? {
                      type: 'control_request',
                      request_id: 'open',
                      request: {
                          subtype: 'can_use_tool',
                          tool_name: 'Read',
                          input: { file_path: '/file' },
                      },
                  }
                : {
                      type: 'extension_ui_request',
                      id: 'open',
                      method: 'input',
                      title: 'Value?',
                  }
        );
        await drain();
        const before = original.progress?.();
        native.send(
            runner === 'claude-code'
                ? {
                      type: 'assistant',
                      message: {
                          id: 'text',
                          role: 'assistant',
                          content: [{ type: 'text', text: 'pending' }],
                      },
                  }
                : {
                      type: 'message_update',
                      assistantMessageEvent: { type: 'text_delta', delta: 'pending' },
                  }
        );
        await drain();
        expect(original.progress?.()).toEqual(before);
        gate.reject(new Error('storage failed'));
        await expect(turn).rejects.toThrow();
        const progress = original.progress?.();
        if (!progress) throw new Error('Expected progress');
        expect('activeTurn' in progress && progress.activeTurn).toBeTruthy();
        const attached = new Transcript();
        const events: WorkbenchEventDraft[] = [];
        let raised = 0;
        const starting = start(runner, attached, events, progress, {
            host: {
                requestPermission: async () => {
                    raised++;
                    return 'reject';
                },
                requestQuestion: async () => {
                    raised++;
                    return { outcome: 'rejected' };
                },
            },
        });
        attached.replay(native.output);
        const resumed = await starting;
        await drain();
        expect(
            events
                .filter((event) => event.type === 'output.text')
                .map((event) => event.data.text)
        ).toEqual(['pending']);
        expect(raised).toBe(1);
        await resumed.close();
        await original.close();
    });

    for (const answered of [false, true]) {
        test(`${runner} raises an open request after attach and keeps answered request ids (${answered})`, async () => {
            const native = new Transcript();
            let raised = 0;
            const host: Partial<RunnerSessionHost> = {
                requestPermission: async () => {
                    raised++;
                    return answered ? 'allow_always' : new Promise(() => {});
                },
                requestQuestion: async () => {
                    raised++;
                    return answered ? { outcome: 'rejected' } : new Promise(() => {});
                },
            };
            const original = await start(runner, native, [], undefined, { host });
            const turn = original.prompt('work');
            void turn.catch(() => {});
            await drain();
            native.send(
                runner === 'claude-code'
                    ? {
                          type: 'control_request',
                          request_id: 'request',
                          request: {
                              subtype: 'can_use_tool',
                              tool_name: 'Read',
                              input: { file_path: '/file' },
                          },
                      }
                    : {
                          type: 'extension_ui_request',
                          id: 'request',
                          method: 'input',
                          title: 'Value?',
                      }
            );
            await drain();
            const progress = original.progress?.();
            if (!progress || !('answeredRequests' in progress))
                throw new Error('Expected stdin progress');
            expect(raised).toBe(1);
            expect(progress.answeredRequests).toEqual(answered ? ['request'] : []);
            const attached = new Transcript();
            raised = 0;
            const starting = start(runner, attached, [], progress, { host });
            attached.replay(native.output);
            const resumed = await starting;
            await drain();
            expect(raised).toBe(answered ? 0 : 1);
            expect(attached.writes).toEqual([]);
            if (answered && runner === 'claude-code') {
                attached.send({
                    type: 'control_request',
                    request_id: 'request-next',
                    request: {
                        subtype: 'can_use_tool',
                        tool_name: 'Read',
                        input: { file_path: '/file' },
                    },
                });
                await drain();
                expect(raised).toBe(0);
                expect(attached.writes).toHaveLength(1);
            }
            await resumed.close();
            await original.close();
            await turn;
        });
    }

    test(`${runner} reports a detached process failure after replaying its output`, async () => {
        const native = new Transcript();
        const original = await start(runner, native, []);
        const turn = original.prompt('work');
        void turn.catch(() => {});
        await drain();
        const progress = original.progress?.();
        if (!progress) throw new Error('Expected progress');
        const attached = new Transcript();
        const starting = start(runner, attached, [], progress);
        attached.replay(native.output);
        attached.end(23);
        const resumed = await starting;
        await expect(resumed.resumeTurn?.()).rejects.toThrow('23');
        await resumed.close();
        await original.close();
        await turn;
    });

    test(`${runner} launches native resume without saved progress`, async () => {
        const native = new Transcript();
        const session = await start(runner, native, [], undefined, {
            session: {
                id: 'wb',
                directory: '/state',
                nativeSessionId: 'native-session',
            },
        });
        expect(native.command).toContain(
            runner === 'claude-code' ? '--resume' : '--session'
        );
        expect(native.command.join(' ')).toContain('native-session');
        await session.close();
    });

    test(`${runner} resumes a turn from each committed stdout line without repeated events or answers`, async () => {
        const source = new Transcript();
        const baseline: WorkbenchEventDraft[] = [];
        const session = await start(runner, source, baseline);
        const turn = session.prompt('work');
        await drain();
        const command = source.writes.find((value) => value.type === 'user')?.uuid;
        const nativeEvents: Record<string, unknown>[] =
            runner === 'claude-code'
                ? [
                      {
                          type: 'command_lifecycle',
                          command_uuid: command,
                          state: 'started',
                      },
                      {
                          type: 'assistant',
                          message: {
                              id: 'msg',
                              role: 'assistant',
                              content: [
                                  {
                                      type: 'tool_use',
                                      id: 'tool',
                                      name: 'Read',
                                      input: { file_path: '/file' },
                                  },
                              ],
                          },
                      },
                      {
                          type: 'user',
                          message: {
                              role: 'user',
                              content: [
                                  {
                                      type: 'tool_result',
                                      tool_use_id: 'tool',
                                      content: 'read',
                                  },
                              ],
                          },
                      },
                      {
                          type: 'assistant',
                          message: {
                              id: 'text',
                              role: 'assistant',
                              content: [{ type: 'text', text: 'héllo' }],
                          },
                      },
                      {
                          type: 'result',
                          subtype: 'success',
                          stop_reason: 'end_turn',
                          usage: { input_tokens: 2, output_tokens: 3 },
                          total_cost_usd: 0.1,
                      },
                  ]
                : [
                      { type: 'agent_start' },
                      {
                          type: 'tool_execution_start',
                          toolCallId: 'tool',
                          toolName: 'read',
                          args: { path: '/file' },
                      },
                      {
                          type: 'tool_execution_end',
                          toolCallId: 'tool',
                          toolName: 'read',
                          isError: false,
                      },
                      {
                          type: 'message_update',
                          assistantMessageEvent: { type: 'text_delta', delta: 'héllo' },
                      },
                      {
                          type: 'message_end',
                          message: {
                              role: 'assistant',
                              stopReason: 'stop',
                              usage: {
                                  input: 2,
                                  output: 3,
                                  totalTokens: 5,
                                  cost: { total: 0.1 },
                              },
                          },
                      },
                      { type: 'agent_settled' },
                  ];
        const prefix = source.writes
            .filter((value) => value.type === 'get_state' || value.type === 'prompt')
            .map(
                (value) =>
                    `${JSON.stringify({ type: 'response', id: value.id, success: true, ...(value.type === 'get_state' ? { data: { sessionId: 'native' } } : {}) })}\n`
            );
        nativeEvents.unshift(
            runner === 'claude-code'
                ? {
                      type: 'control_request',
                      request_id: 'request',
                      request: {
                          subtype: 'can_use_tool',
                          tool_name: 'AskUserQuestion',
                          input: {
                              questions: [
                                  {
                                      question: 'Continue?',
                                      header: 'Continue',
                                      options: [
                                          { label: 'Yes', description: 'Continue' },
                                      ],
                                      multiSelect: false,
                                  },
                              ],
                          },
                      },
                  }
                : {
                      type: 'extension_ui_request',
                      id: 'request',
                      method: 'input',
                      title: 'Value?',
                  }
        );
        const lines = [...prefix];
        const checkpoints: Array<{ progress: RunnerSessionProgress; count: number }> =
            [];
        const initial = session.progress?.();
        if (initial) checkpoints.push({ progress: initial, count: baseline.length });
        for (let index = 0; index < nativeEvents.length; index++) {
            const value = nativeEvents[index];
            if (!value) throw new Error('Expected native event');
            lines.push(source.send(value));
            await drain();
            if (runner === 'claude-code' && index === 2) {
                const steer = await session.steer?.('keep reading');
                void steer?.delivered.catch(() => {});
                nativeEvents.splice(index + 1, 0, {
                    type: 'command_lifecycle',
                    state: 'started',
                    command_uuid: source.writes
                        .filter((entry) => entry.type === 'user')
                        .at(-1)?.uuid,
                });
            }
            const progress = session.progress?.();
            expect(progress).toBeDefined();
            if (progress && 'stdoutBytes' in progress)
                expect(progress.stdoutBytes).toBe(
                    new TextEncoder().encode(lines.join('')).byteLength
                );
            if (progress)
                checkpoints.push({
                    progress: JSON.parse(JSON.stringify(progress)),
                    count: baseline.length,
                });
        }
        const result = await turn;
        for (const checkpoint of checkpoints) {
            const native = new Transcript();
            const events = baseline.slice(0, checkpoint.count);
            const starting = start(runner, native, events, checkpoint.progress);
            native.replay(lines);
            const answered = (checkpoint.progress as StdinProgress).answeredRequests;
            if (answered.includes('request')) native.end(0);
            const resumed = await starting;
            if ('activeTurn' in checkpoint.progress && checkpoint.progress.activeTurn)
                await expect(resumed.resumeTurn?.()).resolves.toEqual(result);
            else
                await expect(resumed.resumeTurn?.()).rejects.toThrow(
                    'no turn to resume'
                );
            await drain();
            expect(events).toEqual(baseline);
            expect(native.writes).toEqual(
                answered.includes('request')
                    ? []
                    : source.writes.filter(
                          (entry) =>
                              entry.type === 'control_response' ||
                              entry.type === 'extension_ui_response'
                      )
            );
            await resumed.close();
        }
        await session.close();
    });

    test(`${runner} has no turn to resume before a prompt`, async () => {
        const native = new Transcript();
        const session: RunnerSession = await start(runner, native, []);
        await expect(session.resumeTurn?.()).rejects.toThrow('no turn to resume');
        await session.close();
    });
}

test('Claude Code delivers each event of a line once when progress is saved inside the line', async () => {
    const native = new Transcript();
    const stored: WorkbenchEventDraft[] = [];
    let saved: RunnerSessionProgress | undefined;
    let original: RunnerSession | undefined;
    const stopped = Promise.withResolvers<void>();
    // The host stores each event with the progress read once the previous
    // `emit` resolved, then stops during the line's second event.
    original = await start('claude-code', native, [], undefined, {
        host: {
            emit: async (event) => {
                saved = original?.progress?.();
                if (event.type === 'tool.started') return stopped.promise;
                stored.push(event);
            },
        },
    });
    const turn = original.prompt('work');
    void turn.catch(() => {});
    await drain();
    native.send({
        type: 'command_lifecycle',
        state: 'started',
        command_uuid: native.writes.find((value) => value.type === 'user')?.uuid,
    });
    native.send({
        type: 'assistant',
        message: {
            id: 'message',
            role: 'assistant',
            content: [
                { type: 'text', text: 'reading' },
                { type: 'tool_use', id: 'tool', name: 'Read', input: {} },
            ],
        },
    });
    await drain();
    expect(stored.map((event) => event.type)).toContain('output.text');
    if (!saved) throw new Error('Expected saved progress');
    const attached = new Transcript();
    const starting = start('claude-code', attached, stored, saved);
    attached.replay(native.output);
    const resumed = await starting;
    await drain();
    expect(stored.filter((event) => event.type === 'output.text')).toHaveLength(1);
    expect(stored.filter((event) => event.type === 'tool.started')).toHaveLength(1);
    await resumed.close();
    stopped.reject(new Error('host stopped'));
    await original.close();
});
