import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkbenchEvent } from '../src/runs/index.js';
import { RunDispatcher, RunStore } from '../src/runs/index.js';
import { SessionStore } from '../src/sessions/index.js';
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

    test('continues event observation after a persisted sequence cursor', async () => {
        const home = await temporaryHome();
        const store = new RunStore(home);
        const run = await fixtureRun(home);
        await store.appendEvent(run.id, event(run.id, 1, 'run.started'));
        await store.appendEvent(run.id, event(run.id, 2, 'run.started'));
        await store.appendEvent(run.id, event(run.id, 3, 'run.completed'));
        await store.update(run.id, { status: 'completed' });

        const events: WorkbenchEvent[] = [];
        for await (const next of store.follow(run.id, {
            afterSequence: 2,
            pollMilliseconds: 1,
        })) {
            events.push(next);
        }

        expect(events.map((next) => next.sequence)).toEqual([3]);
    });

    test('drains events appended before terminal metadata becomes visible', async () => {
        const home = await temporaryHome();
        const store = new RunStore(home);
        const run = await fixtureRun(home);
        await store.appendEvent(run.id, event(run.id, 1, 'run.started'));
        const iterator = store
            .follow(run.id, { pollMilliseconds: 1 })
            [Symbol.asyncIterator]();

        expect(await iterator.next()).toMatchObject({
            done: false,
            value: { sequence: 1, type: 'run.started' },
        });
        await store.appendEvent(run.id, event(run.id, 2, 'run.completed'));
        await store.update(run.id, { status: 'completed' });

        expect(await iterator.next()).toMatchObject({
            done: false,
            value: { sequence: 2, type: 'run.completed' },
        });
        expect(await iterator.next()).toEqual({ done: true, value: undefined });
    });

    test('stops live event observation when its client detaches', async () => {
        const home = await temporaryHome();
        const store = new RunStore(home);
        const run = await fixtureRun(home);
        const controller = new AbortController();
        const iterator = store
            .follow(run.id, {
                signal: controller.signal,
                pollMilliseconds: 100,
            })
            [Symbol.asyncIterator]();
        const pending = iterator.next();

        await Bun.sleep(5);
        controller.abort();

        expect(await pending).toEqual({ done: true, value: undefined });
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

    test('marks abandoned worker records as failed during reconciliation', async () => {
        const home = await temporaryHome();
        const store = new RunStore(home);
        const run = await fixtureRun(home);
        await store.update(run.id, {
            status: 'running',
            pid: 2_147_483_647,
            started_at: '2026-08-18T00:00:00.000Z',
        });

        expect(await store.reconcile(await store.read(run.id))).toMatchObject({
            status: 'failed',
            exit_code: 1,
        });
        expect((await store.readEvents(run.id)).at(-1)).toMatchObject({
            type: 'run.failed',
            data: { message: 'Workbench run worker exited unexpectedly' },
        });
    });

    test('reconciles an abandoned worker exactly once across concurrent readers', async () => {
        const home = await temporaryHome();
        const store = new RunStore(home);
        const run = await fixtureRun(home);
        await store.update(run.id, {
            status: 'running',
            pid: 2_147_483_647,
            started_at: '2026-08-18T00:00:00.000Z',
        });

        const [first, second] = await Promise.all([
            store.reconcile(await store.read(run.id)),
            store.reconcile(await store.read(run.id)),
        ]);

        expect(first.status).toBe('failed');
        expect(second.status).toBe('failed');
        expect(
            (await store.readEvents(run.id)).filter(
                (candidate) => candidate.type === 'run.failed'
            )
        ).toHaveLength(1);
    });

    test('recovers terminal metadata from the event written before a worker exit', async () => {
        const home = await temporaryHome();
        const store = new RunStore(home);
        const cases = [
            { type: 'run.completed' as const, status: 'completed', exitCode: 0 },
            { type: 'run.cancelled' as const, status: 'cancelled', exitCode: 130 },
            { type: 'run.failed' as const, status: 'failed', exitCode: 17 },
        ];
        for (const candidate of cases) {
            const run = await fixtureRun(home);
            await store.update(run.id, {
                status: 'running',
                pid: 2_147_483_647,
                started_at: '2026-08-18T00:00:00.000Z',
            });
            await store.appendEvent(run.id, {
                ...event(run.id, 1, candidate.type),
                timestamp: '2026-08-18T00:00:01.000Z',
                data: { exit_code: candidate.exitCode },
            });

            expect(await store.reconcile(await store.read(run.id))).toMatchObject({
                status: candidate.status,
                exit_code: candidate.exitCode,
                finished_at: '2026-08-18T00:00:01.000Z',
            });
            expect(await store.readEvents(run.id)).toHaveLength(1);
        }
    });

    test('measures and removes only terminal run storage', async () => {
        const home = await temporaryHome();
        const store = new RunStore(home);
        const active = await fixtureRun(home);
        const terminal = await fixtureRun(home);
        await store.update(terminal.id, { status: 'completed' });

        expect(await store.size(terminal.id)).toBeGreaterThan(0);
        await expect(store.removeTerminal(active.id)).rejects.toThrow(
            'Active Workbench run cannot be removed'
        );
        await store.removeTerminal(terminal.id);
        await expect(store.read(terminal.id)).rejects.toThrow(
            'Workbench run does not exist'
        );
        expect((await store.read(active.id)).status).toBe('dispatched');
    });

    test('lists runs newest first across execution modes', async () => {
        const home = await temporaryHome();
        const store = new RunStore(home);
        const foreground = await fixtureRun(home, 'task', 'foreground');
        await new Promise((resolve) => setTimeout(resolve, 2));
        const completed = await fixtureRun(home);
        await store.update(completed.id, { status: 'completed' });
        await new Promise((resolve) => setTimeout(resolve, 2));
        const active = await fixtureRun(home);

        expect((await store.list()).map((run) => run.id)).toEqual([
            active.id,
            completed.id,
            foreground.id,
        ]);
    });

    test('stores the Workbench reference without derived routes or credentials', async () => {
        const home = await temporaryHome();
        const store = new RunStore(home);
        const resolved = await fixtureReference(home, 'pi');
        const run = await new RunDispatcher(home).prepare({
            resolved,
            task: 'inspect',
            mode: 'detached',
            reference: 'publisher/project#core',
        });

        expect(run).toMatchObject({
            runner: 'pi',
            model: 'manifest/model',
            runtime: 'local',
        });
        const request = await store.takeRequest(run.id);
        expect(request.reference).toBe('publisher/project#core');
        expect(JSON.stringify(request)).not.toContain('authenticated');
        expect(JSON.stringify(request)).not.toContain('provider');
    });

    test('links every interactive execution to one stable native session', async () => {
        const home = await temporaryHome();
        const dispatcher = new RunDispatcher(home);
        const runs = new RunStore(home);
        const sessions = new SessionStore(home);
        const resolved = await fixtureReference(home, 'opencode');
        const first = await dispatcher.prepare({
            resolved,
            mode: 'interactive',
            reference: 'creator',
            workspaces: [
                {
                    name: 'application',
                    path: '/workspace/application',
                    access: 'read-write',
                },
            ],
        });

        expect(first.session_id).toBe(first.id);
        const created = await sessions.read(first.id);
        expect(created).toMatchObject({
            id: first.id,
            latest_run_id: first.id,
            reference: 'creator',
        });
        expect(created.native_session_id).toBeUndefined();
        const firstRequest = await runs.takeRequest(first.id);
        expect(firstRequest.session_id).toBe(first.id);
        expect(firstRequest.native_session_id).toBeUndefined();

        const ready = await sessions.update(created.id, {
            native_session_id: 'ses_native_1',
        });
        const second = await dispatcher.prepare({
            resolved,
            mode: 'interactive',
            session: ready,
        });
        expect(second).toMatchObject({
            session_id: first.id,
            resumed_from: first.id,
        });
        expect(await runs.takeRequest(second.id)).toMatchObject({
            session_id: first.id,
            native_session_id: 'ses_native_1',
            workspaces: ready.workspaces,
        });
        expect((await sessions.read(first.id)).latest_run_id).toBe(second.id);
    });

    test('rejects resuming a session with a different locked Workbench', async () => {
        const home = await temporaryHome();
        const dispatcher = new RunDispatcher(home);
        const resolved = await fixtureReference(home, 'opencode');
        const first = await dispatcher.prepare({
            resolved,
            mode: 'interactive',
        });
        const session = await new SessionStore(home).update(first.id, {
            native_session_id: 'ses_native_1',
        });
        const changed = await fixtureReference(home, 'pi');

        await expect(
            dispatcher.prepare({
                resolved: changed,
                mode: 'interactive',
                session,
            })
        ).rejects.toThrow('does not match the resolved Workbench package');
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

function event(
    id: string,
    sequence: number,
    type: 'run.started' | 'run.completed' | 'run.failed' | 'run.cancelled'
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

async function fixtureReference(
    home: string,
    runner: string
): Promise<ResolvedWorkbenchReference> {
    const repository = join(home, 'repository');
    const packageDirectory = join(repository, '.workbenches', 'core');
    await mkdir(packageDirectory, { recursive: true });
    await Promise.all([
        writeFile(
            join(packageDirectory, 'workbench.yml'),
            [
                'spec: 0',
                'version: 0.1.0',
                'name: fixture-core',
                `runner: ${runner}`,
                'model:',
                '  id: manifest/model',
                'instructions: ./instructions.md',
                'runtime: local',
                'skills: []',
                'tools: []',
                'mcps: []',
                'env: {}',
                '',
            ].join('\n')
        ),
        writeFile(join(packageDirectory, 'instructions.md'), '# Fixture\n'),
    ]);
    return {
        workspaceDirectory: '/workspace',
        cleanup: async () => {},
        workbench: {
            manifestPath: join(packageDirectory, 'workbench.yml'),
            packageDirectory,
            repositoryDirectory: repository,
            instructionsPath: join(packageDirectory, 'instructions.md'),
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
