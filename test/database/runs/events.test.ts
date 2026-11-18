import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Connection } from '../../../src/database/connection.js';
import { ProcessProbe } from '../../../src/processes/probe.js';
import { DuplicateEventSequenceError } from '../../../src/runs/error.js';
import { RunStore } from '../../../src/runs/store.js';

/** The event log stores no event larger than this. */
const MAXIMUM_EVENT_BYTES = 4 * 1024 * 1024;

const directories: string[] = [];
const connections: Connection[] = [];

afterEach(async () => {
    for (const connection of connections.splice(0)) connection.close();
    await Promise.all(
        directories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('event size cap', () => {
    test('keeps an oversized event in sequence with its data replaced', async () => {
        const home = await temporaryHome();
        const connection = Connection.open(home);
        connections.push(connection);
        const store = new RunStore(connection, home, new ProcessProbe());
        const run = await store.create({
            metadata: {
                workbench: 'fixture-core',
                workbench_version: '0.1.0',
                runner: 'opencode',
                model: 'openai/gpt-5.6-terra',
                workspace: '/workspace',
            },
            request: {
                workbench_path: '/repo/.workbenches/core',
                workspace: '/w',
                task: '',
            },
        });
        const event = (sequence: number, data: unknown) => ({
            protocol: 0 as const,
            run_id: run.id,
            sequence,
            timestamp: '2026-08-18T00:00:00.000Z',
            type: 'tool.completed' as const,
            runner: 'opencode',
            data,
        });
        const oversized = 'x'.repeat(MAXIMUM_EVENT_BYTES + 1);

        await store.appendEvent(run.id, event(1, { output: 'small' }));
        await store.appendEvent(run.id, event(2, { output: oversized }));
        await store.appendEvent(run.id, event(3, { output: 'after' }));

        const events = await store.readEvents(run.id);
        expect(events.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
        expect(events[0]?.data).toEqual({ output: 'small' });
        expect(events[1]).toMatchObject({
            run_id: run.id,
            sequence: 2,
            type: 'tool.completed',
            data: {
                truncated: true,
                original_bytes: expect.any(Number),
                limit_bytes: MAXIMUM_EVENT_BYTES,
            },
        });
        expect(events[2]?.data).toEqual({ output: 'after' });
        const duplicate = store.appendEvent(run.id, event(3, {}));
        await expect(duplicate).rejects.toBeInstanceOf(DuplicateEventSequenceError);
        await expect(duplicate).rejects.toThrow('Duplicate event sequence 3');
    });
});

async function temporaryHome(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-events-'));
    directories.push(directory);
    return directory;
}
