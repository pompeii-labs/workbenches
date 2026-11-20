import { afterEach, describe, expect, test } from 'bun:test';
import {
    mkdir,
    mkdtemp,
    readdir,
    rm,
    stat,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Connection } from '../../src/database/connection.js';
import { Services } from '../../src/workbench/services.js';
import type { WorkerAssignment } from '../../src/workers/assignments.js';
import { WorkerHome } from '../../src/workers/home.js';
import { WORKER_LOG_LIMIT_BYTES, WorkerJanitor } from '../../src/workers/janitor.js';

const directories: string[] = [];

afterEach(async () => {
    for (const directory of directories.splice(0))
        await rm(directory, { recursive: true, force: true });
});

function finished(runId: string): WorkerAssignment {
    return {
        run_id: runId,
        session_id: null,
        workbench: 'threejs-game',
        package: `session-${runId.replaceAll('_', '-')}`,
        runner: 'opencode',
        runtime: 'local',
        member_id: null,
        connection: null,
        started_by: null,
        task: '',
        accepted_at: '2026-01-01T00:00:00.000Z',
        max_minutes: null,
        state: 'completed',
        observed: 3,
        uploaded: [],
        finished_at: '2026-01-01T00:10:00.000Z',
    };
}

describe('worker janitor', () => {
    test('removes what expired runs left and everything past the retention', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'workbench-worker-janitor-'));
        directories.push(directory);
        const home = new WorkerHome(directory);
        await mkdir(home.workspaceDirectory('run_old'), { recursive: true });
        await mkdir(home.workspaceDirectory('run_new'), { recursive: true });
        await writeFile(home.logPath, Buffer.alloc(WORKER_LOG_LIMIT_BYTES + 1));
        const outside = join(directory, 'outside.log');
        await writeFile(outside, Buffer.alloc(WORKER_LOG_LIMIT_BYTES + 1));
        await symlink(outside, join(home.root, 'daemon.out'));
        const connection = Connection.open(home.root);
        try {
            const services = new Services(home.root, connection);
            const digest = 'a'.repeat(64);
            const snapshot = join(home.root, 'packages', digest);
            await mkdir(snapshot, { recursive: true });
            await writeFile(join(snapshot, 'instructions.md'), 'instructions');
            await services.catalog.write([
                {
                    alias: 'session-run-old',
                    name: 'fixture',
                    version: '1.0.0',
                    source: 'https://example.test/package',
                    selector: 'fixture',
                    digest: `sha256:${digest}`,
                    packagePath: snapshot,
                    addedAt: '2026-01-01T00:00:00.000Z',
                },
            ]);
            const removed = await new WorkerJanitor(home, services).sweep(
                [finished('run_old')],
                new Date('2026-02-01T00:00:00.000Z')
            );
            expect(removed).toEqual(['run_old']);
            expect(await services.catalog.find('session-run-old')).toBeUndefined();
            expect(await stat(snapshot).catch(() => undefined)).toBeUndefined();
        } finally {
            connection.close();
        }
        expect(await readdir(join(home.root, 'workspaces'))).toEqual(['run_new']);
        expect((await stat(`${home.logPath}.1`)).size).toBe(WORKER_LOG_LIMIT_BYTES + 1);
        expect(await stat(home.logPath).catch(() => undefined)).toBeUndefined();
        expect((await stat(outside)).size).toBe(WORKER_LOG_LIMIT_BYTES + 1);
    });
});
