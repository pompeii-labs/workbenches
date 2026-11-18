import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Connection } from '../src/database/connection.js';
import { ProcessProbe } from '../src/processes/probe.js';
import { RunControl } from '../src/runs/control.js';
import { StoredRunHandle } from '../src/runs/handle.js';
import { RunStore, type StoredRun } from '../src/runs/store.js';

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

describe('durable run control', () => {
    test('delivers private input once and persists only a payload-free receipt', async () => {
        const { home, connection, runs } = await environment();
        const run = await fixtureRun(runs);
        const control = new RunControl(connection, run.id, {
            pollMilliseconds: 1,
            timeoutMilliseconds: 1_000,
        });
        const submitted = control.submit({
            kind: 'send',
            input: '  private prompt value  ',
        });

        const request = await control.receive();
        expect(request).toMatchObject({
            kind: 'send',
            input: { text: 'private prompt value', images: [] },
        });
        expect(await readdir(home)).not.toContain('runs');
        await control.resolve(required(request), {
            outcome: 'accepted',
            disposition: 'delivered',
        });

        await expect(submitted).resolves.toMatchObject({
            kind: 'send',
            outcome: 'accepted',
            disposition: 'delivered',
        });
        expect(await control.receive(AbortSignal.abort())).toBeUndefined();
        const storedControl = await controlText(connection, run.id);
        expect(storedControl).not.toContain('private prompt value');
    });

    test('claims follow-ups in submission order', async () => {
        const { connection, runs } = await environment();
        const run = await fixtureRun(runs);
        const control = new RunControl(connection, run.id, {
            pollMilliseconds: 1,
            timeoutMilliseconds: 1_000,
        });
        const first = control.submit({ kind: 'follow_up', input: 'first' });
        await waitForPending(connection, run.id, 1);
        const second = control.submit({ kind: 'follow_up', input: 'second' });
        await waitForPending(connection, run.id, 2);

        const firstRequest = await control.receive();
        expect(firstRequest?.input?.text).toBe('first');
        await control.resolve(required(firstRequest), {
            outcome: 'accepted',
            disposition: 'queued',
        });
        const secondRequest = await control.receive();
        expect(secondRequest?.input?.text).toBe('second');
        await control.resolve(required(secondRequest), {
            outcome: 'accepted',
            disposition: 'queued',
        });

        await Promise.all([first, second]);
    });

    test('returns rejected receipts without copying input into the receipt', async () => {
        const { connection, runs } = await environment();
        const run = await fixtureRun(runs);
        const control = new RunControl(connection, run.id, {
            pollMilliseconds: 1,
            timeoutMilliseconds: 1_000,
        });
        const submitted = control.submit({ kind: 'steer', input: 'not now' });
        const request = await control.receive();
        await control.resolve(required(request), {
            outcome: 'rejected',
            code: 'turn_idle',
            message: 'No turn is active',
        });

        const receipt = await submitted;
        expect(receipt).toMatchObject({
            outcome: 'rejected',
            error: { code: 'turn_idle', message: 'No turn is active' },
        });
        expect(JSON.stringify(receipt)).not.toContain('not now');
    });

    test('reports control timeouts without exposing internal request IDs', async () => {
        const { connection, runs } = await environment();
        const run = await fixtureRun(runs);
        const control = new RunControl(connection, run.id, {
            pollMilliseconds: 1,
            timeoutMilliseconds: 2,
        });

        let error: unknown;
        try {
            await control.submit({ kind: 'send', input: 'private prompt value' });
        } catch (cause) {
            error = cause;
        }
        if (!(error instanceof Error)) throw new Error('Expected a timeout error');

        expect(error.message).toContain('did not acknowledge the message');
        expect(error.message).toContain('wb ps');
        expect(error.message).not.toContain('ctl_');
        expect(error.message).not.toContain(run.id);
    });
});

describe('stored run handle', () => {
    test('submits typed control and resolves terminal state from the run store', async () => {
        const { connection, runs } = await environment();
        const run = await fixtureRun(runs);
        const handle = new StoredRunHandle(runs, connection, run.id);
        const control = new RunControl(connection, run.id, {
            pollMilliseconds: 1,
        });
        const submitted = handle.send('inspect');
        const request = await control.receive();
        await control.resolve(required(request), {
            outcome: 'accepted',
            disposition: 'delivered',
        });
        await expect(submitted).resolves.toMatchObject({
            outcome: 'accepted',
            disposition: 'delivered',
        });

        await runs.update(run.id, {
            status: 'completed',
            finished_at: new Date().toISOString(),
            exit_code: 0,
        });
        await expect(handle.result).resolves.toEqual({
            runId: run.id,
            status: 'completed',
        });
    });

    test('rejects new input after a run becomes terminal', async () => {
        const { connection, runs } = await environment();
        const run = await fixtureRun(runs);
        await runs.update(run.id, { status: 'cancelled' });
        const handle = new StoredRunHandle(runs, connection, run.id);

        await expect(handle.steer('too late')).rejects.toThrow(
            `Workbench run is already cancelled: ${run.id}`
        );
        await expect(handle.result).resolves.toEqual({
            runId: run.id,
            status: 'cancelled',
        });
    });

    test('rejects the result when its worker exits without a terminal state', async () => {
        const { connection, runs } = await environment();
        const run = await fixtureRun(runs);
        await runs.update(run.id, {
            status: 'running',
            pid: 2_147_483_647,
        });

        const handle = new StoredRunHandle(runs, connection, run.id);

        await expect(handle.result).rejects.toThrow(
            `Workbench run worker exited unexpectedly: ${run.id}`
        );
    });

    test('preserves control invocation order from the same handle', async () => {
        const { connection, runs } = await environment();
        const run = await fixtureRun(runs);
        const handle = new StoredRunHandle(runs, connection, run.id);
        const control = new RunControl(connection, run.id, {
            pollMilliseconds: 1,
            timeoutMilliseconds: 1_000,
        });

        const sent = handle.send('cancel after this is delivered');
        const cancelled = handle.cancelTurn();
        const sendRequest = required(await control.receive());
        expect(sendRequest.kind).toBe('send');
        expect(await pendingCount(connection, run.id)).toBe(0);

        await control.resolve(sendRequest, {
            outcome: 'accepted',
            disposition: 'delivered',
        });
        await sent;
        const cancelRequest = required(await control.receive());
        expect(cancelRequest.kind).toBe('cancel_turn');
        await control.resolve(cancelRequest, {
            outcome: 'accepted',
            disposition: 'cancelled',
        });
        await cancelled;
        await runs.update(run.id, {
            status: 'completed',
            finished_at: new Date().toISOString(),
            exit_code: 0,
        });
        await expect(handle.result).resolves.toEqual({
            runId: run.id,
            status: 'completed',
        });
    });
});

async function environment(): Promise<{
    home: string;
    connection: Connection;
    runs: RunStore;
}> {
    const home = await mkdtemp(join(tmpdir(), 'workbench-control-'));
    temporaryDirectories.push(home);
    const connection = Connection.open(home);
    connections.push(connection);
    return {
        home,
        connection,
        runs: new RunStore(connection, home, new ProcessProbe()),
    };
}

function fixtureRun(runs: RunStore): Promise<StoredRun> {
    return runs.create({
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
            workspace: '/workspace',
            task: '',
        },
    });
}

async function waitForPending(connection: Connection, runId: string, count: number) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await pendingCount(connection, runId)) >= count) return;
        await Bun.sleep(1);
    }
    throw new Error(`Timed out waiting for ${count} control requests`);
}

async function pendingCount(connection: Connection, runId: string): Promise<number> {
    const row = connection.one(
        "SELECT count(*) AS n FROM control_requests WHERE run_id = ? AND state = 'pending'",
        runId
    );
    return Number(row?.n ?? 0);
}

async function controlText(connection: Connection, runId: string): Promise<string> {
    return [
        ...connection.all(
            'SELECT payload FROM control_requests WHERE run_id = ?',
            runId
        ),
        ...connection.all(
            'SELECT payload FROM control_receipts WHERE run_id = ?',
            runId
        ),
    ]
        .map((row) => String(row.payload))
        .join('\n');
}

function required<T>(value: T | undefined): T {
    if (value === undefined) throw new Error('Expected a control request');
    return value;
}
