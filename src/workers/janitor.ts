import { lstat, rename, truncate } from 'node:fs/promises';
import { join } from 'node:path';

import { RunStore } from '../runs/store.js';
import { SessionRetention } from '../sessions/retention.js';
import type { Services } from '../workbench/services.js';
import { type WorkerAssignment, WorkerAssignments } from './assignments.js';
import { WorkerDisk } from './disk.js';
import { WorkerSessionExpiry } from './expiry.js';
import type { WorkerHome } from './home.js';

/** The size at which the lifecycle log is rotated, keeping one previous file. */
export const WORKER_LOG_LIMIT_BYTES = 5 * 1024 * 1024;

/**
 * Keeps the worker home from growing without limit. Each sweep rotates the
 * lifecycle log, truncates the service output, removes the workspace and
 * saved package of every run finished more than the retention ago, and
 * removes the engine sessions, runs, events, and outcomes of that age.
 */
export class WorkerJanitor {
    constructor(
        private readonly home: WorkerHome,
        private readonly services: Pick<Services, 'runs' | 'sessions' | 'writer'>
    ) {}

    /** Removes expired engine sessions before forgetting their assignments. */
    async sweep(assignments: WorkerAssignment[], now: Date): Promise<string[]> {
        const expiry = new WorkerSessionExpiry(this.home, this.services.sessions);
        await expiry.verify();
        await this.#rotate();
        const result = await new SessionRetention(
            this.home.root,
            this.services.runs,
            this.services.sessions,
            this.services.writer,
            { sessionCleanup: expiry }
        ).apply({
            before: WorkerSessionExpiry.horizon(now),
            includeResumableSessions: true,
        });
        const sessions = await this.services.sessions.list();
        const runs = await this.services.runs.list();
        const removed: string[] = [];
        for (const run of assignments) {
            if (
                run.session_id &&
                sessions.some((session) => session.id === run.session_id)
            )
                continue;
            if (
                runs.some(
                    (stored) =>
                        stored.session_id === run.session_id &&
                        !RunStore.isTerminal(stored.status)
                )
            )
                continue;
            if (
                !result.removedSessions.includes(run.session_id ?? '') &&
                (!WorkerAssignments.isTerminal(run.state) ||
                    !run.finished_at ||
                    !(
                        Date.parse(run.finished_at) <=
                        WorkerSessionExpiry.horizon(now).getTime()
                    ))
            )
                continue;
            const workspace = this.home.workspaceDirectory(run.run_id);
            if (sessions.some((session) => session.workspace === workspace)) continue;
            await expiry.removeWorkspace(workspace);
            if (run.package)
                await this.services.writer.remove(run.package).catch(() => {});
            removed.push(run.run_id);
        }
        await new WorkerDisk(this.home).refresh(now);
        return removed;
    }

    async #rotate(): Promise<void> {
        const log = await lstat(this.home.logPath).catch(() => undefined);
        if (log?.isFile() && log.size > WORKER_LOG_LIMIT_BYTES)
            await rename(this.home.logPath, `${this.home.logPath}.1`);
        // The service manager holds the output file open, so it is emptied in place.
        const output = join(this.home.root, 'daemon.out');
        const written = await lstat(output).catch(() => undefined);
        if (written?.isFile() && written.size > WORKER_LOG_LIMIT_BYTES)
            await truncate(output, 0);
    }
}
