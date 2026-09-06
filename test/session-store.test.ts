import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunStore } from '../src/runs/index.js';
import { SessionResolver, SessionStore } from '../src/sessions/index.js';
import { SessionTranscript } from '../src/tui/session-transcript.js';

const homes: string[] = [];

afterEach(async () => {
    await Promise.all(
        homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))
    );
});

describe('interactive session storage', () => {
    test('serializes operations that can advance one stable session', async () => {
        const home = await temporaryHome();
        const store = new SessionStore(home);
        const session = await store.create({
            id: 'wb_sessionlease1234567890123',
            workbench: 'creator',
            workbench_version: '0.1.0',
            runner: 'opencode',
            model: 'openai/gpt-5.6-terra',
            runtime: 'local',
            reference: 'creator',
            workbench_path: '/repo/.workbenches/creator',
            workspace: '/repo',
            workspaces: [],
            latest_run_id: 'wb_sessionlease1234567890123',
        });
        const entered = deferred<void>();
        const release = deferred<void>();
        const order: string[] = [];
        const first = store.exclusive(session.id, async () => {
            order.push('first');
            entered.resolve();
            await release.promise;
        });
        await entered.promise;
        const second = store.exclusive(session.id, async () => {
            order.push('second');
        });

        await Bun.sleep(50);
        expect(order).toEqual(['first']);
        release.resolve();
        await Promise.all([first, second]);
        expect(order).toEqual(['first', 'second']);
        expect(
            await stat(join(home, 'sessions', session.id, '.lease')).catch(
                () => undefined
            )
        ).toBeUndefined();
    });

    test('stores resumable metadata separately from native runner state', async () => {
        const home = await temporaryHome();
        const store = new SessionStore(home);
        const session = await store.create({
            id: 'wb_sessionstorage1234567890',
            workbench: 'creator',
            workbench_version: '0.1.0',
            runner: 'opencode',
            model: 'openai/gpt-5.6-terra',
            reference: 'creator',
            workbench_path: '/repo/.workbenches/creator',
            workspace: '/repo',
            workspaces: [],
            latest_run_id: 'wb_sessionstorage1234567890',
        });

        expect(await store.read(session.id)).toEqual(session);
        expect(store.nativeDirectory(session.id)).toBe(
            join(home, 'sessions', session.id, 'native')
        );

        const metadataPath = join(home, 'sessions', session.id, 'session.json');
        const legacy = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<
            string,
            unknown
        >;
        delete legacy.runtime;
        await writeFile(metadataPath, `${JSON.stringify(legacy)}\n`);
        expect(await store.read(session.id)).toMatchObject({ runtime: 'local' });

        const updated = await store.update(session.id, {
            native_session_id: 'ses_native_1',
            latest_run_id: 'wb_sessionstorage2345678901',
        });
        expect(updated.native_session_id).toBe('ses_native_1');
        expect((await store.list()).map((entry) => entry.id)).toEqual([session.id]);
        await expect(store.create({ ...session })).rejects.toThrow(
            'Session already exists'
        );
        await store.remove(session.id);
        await expect(store.read(session.id)).rejects.toThrow(
            'Workbench session does not exist'
        );
    });

    test('lists only sessions that reached a native resumable state', async () => {
        const home = await temporaryHome();
        const store = new SessionStore(home);
        const pending = await store.create({
            id: 'wb_pendingsession1234567890',
            workbench: 'creator',
            workbench_version: '0.1.0',
            runner: 'opencode',
            model: 'openai/gpt-5.6-terra',
            reference: 'creator',
            workbench_path: '/repo/.workbenches/creator',
            workspace: '/repo',
            workspaces: [],
            latest_run_id: 'wb_pendingsession1234567890',
        });

        expect(await store.list({ resumableOnly: true })).toEqual([]);
        await expect(new SessionResolver(home).resolve(pending.id)).rejects.toThrow(
            'never reached a resumable runner state'
        );
        await store.update(pending.id, { native_session_id: 'ses_ready' });
        expect((await store.list({ resumableOnly: true }))[0]?.id).toBe(pending.id);
    });

    test('keeps the latest valid transcript as a disposable presentation cache', async () => {
        const home = await temporaryHome();
        const sessionId = 'wb_transcriptcache123456789';
        const store = new SessionStore(home);
        await store.create({
            id: sessionId,
            workbench: 'creator',
            workbench_version: '0.1.0',
            runner: 'opencode',
            model: 'openai/gpt-5.6-terra',
            reference: 'creator',
            workbench_path: '/repo/.workbenches/creator',
            workspace: '/repo',
            workspaces: [],
            latest_run_id: sessionId,
        });
        const transcript = new SessionTranscript(home, sessionId, 1);
        transcript.schedule([{ id: 'first', kind: 'user', text: 'first' }], {
            runId: sessionId,
            sequence: 3,
        });
        const firstWrite = transcript.flush();
        transcript.schedule([{ id: 'second', kind: 'assistant', text: 'second' }], {
            runId: sessionId,
            sequence: 8,
        });
        const secondWrite = transcript.flush();
        await Promise.all([firstWrite, secondWrite]);

        expect(await transcript.load()).toEqual([
            { id: 'second', kind: 'assistant', text: 'second' },
        ]);
        expect(await transcript.cursor()).toEqual({
            runId: sessionId,
            sequence: 8,
        });
        await writeFile(store.transcriptPath(sessionId), '{broken', {
            mode: 0o600,
        });
        expect(await transcript.load()).toEqual([]);
        expect(await transcript.cursor()).toBeUndefined();
    });

    test('refuses to present old interactive runs as resumable sessions', async () => {
        const home = await temporaryHome();
        const run = await new RunStore(home).create({
            id: 'wb_legacyrunrecord123456789',
            metadata: {
                workbench: 'creator',
                workbench_version: '0.1.0',
                runner: 'opencode',
                model: 'openai/gpt-5.6-terra',
                workspace: '/repo',
                mode: 'interactive',
            },
            request: {
                workbench_path: '/repo/.workbenches/creator',
                workspace: '/repo',
                task: '',
            },
        });

        await expect(new SessionResolver(home).resolve(run.id)).rejects.toThrow(
            'predates resumable Workbench sessions'
        );
    });

    test('resolves a linked run ID back to the stable session', async () => {
        const home = await temporaryHome();
        const packageDirectory = join(home, '.workbenches', 'creator');
        await mkdir(packageDirectory, { recursive: true });
        await writeFile(
            join(packageDirectory, 'workbench.yml'),
            [
                'spec: 0',
                'name: creator',
                'version: 0.1.0',
                'runner: opencode',
                'model:',
                '  id: openai/gpt-5.6-terra',
                'runtime: local',
                'instructions: ./instructions.md',
                '',
            ].join('\n')
        );
        await writeFile(join(packageDirectory, 'instructions.md'), 'Create things.\n');
        const sessions = new SessionStore(home);
        const session = await sessions.create({
            id: 'wb_linkedsession12345678901',
            workbench: 'creator',
            workbench_version: '0.1.0',
            runner: 'opencode',
            model: 'openai/gpt-5.6-terra',
            reference: 'creator',
            workbench_path: packageDirectory,
            workspace: home,
            workspaces: [],
            native_session_id: 'ses_native_linked',
            latest_run_id: 'wb_linkedrunrecord123456789',
        });
        const run = await new RunStore(home).create({
            id: 'wb_linkedrunrecord123456789',
            metadata: {
                workbench: 'creator',
                workbench_version: '0.1.0',
                runner: 'opencode',
                model: 'openai/gpt-5.6-terra',
                workspace: home,
                mode: 'interactive',
                session_id: session.id,
            },
            request: {
                workbench_path: packageDirectory,
                workspace: home,
                task: '',
            },
        });

        const resolved = await new SessionResolver(home).resolve(run.id);
        expect(resolved.session.id).toBe(session.id);
        expect(resolved.alias).toBe('creator');
        expect(resolved.resolved.workbench.manifest.name).toBe('creator');
    });
});

async function temporaryHome(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'workbench-session-store-'));
    homes.push(home);
    return home;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((accepted) => {
        resolve = accepted;
    });
    return { promise, resolve };
}
