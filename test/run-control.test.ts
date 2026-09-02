import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunControl } from '../src/runs/control.js';
import { StoredRunHandle } from '../src/runs/handle.js';
import { RunStore, type StoredRun } from '../src/runs/store.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('durable run control', () => {
    test('delivers private input once and persists only a payload-free receipt', async () => {
        const home = await temporaryHome();
        const run = await fixtureRun(home);
        const control = new RunControl(home, run.id, {
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
        expect((await stat(join(home, 'runs', run.id, 'control'))).mode & 0o777).toBe(
            0o700
        );
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
        const storedControl = await controlText(home, run.id);
        expect(storedControl).not.toContain('private prompt value');
    });

    test('claims follow-ups in submission order', async () => {
        const home = await temporaryHome();
        const run = await fixtureRun(home);
        const control = new RunControl(home, run.id, {
            pollMilliseconds: 1,
            timeoutMilliseconds: 1_000,
        });
        const first = control.submit({ kind: 'follow_up', input: 'first' });
        await waitForPending(home, run.id, 1);
        const second = control.submit({ kind: 'follow_up', input: 'second' });
        await waitForPending(home, run.id, 2);

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
        const home = await temporaryHome();
        const run = await fixtureRun(home);
        const control = new RunControl(home, run.id, {
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
});

describe('stored run handle', () => {
    test('submits typed control and resolves terminal state from the run store', async () => {
        const home = await temporaryHome();
        const run = await fixtureRun(home);
        const handle = new StoredRunHandle(home, run.id);
        const control = new RunControl(home, run.id, {
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

        await new RunStore(home).update(run.id, {
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
        const home = await temporaryHome();
        const run = await fixtureRun(home);
        await new RunStore(home).update(run.id, { status: 'cancelled' });
        const handle = new StoredRunHandle(home, run.id);

        await expect(handle.steer('too late')).rejects.toThrow(
            `Workbench run is already cancelled: ${run.id}`
        );
        await expect(handle.result).resolves.toEqual({
            runId: run.id,
            status: 'cancelled',
        });
    });

    test('rejects the result when its worker exits without a terminal state', async () => {
        const home = await temporaryHome();
        const run = await fixtureRun(home);
        await new RunStore(home).update(run.id, {
            status: 'running',
            pid: 2_147_483_647,
        });

        const handle = new StoredRunHandle(home, run.id);

        await expect(handle.result).rejects.toThrow(
            `Workbench run worker exited unexpectedly: ${run.id}`
        );
    });

    test('preserves control invocation order from the same handle', async () => {
        const home = await temporaryHome();
        const run = await fixtureRun(home);
        const handle = new StoredRunHandle(home, run.id);
        const control = new RunControl(home, run.id, {
            pollMilliseconds: 1,
            timeoutMilliseconds: 1_000,
        });

        const sent = handle.send('cancel after this is delivered');
        const cancelled = handle.cancelTurn();
        const sendRequest = required(await control.receive());
        expect(sendRequest.kind).toBe('send');
        expect(await pendingCount(home, run.id)).toBe(0);

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
        await new RunStore(home).update(run.id, {
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

async function temporaryHome(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-control-'));
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
            mode: 'interactive',
        },
        request: {
            workbench_path: '/repo/.workbenches/core',
            workspace: '/workspace',
            task: '',
        },
    });
}

async function waitForPending(home: string, runId: string, count: number) {
    const directory = join(home, 'runs', runId, 'control', 'pending');
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await readdir(directory)).length >= count) return;
        await Bun.sleep(1);
    }
    throw new Error(`Timed out waiting for ${count} control requests`);
}

async function pendingCount(home: string, runId: string): Promise<number> {
    return (
        await readdir(join(home, 'runs', runId, 'control', 'pending')).catch(() => [])
    ).length;
}

async function controlText(home: string, runId: string): Promise<string> {
    const root = join(home, 'runs', runId, 'control');
    const contents: string[] = [];
    for (const directory of ['pending', 'active', 'receipts']) {
        for (const file of await readdir(join(root, directory))) {
            contents.push(await readFile(join(root, directory, file), 'utf8'));
        }
    }
    return contents.join('\n');
}

function required<T>(value: T | undefined): T {
    if (value === undefined) throw new Error('Expected a control request');
    return value;
}
