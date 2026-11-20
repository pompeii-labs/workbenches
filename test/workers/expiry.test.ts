import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Connection } from '../../src/database/connection.js';
import { OutcomeStore } from '../../src/outcomes/store.js';
import { RunnerRegistry } from '../../src/runners/registry.js';
import {
    SessionRetention,
    type SessionRetentionPolicy,
} from '../../src/sessions/retention.js';
import { Services } from '../../src/workbench/services.js';
import type { WorkerAssignment } from '../../src/workers/assignments.js';
import { WorkerEngine } from '../../src/workers/engine.js';
import { WorkerSessionExpiry } from '../../src/workers/expiry.js';
import { WorkerHome } from '../../src/workers/home.js';
import { WorkerJanitor } from '../../src/workers/janitor.js';
import { TestRunEnvironment } from './fixture.js';
import { continuedRun, storedSession } from './storage.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function storage() {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-worker-expiry-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const home = new WorkerHome(directory);
    const connection = Connection.open(home.root);
    cleanups.push(() => connection.close());
    const services = new Services(home.root, connection);
    const janitor = new WorkerJanitor(home, services);
    return { directory, home, services, janitor };
}

const ended = '2026-01-01T00:00:00.000Z';
const boundary = new Date('2026-01-08T00:00:00.000Z');

function assignment(id: string): WorkerAssignment {
    return {
        run_id: id,
        session_id: id,
        workbench: 'fixture',
        runner: 'opencode',
        runtime: 'local',
        member_id: null,
        connection: null,
        started_by: null,
        task: '',
        accepted_at: ended,
        max_minutes: null,
        state: 'completed',
        observed: 0,
        uploaded: [],
        finished_at: ended,
    };
}

test('expires at seven days since the last run ended, not a session metadata update', async () => {
    const { home, services, janitor } = await storage();
    const id = await storedSession(services, home, { finished: ended });
    await services.sessions.rename(id, 'recent name');
    await janitor.sweep([], new Date(boundary.getTime() - 1));
    expect(await services.sessions.read(id)).toBeDefined();
    await janitor.sweep([], boundary);
    await expect(services.sessions.read(id)).rejects.toThrow('does not exist');
});

test('removes context, outcome blobs and workspace, preserving fresh, active and outside files', async () => {
    const { directory, home, services, janitor } = await storage();
    const old = await storedSession(services, home, { finished: ended });
    const fresh = await storedSession(services, home, {
        finished: boundary.toISOString(),
    });
    const active = await storedSession(services, home, {
        finished: ended,
        status: 'running',
    });
    const outside = await storedSession(services, home, {
        finished: ended,
        workspace: join(directory, 'outside'),
    });
    const linked = await storedSession(services, home, { finished: ended });
    await rm(home.workspaceDirectory(linked), { recursive: true });
    await symlink(join(directory, 'outside'), home.workspaceDirectory(linked));
    const outcomes = new OutcomeStore(home.root);
    const content = await outcomes.putBytes('expired artifact', 'text/plain');
    await outcomes.commit(
        {
            version: 1,
            id: OutcomeStore.createId(),
            run_id: old,
            created_at: ended,
            completeness: 'complete',
            changesets: [],
            links: [],
            warnings: [],
            artifacts: [{ id: 'result', name: 'result.txt', content }],
        },
        'present'
    );
    await outcomes.close();
    const removed = await janitor.sweep(
        [old, fresh, active, outside, linked].map(assignment),
        boundary
    );
    expect(removed.toSorted()).toEqual([old, outside, linked].toSorted());
    for (const id of [old, outside, linked]) {
        await expect(services.sessions.read(id)).rejects.toThrow('does not exist');
        await expect(services.runs.read(id)).rejects.toThrow('does not exist');
        expect(
            await stat(services.sessions.nativeDirectory(id)).catch(() => undefined)
        ).toBeUndefined();
    }
    expect(
        await stat(home.workspaceDirectory(old)).catch(() => undefined)
    ).toBeUndefined();
    expect(await outcomes.list()).toEqual([]);
    await expect(outcomes.blob(content)).rejects.toThrow('unavailable');
    for (const id of [fresh, active]) {
        expect(await services.sessions.read(id)).toBeDefined();
        expect(
            await readFile(join(home.workspaceDirectory(id), 'source.txt'), 'utf8')
        ).toBe('source');
        expect(await stat(services.sessions.nativeDirectory(id))).toBeDefined();
    }
    expect(await readFile(join(directory, 'outside', 'source.txt'), 'utf8')).toBe(
        'source'
    );
});

test('refuses cleanup through a linked storage root', async () => {
    const { directory, home, services, janitor } = await storage();
    const id = await storedSession(services, home, { finished: ended });
    await symlink(join(directory, 'outside'), join(home.root, 'packages'));
    await expect(janitor.sweep([], boundary)).rejects.toThrow('inside its home');
    expect(await services.sessions.read(id)).toBeDefined();
});

test('retains all earlier runs while a continuation is active or recently ended', async () => {
    const { home, services, janitor } = await storage();
    for (const status of ['running', 'completed'] as const) {
        const session = await storedSession(services, home, { finished: ended });
        const continuation = await continuedRun(
            services,
            session,
            status,
            boundary.toISOString()
        );
        await janitor.sweep([], boundary);
        expect(await services.runs.read(session)).toBeDefined();
        expect(await services.runs.read(continuation)).toBeDefined();
        expect(await services.sessions.read(session)).toBeDefined();
        expect(
            await readFile(join(home.workspaceDirectory(session), 'source.txt'), 'utf8')
        ).toBe('source');
        if (status === 'completed') {
            await janitor.sweep([], new Date('2026-01-15T00:00:00.000Z'));
            await expect(services.sessions.read(session)).rejects.toThrow(
                'does not exist'
            );
        }
    }
});

test('refuses continuation before the next sweep and after deletion', async () => {
    const { home, services, janitor } = await storage();
    const id = await storedSession(services, home, { finished: ended });
    const runners = RunnerRegistry.standard();
    const engine = new WorkerEngine({
        home,
        services,
        runners,
        worker: 'mini',
        api: 'https://example.test',
        environment: new TestRunEnvironment(home, runners, {}),
        now: () => boundary,
        download: async () => {
            throw new Error('unexpected download');
        },
    });
    const continuation = () =>
        engine.command(
            id,
            {
                type: 'command',
                command_id: 'c',
                run_id: 'run_1',
                kind: 'send',
                payload: { text: 'Continue' },
            },
            {
                run: {
                    run_id: 'run_1',
                    runtime: 'local',
                    runner: 'opencode',
                    member_id: null,
                    connection: null,
                },
            }
        );
    await expect(continuation()).rejects.toThrow('expired');
    await janitor.sweep([], boundary);
    await expect(continuation()).rejects.toThrow('no longer available');
});

test('protects every run when a continuation starts between review and removal', async () => {
    const { home, services } = await storage();
    const id = await storedSession(services, home, { finished: ended });
    class ContinuingRetention extends SessionRetention {
        override async review(policy: SessionRetentionPolicy) {
            const review = await super.review(policy);
            await continuedRun(services, id, 'running', boundary.toISOString());
            return review;
        }
    }
    const result = await new ContinuingRetention(
        home.root,
        services.runs,
        services.sessions,
        services.writer,
        { sessionCleanup: new WorkerSessionExpiry(home, services.sessions) }
    ).apply({
        before: WorkerSessionExpiry.horizon(boundary),
        includeResumableSessions: true,
    });
    expect(result.removedSessions).toEqual([]);
    expect(result.removedRuns).toEqual([]);
    expect(await services.runs.read(id)).toBeDefined();
    expect(await services.sessions.read(id)).toBeDefined();
    expect(await stat(home.workspaceDirectory(id))).toBeDefined();
});
