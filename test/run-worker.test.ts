import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Connection } from '../src/database/connection.js';
import type { WorkbenchRunOptions } from '../src/runs/index.js';
import {
    RunStore,
    RunWorker,
    type StoredRun,
    type WorkbenchEvent,
} from '../src/runs/index.js';
import { Services } from '../src/workbench/services.js';

const temporaryDirectories: string[] = [];
const connections: Connection[] = [];

afterEach(async () => {
    for (const connection of connections.splice(0)) connection.close();
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('stored one-shot worker', () => {
    test('exposes events and terminal state through the durable handle', async () => {
        const services = await environment();
        const run = await fixtureRun(services.runs);
        const worker = workerFor(services, {
            executeRun: async (options) => {
                await emit(options, run.id, 1, 'run.started');
                await emit(options, run.id, 2, 'run.completed');
                return 0;
            },
        });
        const handle = services.dispatcher.handle(run.id);

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

    test('hands the stored gpu acknowledgement to the run', async () => {
        const services = await environment();
        const run = await services.runs.create({
            metadata: {
                workbench: 'fixture-core',
                workbench_version: '0.1.0',
                runner: 'opencode',
                model: 'openrouter/openai/gpt-5.6-terra',
                workspace: '/workspace',
                mode: 'detached',
            },
            request: {
                workbench_path: '/repo/.workbenches/core',
                workspace: '/workspace',
                task: 'task',
                allow_unchecked_gpu: true,
            },
        });
        let received: WorkbenchRunOptions | undefined;
        const worker = workerFor(services, {
            executeRun: async (options) => {
                received = options;
                await emit(options, run.id, 1, 'run.completed');
                return 0;
            },
        });

        await worker.execute({ id: run.id });
        expect(received?.allowUncheckedGpu).toBe(true);
    });

    test('accepts run cancellation but rejects interactive input', async () => {
        const services = await environment();
        const run = await fixtureRun(services.runs);
        const started = deferred<void>();
        const worker = workerFor(services, {
            executeRun: async (options) => {
                await emit(options, run.id, 1, 'run.started');
                started.resolve();
                await aborted(required(options.signal));
                await emit(options, run.id, 2, 'run.cancelled');
                return 130;
            },
        });
        const handle = services.dispatcher.handle(run.id);
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
        const services = await environment();
        const run = await fixtureRun(services.runs);
        const worker = workerFor(services, {
            executeRun: async () => {
                throw new Error('fixture execution failed');
            },
        });

        await expect(worker.execute({ id: run.id })).resolves.toBe(1);
        expect(await services.runs.readEvents(run.id)).toEqual([
            expect.objectContaining({
                sequence: 1,
                type: 'run.failed',
                data: { message: 'fixture execution failed' },
            }),
        ]);
    });

    test('records the failure after another writer takes its sequence', async () => {
        const services = await environment();
        const run = await fixtureRun(services.runs);
        const original = RunStore.prototype.appendEvent;
        let raced = false;
        const append = spyOn(RunStore.prototype, 'appendEvent').mockImplementation(
            async function (this: RunStore, id, event) {
                if (!raced) {
                    raced = true;
                    await original.call(this, id, {
                        ...event,
                        type: 'output.text',
                        data: {},
                    });
                }
                return original.call(this, id, event);
            }
        );
        try {
            const worker = workerFor(services, {
                executeRun: async () => {
                    throw new Error('fixture execution failed');
                },
            });

            await expect(worker.execute({ id: run.id })).resolves.toBe(1);
        } finally {
            append.mockRestore();
        }

        expect(
            (await services.runs.readEvents(run.id)).map((event) => [
                event.sequence,
                event.type,
            ])
        ).toEqual([
            [1, 'output.text'],
            [2, 'run.failed'],
        ]);
        expect((await services.runs.read(run.id)).status).toBe('failed');
    });
});

type Environment = Services & { home: string; connection: Connection };

async function environment(): Promise<Environment> {
    const home = await mkdtemp(join(tmpdir(), 'workbench-worker-'));
    temporaryDirectories.push(home);
    const connection = Connection.open(home);
    connections.push(connection);
    return Object.assign(new Services(home, connection), { home, connection });
}

function workerFor(
    services: Environment,
    dependencies: ConstructorParameters<typeof RunWorker>[5]
): RunWorker {
    return new RunWorker(
        services.home,
        services.connection,
        services.runs,
        services.sessions,
        services.checkouts,
        dependencies
    );
}

function fixtureRun(runs: RunStore): Promise<StoredRun> {
    return runs.create({
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
