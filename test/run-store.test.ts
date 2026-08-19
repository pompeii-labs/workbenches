import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WorkbenchEvent } from '../src/execution.js';
import {
    appendRunEvent,
    clearStoredRunCancellation,
    createStoredRun,
    followRunEvents,
    latestActiveDetachedRun,
    latestStoredRun,
    readStoredRun,
    requestStoredRunCancellation,
    takeStoredRunRequest,
    updateStoredRun,
    validateRunId,
    watchStoredRunCancellation,
} from '../src/run-store.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('durable Workbench runs', () => {
    test('stores private metadata and consumes the task request once', async () => {
        const home = await temporaryHome();
        const run = await fixtureRun(home, 'secret task');
        const directory = join(home, 'runs', run.id);

        expect((await stat(directory)).mode & 0o777).toBe(0o700);
        expect((await stat(join(directory, 'run.json'))).mode & 0o777).toBe(0o600);
        expect((await stat(join(directory, 'request.json'))).mode & 0o777).toBe(0o600);
        expect(await takeStoredRunRequest(home, run.id)).toMatchObject({
            task: 'secret task',
        });
        await expect(takeStoredRunRequest(home, run.id)).rejects.toThrow(
            'request is unavailable'
        );
        expect(await readFile(join(directory, 'run.json'), 'utf8')).not.toContain(
            'secret task'
        );
    });

    test('replays events in order and stops after terminal metadata', async () => {
        const home = await temporaryHome();
        const run = await fixtureRun(home);
        await appendRunEvent(home, run.id, event(run.id, 1, 'run.started'));
        await appendRunEvent(home, run.id, event(run.id, 2, 'run.completed'));
        await updateStoredRun(home, run.id, {
            status: 'completed',
            exit_code: 0,
            finished_at: '2026-08-18T00:00:01.000Z',
        });

        const events: WorkbenchEvent[] = [];
        for await (const next of followRunEvents(home, run.id, {
            pollMilliseconds: 1,
        })) {
            events.push(next);
        }
        expect(events.map((next) => next.sequence)).toEqual([1, 2]);
        expect((await readStoredRun(home, run.id)).status).toBe('completed');
    });

    test('selects the latest dispatched run and rejects malformed IDs', async () => {
        const home = await temporaryHome();
        const first = await fixtureRun(home);
        await new Promise((resolve) => setTimeout(resolve, 2));
        const second = await fixtureRun(home);

        expect((await latestStoredRun(home)).id).toBe(second.id);
        expect(first.id).not.toBe(second.id);
        expect(() => validateRunId('../../escape')).toThrow('Invalid run ID');
    });

    test('requests private cooperative cancellation for active detached runs', async () => {
        const home = await temporaryHome();
        const foreground = await fixtureRun(home, 'task', 'foreground');
        await new Promise((resolve) => setTimeout(resolve, 2));
        const detached = await fixtureRun(home, 'task', 'detached');
        let cancelled = false;
        const stop = watchStoredRunCancellation(
            home,
            detached.id,
            () => {
                cancelled = true;
            },
            { pollMilliseconds: 1 }
        );

        await requestStoredRunCancellation(home, detached.id);
        await waitFor(() => cancelled);
        expect((await latestActiveDetachedRun(home)).id).toBe(detached.id);
        expect(
            (await stat(join(home, 'runs', detached.id, 'cancel'))).mode & 0o777
        ).toBe(0o600);
        await expect(requestStoredRunCancellation(home, foreground.id)).rejects.toThrow(
            'is not a detached run'
        );

        stop();
        await clearStoredRunCancellation(home, detached.id);
        await expect(stat(join(home, 'runs', detached.id, 'cancel'))).rejects.toThrow();
    });
});

async function temporaryHome() {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-runs-'));
    temporaryDirectories.push(directory);
    return directory;
}

function fixtureRun(
    home: string,
    task = 'task',
    mode: 'foreground' | 'detached' = 'detached'
) {
    return createStoredRun({
        home,
        metadata: {
            workbench: 'fixture-core',
            workbench_version: '0.1.0',
            runner: 'opencode',
            model: 'openrouter/openai/gpt-5.6-terra',
            workspace: '/workspace',
            mode,
        },
        request: {
            workbench_path: '/repo/.workbenches/core',
            workspace: '/workspace',
            task,
        },
    });
}

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error('Timed out waiting for condition');
}

function event(
    id: string,
    sequence: number,
    type: 'run.started' | 'run.completed'
): WorkbenchEvent {
    return {
        protocol: 0,
        run_id: id,
        sequence,
        timestamp: '2026-08-18T00:00:00.000Z',
        type,
        runner: 'opencode',
        data: {},
    };
}
