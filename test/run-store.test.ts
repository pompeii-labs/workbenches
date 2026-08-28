import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkbenchEvent } from '../src/runs/index.js';
import { RunDispatcher, RunStore } from '../src/runs/index.js';
import type { ResolvedWorkbenchReference } from '../src/workbench/index.js';

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
        const store = new RunStore(home);
        const run = await fixtureRun(home, 'secret task');
        const directory = join(home, 'runs', run.id);

        expect((await stat(directory)).mode & 0o777).toBe(0o700);
        expect((await stat(join(directory, 'run.json'))).mode & 0o777).toBe(0o600);
        expect((await stat(join(directory, 'request.json'))).mode & 0o777).toBe(0o600);
        expect(await store.takeRequest(run.id)).toMatchObject({
            task: 'secret task',
        });
        await expect(store.takeRequest(run.id)).rejects.toThrow(
            'request is unavailable'
        );
        expect(await readFile(join(directory, 'run.json'), 'utf8')).not.toContain(
            'secret task'
        );
    });

    test('replays events in order and stops after terminal metadata', async () => {
        const home = await temporaryHome();
        const store = new RunStore(home);
        const run = await fixtureRun(home);
        await store.appendEvent(run.id, event(run.id, 1, 'run.started'));
        await store.appendEvent(run.id, event(run.id, 2, 'run.completed'));
        await store.update(run.id, {
            status: 'completed',
            exit_code: 0,
            finished_at: '2026-08-18T00:00:01.000Z',
        });

        const events: WorkbenchEvent[] = [];
        for await (const next of store.follow(run.id, {
            pollMilliseconds: 1,
        })) {
            events.push(next);
        }
        expect(events.map((next) => next.sequence)).toEqual([1, 2]);
        expect((await store.read(run.id)).status).toBe('completed');
    });

    test('selects the latest dispatched run and rejects malformed IDs', async () => {
        const home = await temporaryHome();
        const store = new RunStore(home);
        const first = await fixtureRun(home);
        await new Promise((resolve) => setTimeout(resolve, 2));
        const second = await fixtureRun(home);

        expect((await store.latest()).id).toBe(second.id);
        expect(first.id).not.toBe(second.id);
        expect(() => RunStore.validateId('../../escape')).toThrow('Invalid run ID');
    });

    test('lists detached runs newest first with optional active filtering', async () => {
        const home = await temporaryHome();
        const store = new RunStore(home);
        const foreground = await fixtureRun(home, 'task', 'foreground');
        await new Promise((resolve) => setTimeout(resolve, 2));
        const completed = await fixtureRun(home);
        await store.update(completed.id, { status: 'completed' });
        await new Promise((resolve) => setTimeout(resolve, 2));
        const active = await fixtureRun(home);

        expect((await store.list({ detachedOnly: true })).map((run) => run.id)).toEqual(
            [active.id, completed.id]
        );
        expect(
            (
                await store.list({
                    detachedOnly: true,
                    activeOnly: true,
                })
            ).map((run) => run.id)
        ).toEqual([active.id]);
        expect((await store.list()).map((run) => run.id)).toContain(foreground.id);
    });

    test('requests private cooperative cancellation for active detached runs', async () => {
        const home = await temporaryHome();
        const store = new RunStore(home);
        const foreground = await fixtureRun(home, 'task', 'foreground');
        await new Promise((resolve) => setTimeout(resolve, 2));
        const detached = await fixtureRun(home, 'task', 'detached');
        let cancelled = false;
        const stop = store.watchCancellation(
            detached.id,
            () => {
                cancelled = true;
            },
            { pollMilliseconds: 1 }
        );

        await store.requestCancellation(detached.id);
        await waitFor(() => cancelled);
        expect((await store.latestActiveDetached()).id).toBe(detached.id);
        expect(
            (await stat(join(home, 'runs', detached.id, 'cancel'))).mode & 0o777
        ).toBe(0o600);
        await expect(store.requestCancellation(foreground.id)).rejects.toThrow(
            'is not a detached run'
        );

        stop();
        await store.clearCancellation(detached.id);
        await expect(stat(join(home, 'runs', detached.id, 'cancel'))).rejects.toThrow();
    });

    test('stores the Workbench reference without derived routes or credentials', async () => {
        const home = await temporaryHome();
        const store = new RunStore(home);
        const resolved = fixtureReference('pi');
        const run = await new RunDispatcher(home).prepare({
            resolved,
            task: 'inspect',
            mode: 'detached',
            reference: 'publisher/project#core',
        });

        expect(run).toMatchObject({
            runner: 'pi',
            model: 'manifest/model',
        });
        const request = await store.takeRequest(run.id);
        expect(request.reference).toBe('publisher/project#core');
        expect(JSON.stringify(request)).not.toContain('authenticated');
        expect(JSON.stringify(request)).not.toContain('provider');
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
    return new RunStore(home).create({
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

function fixtureReference(runner: string): ResolvedWorkbenchReference {
    return {
        workspaceDirectory: '/workspace',
        cleanup: async () => {},
        workbench: {
            manifestPath: '/repo/.workbenches/core/workbench.yml',
            packageDirectory: '/repo/.workbenches/core',
            repositoryDirectory: '/repo',
            instructionsPath: '/repo/.workbenches/core/instructions.md',
            skills: [],
            manifest: {
                spec: 0,
                version: '0.1.0',
                name: 'fixture-core',
                runner,
                model: { id: 'manifest/model' },
                instructions: './instructions.md',
                skills: [],
                tools: [],
                mcps: [],
                env: {},
                runtime: 'local',
            },
        },
    };
}
