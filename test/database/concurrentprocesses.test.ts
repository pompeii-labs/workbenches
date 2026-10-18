import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Connection } from '../../src/database/connection.js';
import { ProcessProbe } from '../../src/processes/probe.js';
import { RunControl } from '../../src/runs/control.js';
import { RunStore, type StoredRun } from '../../src/runs/store.js';

const process_ = join(import.meta.dir, 'process.ts');
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

describe('concurrent processes', () => {
    test('open one brand new home together without a locked database', async () => {
        const home = join(await temporaryHome(), 'fresh');
        const start = Date.now() + 1_500;
        const openers = Array.from({ length: 10 }, () =>
            Bun.spawn([process.execPath, process_, 'open', home, 'x', `${start}`], {
                stdout: 'pipe',
                stderr: 'pipe',
            })
        );
        const results = await Promise.all(
            openers.map(async (opener) => ({
                stdout: (await new Response(opener.stdout).text()).trim(),
                stderr: await new Response(opener.stderr).text(),
                code: await opener.exited,
            }))
        );

        expect(results.map((result) => result.stderr)).toEqual(Array(10).fill(''));
        expect(results.map((result) => result.code)).toEqual(Array(10).fill(0));
        expect(results.map((result) => result.stdout)).toEqual(
            Array(10).fill('opened')
        );
    });

    test('append events to one run without loss or duplicate sequences', async () => {
        const home = await temporaryHome();
        const connection = openConnection(home);
        const store = new RunStore(connection, home, new ProcessProbe());
        const run = await fixtureRun(store);

        const writers = [1, 2, 3, 4].map((writer) =>
            Bun.spawn(
                [process.execPath, process_, 'append', home, run.id, `${writer}`],
                {
                    stdout: 'pipe',
                    stderr: 'pipe',
                }
            )
        );
        const results = await Promise.all(
            writers.map(async (writer) => ({
                stderr: await new Response(writer.stderr).text(),
                code: await writer.exited,
            }))
        );

        expect(results.map((result) => result.stderr)).toEqual(['', '', '', '']);
        expect(results.map((result) => result.code)).toEqual([0, 0, 0, 0]);
        const events = await store.readEvents(run.id);
        expect(events).toHaveLength(160);
        expect(new Set(events.map((event) => event.sequence)).size).toBe(160);
        // Each writer's own events keep their order in the global stream.
        for (const writer of [1, 2, 3, 4]) {
            const own = events
                .filter((event) => Math.floor(event.sequence / 1000) === writer)
                .map((event) => event.sequence);
            expect(own).toEqual(
                Array.from({ length: 40 }, (_, i) => writer * 1000 + i + 1)
            );
        }
    });

    test('claim each control request exactly once', async () => {
        const home = await temporaryHome();
        const connection = openConnection(home);
        const run = await fixtureRun(
            new RunStore(connection, home, new ProcessProbe())
        );
        const receivers = [1, 2, 3].map(() =>
            Bun.spawn([process.execPath, process_, 'receive', home, run.id], {
                stdout: 'pipe',
                stderr: 'pipe',
            })
        );
        const control = new RunControl(connection, run.id, {
            pollMilliseconds: 2,
            timeoutMilliseconds: 20_000,
        });

        const receipts = await Promise.all(
            Array.from({ length: 30 }, (_, index) =>
                control.submit({ kind: 'send', input: `message ${index}` })
            )
        );
        for (const receiver of receivers) receiver.kill();
        const claimed = (
            await Promise.all(
                receivers.map(async (receiver) => {
                    const output = await new Response(receiver.stdout).text();
                    await receiver.exited;
                    return output.split('\n').filter(Boolean);
                })
            )
        ).flat();

        expect(receipts.every((receipt) => receipt.outcome === 'accepted')).toBeTrue();
        expect(claimed).toHaveLength(30);
        expect(new Set(claimed).size).toBe(30);
        expect(new Set(claimed)).toEqual(
            new Set(receipts.map((receipt) => receipt.id))
        );
    });
});

async function temporaryHome(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-concurrency-'));
    directories.push(directory);
    return directory;
}

function openConnection(home: string): Connection {
    const connection = Connection.open(home);
    connections.push(connection);
    return connection;
}

function fixtureRun(store: RunStore): Promise<StoredRun> {
    return store.create({
        metadata: {
            workbench: 'fixture-core',
            workbench_version: '0.1.0',
            runner: 'opencode',
            model: 'openai/gpt-5.6-terra',
            workspace: '/workspace',
            mode: 'interactive',
        },
        request: {
            workbench_path: '/repo/.workbenches/core',
            workspace: '/w',
            task: '',
        },
    });
}
