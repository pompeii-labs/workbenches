import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CatalogEntry } from '../../src/catalog/types.js';
import type {
    SessionRetentionPolicy,
    SessionRetentionResult,
} from '../../src/sessions/retention.js';
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
        session_id: `wb_${runId}`,
        workbench: 'threejs-game',
        package: `session-${runId}`,
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
        const policies: SessionRetentionPolicy[] = [];
        const removed: string[] = [];
        await new WorkerJanitor(
            home,
            {
                apply: async (policy) => {
                    policies.push(policy);
                    return {} as SessionRetentionResult;
                },
            },
            {
                remove: async (alias) => {
                    removed.push(alias);
                    return {} as CatalogEntry;
                },
            }
        ).sweep([finished('run_old')], new Date('2026-02-01T00:00:00.000Z'));
        expect(await readdir(join(home.root, 'workspaces'))).toEqual(['run_new']);
        expect(removed).toEqual(['session-run_old']);
        expect(policies).toEqual([
            {
                before: new Date('2026-01-25T00:00:00.000Z'),
                includeResumableSessions: true,
            },
        ]);
        expect((await stat(`${home.logPath}.1`)).size).toBe(WORKER_LOG_LIMIT_BYTES + 1);
        expect(await stat(home.logPath).catch(() => undefined)).toBeUndefined();
    });
});
