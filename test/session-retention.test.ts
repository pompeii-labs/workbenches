import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunStore, type StoredRunStatus } from '../src/runs/index.js';
import type { ManagedDockerContainer } from '../src/runtimes/index.js';
import {
    type ManagedContainerStorage,
    SessionRetention,
    SessionStore,
} from '../src/sessions/index.js';

const homes: string[] = [];

afterEach(async () => {
    await Promise.all(
        homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))
    );
});

describe('Workbench session retention', () => {
    test('keeps terminal history newer than the cutoff', async () => {
        const home = await temporaryHome();
        const runs = new RunStore(home);
        const sessions = new SessionStore(home);
        const id = RunStore.createId();
        await fixtureSession(sessions, id, id);
        await fixtureRun(runs, id, id, 'completed');

        const retention = new SessionRetention(home);
        const review = await retention.review({
            before: new Date(Date.now() - 60_000),
        });

        expect(review.sessions).toEqual([]);
        expect(review.runs).toEqual([]);
        expect((await runs.read(id)).status).toBe('completed');
    });

    test('removes old terminal history while protecting active and resumable sessions', async () => {
        const home = await temporaryHome();
        const runs = new RunStore(home);
        const sessions = new SessionStore(home);

        const disposableId = RunStore.createId();
        await fixtureSession(sessions, disposableId, disposableId);
        await fixtureRun(runs, disposableId, disposableId, 'completed');

        const resumableId = RunStore.createId();
        const historicalId = RunStore.createId();
        const latestId = RunStore.createId();
        await fixtureSession(sessions, resumableId, historicalId);
        await fixtureRun(runs, historicalId, resumableId, 'completed');
        await fixtureRun(runs, latestId, resumableId, 'completed');
        await sessions.update(resumableId, {
            native_session_id: 'ses_native_retained',
            latest_run_id: latestId,
        });

        const activeId = RunStore.createId();
        await fixtureSession(sessions, activeId, activeId);
        await fixtureRun(runs, activeId, activeId, 'running', process.pid);

        const missingRunId = RunStore.createId();
        const containerStorage = new FixtureContainers([
            container('a'.repeat(12), disposableId, '1'.repeat(20)),
            container('b'.repeat(12), missingRunId, '2'.repeat(20)),
            container('c'.repeat(12), activeId, '3'.repeat(20)),
        ]);
        await Bun.sleep(2);
        const policy = { before: new Date() };
        const retention = new SessionRetention(home, {
            containers: containerStorage,
        });

        const review = await retention.review(policy);
        expect(review.sessions.map((item) => item.id)).toEqual([disposableId]);
        expect(review.runs.map((item) => item.id).toSorted()).toEqual(
            [disposableId, historicalId].toSorted()
        );
        expect(review.activeRuns).toEqual([activeId]);
        expect(review.protectedResumableSessions).toEqual([resumableId]);
        expect(review.containers.map((item) => item.id).toSorted()).toEqual([
            'a'.repeat(12),
            'b'.repeat(12),
        ]);
        expect(review.bytes).toBeGreaterThan(0);

        const result = await retention.apply(policy);
        expect(result.removedSessions).toEqual([disposableId]);
        expect(result.removedRuns.toSorted()).toEqual(
            [disposableId, historicalId].toSorted()
        );
        expect(result.removedContainers.toSorted()).toEqual([
            'a'.repeat(12),
            'b'.repeat(12),
        ]);
        await expect(sessions.read(disposableId)).rejects.toThrow(
            'Workbench session does not exist'
        );
        await expect(runs.read(disposableId)).rejects.toThrow(
            'Workbench run does not exist'
        );
        await expect(runs.read(historicalId)).rejects.toThrow(
            'Workbench run does not exist'
        );
        expect(await sessions.read(resumableId)).toMatchObject({
            latest_run_id: latestId,
            native_session_id: 'ses_native_retained',
        });
        expect((await runs.read(latestId)).status).toBe('completed');
        expect((await runs.read(activeId)).status).toBe('running');
        expect(containerStorage.removed.toSorted()).toEqual([
            'a'.repeat(12),
            'b'.repeat(12),
        ]);
    });

    test('requires an explicit policy to remove resumable native context', async () => {
        const home = await temporaryHome();
        const runs = new RunStore(home);
        const sessions = new SessionStore(home);
        const id = RunStore.createId();
        await fixtureSession(sessions, id, id);
        await fixtureRun(runs, id, id, 'completed');
        await sessions.update(id, { native_session_id: 'ses_native_explicit' });
        await Bun.sleep(2);

        const retention = new SessionRetention(home);
        expect((await retention.review({ before: new Date() })).sessions).toEqual([]);
        const result = await retention.apply({
            before: new Date(),
            includeResumableSessions: true,
        });

        expect(result.removedSessions).toEqual([id]);
        expect(result.removedRuns).toEqual([id]);
        await expect(sessions.read(id)).rejects.toThrow(
            'Workbench session does not exist'
        );
    });
});

class FixtureContainers implements ManagedContainerStorage {
    readonly removed: string[] = [];

    constructor(private readonly containers: ManagedDockerContainer[]) {}

    list(): Promise<ManagedDockerContainer[]> {
        return Promise.resolve(this.containers);
    }

    remove(container: ManagedDockerContainer): Promise<void> {
        this.removed.push(container.id);
        return Promise.resolve();
    }
}

async function temporaryHome(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'workbench-retention-'));
    homes.push(home);
    return home;
}

function fixtureSession(store: SessionStore, id: string, latestRunId: string) {
    return store.create({
        id,
        workbench: 'fixture-core',
        workbench_version: '0.1.0',
        runner: 'opencode',
        model: 'openai/gpt-5.6-terra',
        runtime: 'local',
        reference: 'fixture-core',
        workbench_path: '/repo/.workbenches/core',
        workspace: '/repo',
        workspaces: [],
        latest_run_id: latestRunId,
    });
}

async function fixtureRun(
    store: RunStore,
    id: string,
    sessionId: string,
    status: StoredRunStatus,
    pid?: number
) {
    await store.create({
        id,
        metadata: {
            workbench: 'fixture-core',
            workbench_version: '0.1.0',
            runner: 'opencode',
            model: 'openai/gpt-5.6-terra',
            workspace: '/repo',
            mode: 'interactive',
            execution: 'session',
            session_id: sessionId,
        },
        request: {
            workbench_path: '/repo/.workbenches/core',
            workspace: '/repo',
            task: '',
        },
    });
    await store.update(id, {
        status,
        ...(pid ? { pid } : {}),
        ...(RunStore.isTerminal(status)
            ? { finished_at: new Date().toISOString(), exit_code: 0 }
            : {}),
    });
}

function container(id: string, runId: string, suffix: string): ManagedDockerContainer {
    return { id, runId, name: `workbench-${suffix}` };
}
