import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { RunStore, type StoredRunStatus } from '../../src/runs/store.js';
import type { Services } from '../../src/workbench/services.js';
import type { WorkerHome } from '../../src/workers/home.js';

export const commandSession = 'wb_12345678901234567890';

export async function storedSession(
    services: Services,
    home: WorkerHome,
    options: {
        id?: string;
        workspace?: string;
        finished?: string;
        status?: StoredRunStatus;
    } = {}
) {
    const id = options.id ?? RunStore.createId();
    const workspace = options.workspace ?? home.workspaceDirectory(id);
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'source.txt'), 'source');
    await services.sessions.create({
        id,
        workbench: 'fixture',
        workbench_version: '1.0.0',
        runner: 'opencode',
        model: 'openai/gpt-5.6-terra',
        reference: 'fixture',
        workbench_path: home.root,
        workspace,
        workspaces: [],
        latest_run_id: id,
        native_session_id: 'native_placeholder',
    });
    await writeFile(join(services.sessions.nativeDirectory(id), 'context'), 'context');
    await services.runs.create({
        id,
        metadata: {
            workbench: 'fixture',
            workbench_version: '1.0.0',
            runner: 'opencode',
            model: 'openai/gpt-5.6-terra',
            workspace,
            session_id: id,
        },
        request: { workbench_path: home.root, workspace, task: '' },
    });
    await services.runs.update(id, {
        status: options.status ?? 'completed',
        finished_at: options.finished ?? new Date().toISOString(),
        ...(options.status === 'running' ? { pid: process.pid } : {}),
    });
    return id;
}

export async function continuedRun(
    services: Services,
    session: string,
    status: StoredRunStatus,
    finished: string
) {
    const stored = await services.sessions.read(session);
    const id = RunStore.createId();
    await services.runs.create({
        id,
        metadata: {
            workbench: stored.workbench,
            workbench_version: stored.workbench_version,
            runner: stored.runner,
            model: stored.model,
            workspace: stored.workspace,
            session_id: session,
            resumed_from: stored.latest_run_id,
        },
        request: {
            workbench_path: stored.workbench_path,
            workspace: stored.workspace,
            task: '',
        },
    });
    await services.runs.update(id, {
        status,
        finished_at: finished,
        ...(status === 'running' ? { pid: process.pid } : {}),
    });
    await services.sessions.update(session, { latest_run_id: id });
    return id;
}
