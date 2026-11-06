import { expect, test } from 'bun:test';
import type { WorkbenchEventDraft } from '../../../src/runs/events.js';
import { RuntimeProcessMissingError } from '../../../src/runtimes/missing.js';
import { claudeCodeProgress, drain, finishTurn, start, Transcript } from './fixture.js';

for (const runner of ['claude-code', 'pi'] as const)
    test(`${runner} drains an exited remote process through slow host emission`, async () => {
        const native = new Transcript();
        const gate = Promise.withResolvers<void>();
        const session = await start(runner, native, [], undefined, {
            stopTimeoutMs: 5,
            host: {
                emit: async (event) => {
                    if (event.type === 'output.text') await gate.promise;
                },
            },
        });
        let settled = false;
        const turn = session.prompt('work').finally(() => {
            settled = true;
        });
        void turn.catch(() => {});
        await drain();
        if (runner === 'claude-code') {
            native.send({
                type: 'command_lifecycle',
                state: 'started',
                command_uuid: native.writes.find((value) => value.type === 'user')
                    ?.uuid,
            });
            native.send({
                type: 'assistant',
                message: {
                    id: 'text',
                    role: 'assistant',
                    content: [{ type: 'text', text: 'last' }],
                },
            });
            native.send({
                type: 'result',
                subtype: 'success',
                stop_reason: 'end_turn',
            });
        } else {
            native.send({
                type: 'message_update',
                assistantMessageEvent: { type: 'text_delta', delta: 'last' },
            });
            native.send({ type: 'agent_settled' });
        }
        native.end(0);
        await drain();
        expect(settled).toBe(false);
        gate.resolve();
        await expect(turn).resolves.toEqual({
            reason: runner === 'claude-code' ? 'end_turn' : 'completed',
        });
        await session.close();
    });

for (const runner of ['claude-code', 'pi'] as const)
    test(`${runner} accepts another turn after attaching from idle progress`, async () => {
        const native = new Transcript();
        const original = await start(runner, native, []);
        const first = original.prompt('first');
        await drain();
        finishTurn(runner, native, 'first');
        const result = await first;
        await drain();
        const progress = original.progress?.();
        if (!progress) throw new Error('Expected progress');
        const events: WorkbenchEventDraft[] = [];
        const attached = new Transcript();
        const starting = start(runner, attached, events, progress);
        attached.replay(native.output);
        const resumed = await starting;
        await expect(resumed.resumeTurn?.()).rejects.toThrow('no turn to resume');
        const next = resumed.prompt('second');
        await drain();
        const following = resumed.resumeTurn?.();
        finishTurn(runner, attached, 'second');
        await expect(next).resolves.toEqual(result);
        await expect(following).resolves.toEqual(result);
        expect(
            events
                .filter((event) => event.type === 'output.text')
                .map((event) => event.data.text)
        ).toEqual(['second']);
        await resumed.close();
        await original.close();
    });

for (const runner of ['claude-code', 'pi'] as const)
    test(`${runner} rejects the start, and leaves no rejection unhandled, when the saved process is gone`, async () => {
        const native = new Transcript();
        const original = await start(runner, native, []);
        const first = original.prompt('first');
        await drain();
        finishTurn(runner, native, 'first');
        await first;
        await drain();
        const progress = original.progress?.();
        if (!progress?.handle) throw new Error('Expected progress with a handle');
        const missing = new RuntimeProcessMissingError(progress.handle);
        const gone = new Transcript();
        gone.child.handle = Promise.reject(missing);
        gone.child.exited = Promise.reject(missing);
        gone.end();
        const unhandled: unknown[] = [];
        const record = (reason: unknown) => unhandled.push(reason);
        process.on('unhandledRejection', record);
        try {
            await expect(start(runner, gone, [], progress)).rejects.toBe(missing);
            await drain();
        } finally {
            process.off('unhandledRejection', record);
        }
        expect(unhandled).toEqual([]);
        await original.close();
    });

test('Claude Code holds restored steering until a native tool result boundary', async () => {
    const native = new Transcript();
    const original = await start('claude-code', native, []);
    const turn = original.prompt('work');
    await drain();
    native.send({
        type: 'command_lifecycle',
        state: 'started',
        command_uuid: native.writes.find((value) => value.type === 'user')?.uuid,
    });
    await drain();
    const steering = await original.steer?.('continue carefully');
    void steering?.delivered.catch(() => {});
    const progress = claudeCodeProgress(original);
    expect(progress.steering).toHaveLength(1);
    expect(progress.steering[0]?.written).toBe(false);
    const attached = new Transcript();
    const starting = start('claude-code', attached, [], progress);
    attached.replay(native.output);
    const resumed = await starting;
    expect(attached.writes).toEqual([]);
    attached.send({
        type: 'assistant',
        message: {
            id: 'tool-message',
            role: 'assistant',
            content: [
                {
                    type: 'tool_use',
                    id: 'read',
                    name: 'Read',
                    input: { file_path: '/file' },
                },
            ],
        },
    });
    await drain();
    expect(attached.writes).toHaveLength(1);
    expect(attached.writes[0]?.uuid).toBe(progress.steering[0]?.command);
    expect(claudeCodeProgress(resumed).steering[0]?.written).toBe(true);
    attached.send({
        type: 'command_lifecycle',
        state: 'started',
        command_uuid: progress.steering[0]?.command,
    });
    await drain();
    expect(claudeCodeProgress(resumed).steering).toEqual([]);
    await resumed.close();
    await original.close();
    await turn;
});

test('Claude Code counts a tool call line before writing the steering it releases', async () => {
    const native = new Transcript();
    const session = await start('claude-code', native, []);
    const turn = session.prompt('work');
    await drain();
    native.send({
        type: 'command_lifecycle',
        state: 'started',
        command_uuid: native.writes.find((value) => value.type === 'user')?.uuid,
    });
    await drain();
    const steering = await session.steer?.('continue carefully');
    void steering?.delivered.catch(() => {});
    const command = claudeCodeProgress(session).steering[0]?.command;
    const writing = Promise.withResolvers<void>();
    const write = native.child.stdin.write;
    native.child.stdin.write = (line: string) => {
        write(line);
        return writing.promise;
    };
    native.send({
        type: 'assistant',
        message: {
            id: 'tool-message',
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'read', name: 'Read', input: {} }],
        },
    });
    await drain();
    expect(command).toBeDefined();
    expect(native.writes.at(-1)?.uuid).toBe(command);
    const progress = session.progress?.();
    expect(progress && 'stdoutBytes' in progress ? progress.stdoutBytes : 0).toBe(
        native.output.reduce((total, line) => total + Buffer.byteLength(line), 0)
    );
    writing.resolve();
    await session.close();
    await turn;
});

for (const command of ['prompt', 'abort'] as const)
    test(`Pi follows a pending ${command} acknowledgement after attach`, async () => {
        const native = new Transcript();
        native.acknowledgePrompt = command !== 'prompt';
        const original = await start('pi', native, []);
        const turn = original.prompt('work');
        void turn.catch(() => {});
        await drain();
        const cancellation = command === 'abort' ? original.cancelTurn() : undefined;
        void cancellation?.catch(() => {});
        await drain();
        const progress = original.progress?.();
        if (!progress) throw new Error('Expected progress');
        const request = native.writes.find((value) => value.type === command);
        if (!request) throw new Error('Expected command');
        const attached = new Transcript();
        const starting = start('pi', attached, [], progress);
        attached.replay(native.output);
        const resumed = await starting;
        const following = resumed.resumeTurn?.();
        attached.send({
            type: 'response',
            id: request.id,
            success: command === 'abort',
        });
        if (command === 'abort')
            await expect(following).resolves.toEqual({ reason: 'cancelled' });
        else await expect(following).rejects.toThrow('Pi command failed: prompt');
        await resumed.close();
        await original.close();
        await turn;
        await cancellation?.catch(() => {});
    });

test('Claude Code follows a pending interrupt acknowledgement after attach', async () => {
    const native = new Transcript();
    const original = await start('claude-code', native, []);
    const turn = original.prompt('work');
    await drain();
    native.send({
        type: 'command_lifecycle',
        state: 'started',
        command_uuid: native.writes.find((value) => value.type === 'user')?.uuid,
    });
    await drain();
    const cancellation = original.cancelTurn();
    void cancellation.catch(() => {});
    await drain();
    const progress = original.progress?.();
    if (!progress) throw new Error('Expected progress');
    const request = native.writes.find((value) => value.type === 'control_request');
    const attached = new Transcript();
    const starting = start('claude-code', attached, [], progress);
    attached.replay(native.output);
    const resumed = await starting;
    const following = resumed.resumeTurn?.();
    attached.send({
        type: 'control_response',
        response: { subtype: 'success', request_id: request?.request_id },
    });
    await expect(following).resolves.toEqual({ reason: 'cancelled' });
    await resumed.close();
    await original.close();
    await turn;
    await cancellation.catch(() => {});
});

for (const detached of [true, false])
    test(`Pi never raises a timed-out dialog again, and withdraws it when it timed out while detached (${detached ? 'detached' : 'attached'})`, async () => {
        const native = new Transcript();
        const timedOut = Promise.withResolvers<void>();
        const original = await start('pi', native, [], undefined, {
            host: {
                requestQuestion: () => new Promise(() => {}),
                withdrawRequest: async () => timedOut.resolve(),
            },
        });
        const turn = original.prompt('work');
        await drain();
        native.send({
            type: 'extension_ui_request',
            id: 'deadline',
            method: 'input',
            title: 'Value?',
            // Detached, the host dies first; attached, Pi's own deadline passes.
            timeout: detached ? 60_000 : 1,
        });
        await drain();
        if (!detached) await timedOut.promise;
        const saved = original.progress?.();
        if (!saved) throw new Error('Expected progress');
        // The deadline passes while no host is attached.
        const progress = detached
            ? { ...saved, requestDeadlines: { deadline: Date.now() - 1 } }
            : saved;
        const attached = new Transcript();
        let raised = 0;
        const withdrawn: string[] = [];
        const starting = start('pi', attached, [], progress, {
            host: {
                requestQuestion: async () => {
                    raised++;
                    return { outcome: 'rejected' };
                },
                withdrawRequest: async (id) => {
                    withdrawn.push(id);
                },
            },
        });
        attached.replay(native.output);
        const resumed = await starting;
        await drain();
        expect(raised).toBe(0);
        expect(attached.writes).toEqual([]);
        // Only the host that never saw the deadline pass still holds the request.
        expect(withdrawn).toEqual(detached ? ['deadline'] : []);
        await resumed.close();
        await original.close();
        await turn;
    });

for (const failedEmit of [false, true])
    test(`Claude Code restores a pending OpenRouter charge and reports it once after attach (failed emit: ${failedEmit})`, async () => {
        const native = new Transcript();
        const held = Promise.withResolvers<Response>();
        const original = await start('claude-code', native, [], undefined, {
            host: {
                emit: async (event) => {
                    if (
                        failedEmit &&
                        event.type === 'usage.updated' &&
                        event.data.cost_usd === 0.123
                    )
                        throw new Error('storage failed');
                },
            },
            openRouter: { fetch: () => held.promise, sleep: async () => {} },
        });
        const turn = original.prompt('work');
        await drain();
        native.send({
            type: 'command_lifecycle',
            command_uuid: native.writes.find((value) => value.type === 'user')?.uuid,
            state: 'started',
        });
        native.send({
            type: 'assistant',
            message: {
                id: 'msg',
                role: 'assistant',
                content: [],
                requestId: 'gen-charge',
            },
            request_id: 'gen-charge',
        });
        native.send({
            type: 'result',
            subtype: 'success',
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 2 },
        });
        await turn;
        if (failedEmit)
            held.resolve(
                Response.json({ data: { finish_reason: 'stop', total_cost: 0.123 } })
            );
        await drain();
        const progress = claudeCodeProgress(original);
        expect(progress.pendingCharges).toEqual([['gen-charge']]);
        const events: WorkbenchEventDraft[] = [];
        let lookups = 0;
        const attached = new Transcript();
        const starting = start('claude-code', attached, events, progress, {
            openRouter: {
                fetch: async () => {
                    lookups++;
                    return Response.json({
                        data: { finish_reason: 'stop', total_cost: 0.123 },
                    });
                },
                sleep: async () => {},
            },
        });
        attached.replay(native.output);
        attached.end(0);
        const resumed = await starting;
        await drain();
        expect(lookups).toBe(1);
        expect(events).toEqual([
            { type: 'usage.updated', data: { kind: 'delta', cost_usd: 0.123 } },
        ]);
        const saved = claudeCodeProgress(resumed);
        expect(saved.pendingCharges).toEqual([]);
        await resumed.close();
        if (!saved) throw new Error('Expected saved progress');
        const again = new Transcript();
        const restarting = start('claude-code', again, events, saved, {
            openRouter: {
                fetch: async () => {
                    lookups++;
                    return Response.json({
                        data: { finish_reason: 'stop', total_cost: 0.123 },
                    });
                },
                sleep: async () => {},
            },
        });
        again.replay(native.output);
        const restarted = await restarting;
        await drain();
        expect(lookups).toBe(1);
        expect(events).toHaveLength(1);
        await restarted.close();
        held.resolve(
            Response.json({ data: { finish_reason: 'stop', total_cost: 0.123 } })
        );
        await original.close();
    });
