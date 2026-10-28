import { rename, rm, stat, truncate } from 'node:fs/promises';
import { join } from 'node:path';

import type { CatalogWriter } from '../catalog/writer.js';
import type { SessionRetention } from '../sessions/retention.js';
import type { WorkerAssignment } from './assignments.js';
import type { WorkerHome } from './home.js';

/** How long a finished run's workspace, package, and records are kept. */
const WORKER_RETENTION_DAYS = 7;
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
        private readonly home: Pick<
            WorkerHome,
            'root' | 'logPath' | 'workspaceDirectory'
        >,
        private readonly retention: Pick<SessionRetention, 'apply'>,
        private readonly catalog: Pick<CatalogWriter, 'remove'>
    ) {}

    /** The moment before which finished work is removed. */
    static horizon(now: Date): Date {
        return new Date(now.getTime() - WORKER_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    }

    /** Removes what `expired` runs left behind, then everything older than the retention. */
    async sweep(expired: WorkerAssignment[], now: Date): Promise<void> {
        await this.#rotate();
        for (const run of expired) {
            await rm(this.home.workspaceDirectory(run.run_id), {
                recursive: true,
                force: true,
            });
            if (run.package) await this.catalog.remove(run.package).catch(() => {});
        }
        await this.retention.apply({
            before: WorkerJanitor.horizon(now),
            includeResumableSessions: true,
        });
    }

    async #rotate(): Promise<void> {
        const log = await stat(this.home.logPath).catch(() => undefined);
        if (log && log.size > WORKER_LOG_LIMIT_BYTES)
            await rename(this.home.logPath, `${this.home.logPath}.1`);
        // The service manager holds the output file open, so it is emptied in place.
        const output = join(this.home.root, 'daemon.out');
        const written = await stat(output).catch(() => undefined);
        if (written && written.size > WORKER_LOG_LIMIT_BYTES) await truncate(output, 0);
    }
}
