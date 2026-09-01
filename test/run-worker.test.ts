import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WorkbenchRunOptions } from '../src/runs/index.js';
import {
    RunDispatcher,
    RunStore,
    RunWorker,
    type StoredRun,
    type WorkbenchEvent,
} from '../src/runs/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('stored one-shot worker', () => {
    test('exposes events and terminal state through the durable handle', async () => {
        const home = await temporaryHome();
        const run = await fixtureRun(home);
        const worker = new RunWorker(home, {
            executeRun: async (options) => {
                await emit(options, run.id, 1, 'run.started');
                await emit(options, run.id, 2, 'run.completed');
                return 0;
            },
        });
        const handle = new RunDispatcher(home).handle(run.id);

        await expect(worker.execute({ id: run.id })).resolves.toBe(0);
        await expect(handle.result).resolves.toEqual({
            runId: run.id,
            status: 'completed',
        });
        expect((await collect(handle.events)).map((event) => event.type)).toEqual([
            'run.started',
            'run.completed',
        ]);
    });

    test('accepts run cancellation but rejects interactive input', async () => {
        const home = await temporaryHome();
        const run = await fixtureRun(home);
        const started = deferred<void>();
        const worker = new RunWorker(home, {
            executeRun: async (options) => {
                await emit(options, run.id, 1, 'run.started');
                started.resolve();
                await aborted(required(options.signal));
                await emit(options, run.id, 2, 'run.cancelled');
                return 130;
            },
        });
        const handle = new RunDispatcher(home).handle(run.id);
        const execution = worker.execute({ id: run.id });
        await started.promise;

        await expect(handle.send('not interactive')).rejects.toThrow(
            'Workbench run is not interactive'
        );
        await expect(handle.cancel('stop')).resolves.toMatchObject({
            disposition: 'cancellation_requested',
        });
        await expect(execution).resolves.toBe(130);
        await expect(handle.result).resolves.toEqual({
            runId: run.id,
            status: 'cancelled',
        });
    });

    test('records one normalized failure when execution throws', async () => {
        const home = await temporaryHome();
        const run = await fixtureRun(home);
        const worker = new RunWorker(home, {
            executeRun: async () => {
                throw new Error('fixture execution failed');
            },
        });

        await expect(worker.execute({ id: run.id })).resolves.toBe(1);
        expect(await new RunStore(home).readEvents(run.id)).toEqual([
            expect.objectContaining({
                sequence: 1,
                type: 'run.failed',
                data: { message: 'fixture execution failed' },
            }),
        ]);
    });
});

async function temporaryHome(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-worker-'));
    temporaryDirectories.push(directory);
    return directory;
}

function fixtureRun(home: string): Promise<StoredRun> {
    return new RunStore(home).create({
        metadata: {
            workbench: 'fixture-core',
            workbench_version: '0.1.0',
            runner: 'opencode',
            model: 'openai/gpt-5.6-terra',
            workspace: '/workspace',
            mode: 'foreground',
        },
        request: {
            workbench_path: '/repo/.workbenches/core',
            workspace: '/workspace',
            task: 'inspect',
        },
    });
}

function emit(
    options: WorkbenchRunOptions,
    runId: string,
    sequence: number,
    type: WorkbenchEvent['type']
): Promise<void> | void {
    return options.onEvent?.({
        protocol: 0,
        run_id: runId,
        sequence,
        timestamp: '2026-09-01T12:00:00.000Z',
        type,
        runner: 'opencode',
        data: {},
    });
}

function collect(events: AsyncIterable<WorkbenchEvent>) {
    return Array.fromAsync(events);
}

function aborted(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true })
    );
}

function required<T>(value: T | undefined): T {
    if (value === undefined) throw new Error('Expected a value');
    return value;
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((next) => {
        resolve = next;
    });
    return { promise, resolve };
}
