import { describe, expect, test } from 'bun:test';

import { ManagedRun, type WorkbenchEvent } from '../src/execution.js';

async function collect(events: AsyncIterable<WorkbenchEvent>) {
    const collected: WorkbenchEvent[] = [];
    for await (const event of events) collected.push(event);
    return collected;
}

describe('managed execution contract v0', () => {
    test('rejects empty run and runner identifiers', () => {
        expect(
            () => new ManagedRun({ runId: ' ', runner: 'fake', onInput() {} })
        ).toThrow('runId must not be empty');
        expect(
            () => new ManagedRun({ runId: 'run-1', runner: ' ', onInput() {} })
        ).toThrow('runner must not be empty');
    });

    test('emits ordered protocol-versioned events', async () => {
        const run = new ManagedRun({
            runId: 'run-1',
            runner: 'fake',
            onInput() {},
            now: () => new Date('2026-08-17T12:00:00.000Z'),
        });
        run.emit('run.started', {});
        run.emit('output.text', { text: 'hello' });
        run.complete();

        const events = await collect(run.events);
        expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
        expect(events.map((event) => event.type)).toEqual([
            'run.started',
            'output.text',
            'run.completed',
        ]);
        expect(events[0]).toMatchObject({
            protocol: 0,
            run_id: 'run-1',
            runner: 'fake',
            timestamp: '2026-08-17T12:00:00.000Z',
        });
    });

    test('delivers an event to a waiting consumer', async () => {
        const run = new ManagedRun({ runId: 'run-1', runner: 'fake', onInput() {} });
        const iterator = run.events[Symbol.asyncIterator]();
        const waiting = iterator.next();
        run.emit('run.ready', {});

        await expect(waiting).resolves.toMatchObject({
            done: false,
            value: { type: 'run.ready' },
        });
        await run.close();
    });

    test('normalizes and forwards follow-up input', async () => {
        const inputs: string[] = [];
        const run = new ManagedRun({
            runId: 'run-1',
            runner: 'fake',
            onInput(input) {
                inputs.push(input);
            },
        });

        await run.send('  follow up  ');
        expect(inputs).toEqual(['follow up']);
        await run.close();
    });

    test('rejects blank follow-up input', async () => {
        const run = new ManagedRun({ runId: 'run-1', runner: 'fake', onInput() {} });
        await expect(run.send('   ')).rejects.toThrow('input must not be empty');
        await run.close();
    });

    test('graceful close runs cleanup and completes exactly once', async () => {
        let closes = 0;
        const run = new ManagedRun({
            runId: 'run-1',
            runner: 'fake',
            onInput() {},
            onClose() {
                closes += 1;
            },
        });
        const events = collect(run.events);

        await Promise.all([run.close(), run.close()]);
        expect(closes).toBe(1);
        await expect(run.result).resolves.toEqual({
            runId: 'run-1',
            status: 'completed',
        });
        expect((await events).at(-1)?.type).toBe('run.completed');
    });

    test('cancellation is idempotent and carries its reason', async () => {
        let cancellations = 0;
        const run = new ManagedRun({
            runId: 'run-1',
            runner: 'fake',
            onInput() {},
            onCancel() {
                cancellations += 1;
            },
        });
        const events = collect(run.events);

        await Promise.all([run.cancel('user left'), run.cancel('ignored')]);
        expect(cancellations).toBe(1);
        await expect(run.result).resolves.toEqual({
            runId: 'run-1',
            status: 'cancelled',
        });
        expect((await events).at(-1)).toMatchObject({
            type: 'run.cancelled',
            data: { reason: 'user left' },
        });
    });

    test('converts close failures into a terminal failed result', async () => {
        const run = new ManagedRun({
            runId: 'run-1',
            runner: 'fake',
            onInput() {},
            onClose() {
                throw new Error('cleanup failed');
            },
        });
        const events = collect(run.events);

        await run.close();
        await expect(run.result).resolves.toEqual({
            runId: 'run-1',
            status: 'failed',
            error: { message: 'cleanup failed' },
        });
        expect((await events).at(-1)).toMatchObject({
            type: 'run.failed',
            data: { message: 'cleanup failed' },
        });
    });

    test('rejects input after the run becomes terminal', async () => {
        const run = new ManagedRun({ runId: 'run-1', runner: 'fake', onInput() {} });
        run.complete();
        await expect(run.send('too late')).rejects.toThrow(
            'run is not accepting input'
        );
        expect(() => run.emit('output.text', {})).toThrow('run is already terminal');
    });

    test('preserves runner-native data in the fallback event', async () => {
        const native = { type: 'vendor.new_event', nested: { value: 42 } };
        const run = new ManagedRun({ runId: 'run-1', runner: 'fake', onInput() {} });
        run.emit('runner.event', native);
        run.complete();

        const events = await collect(run.events);
        expect(events[0]?.data).toEqual(native);
    });
});
