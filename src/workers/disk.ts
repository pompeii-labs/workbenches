import { lstat, readdir, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { WorkerHome } from './home.js';
import { isRecord } from './protocol.js';

export interface WorkerDiskUsage {
    home_bytes: number | null;
    workspaces_bytes: number | null;
    outcomes_bytes: number | null;
    measured_at: string | null;
    free_bytes: number;
}

/** Measures off the status path, which reads only the last sweep and live free space. */
export class WorkerDisk {
    constructor(private readonly home: WorkerHome) {}

    async read(): Promise<WorkerDiskUsage> {
        const value = await this.home.read('disk.json');
        const bytes = (name: string) => {
            const field = isRecord(value) ? value[name] : undefined;
            return typeof field === 'number' &&
                Number.isSafeInteger(field) &&
                field >= 0
                ? field
                : null;
        };
        const free = await statfs(this.home.root).catch((error: unknown) => {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
                return statfs(dirname(this.home.root));
            throw error;
        });
        return {
            home_bytes: bytes('home_bytes'),
            workspaces_bytes: bytes('workspaces_bytes'),
            outcomes_bytes: bytes('outcomes_bytes'),
            measured_at:
                isRecord(value) && typeof value.measured_at === 'string'
                    ? value.measured_at
                    : null,
            free_bytes: free.bavail * free.bsize,
        };
    }

    async refresh(now: Date): Promise<void> {
        const totals = { home_bytes: 0, workspaces_bytes: 0, outcomes_bytes: 0 };
        const pending = [{ path: this.home.root, group: '' }];
        while (pending.length) {
            // Bound open descriptors even in repositories with millions of entries.
            const batch = pending.splice(Math.max(0, pending.length - 16), 16);
            await Promise.all(
                batch.map(async ({ path, group }) => {
                    const details = await lstat(path).catch((error: unknown) => {
                        if (
                            error instanceof Error &&
                            'code' in error &&
                            error.code === 'ENOENT'
                        )
                            return undefined;
                        throw error;
                    });
                    if (!details || details.isSymbolicLink()) return;
                    if (details.isFile()) {
                        totals.home_bytes += details.size;
                        if (group === 'workspaces')
                            totals.workspaces_bytes += details.size;
                        if (group === 'outcomes' || group === 'blobs')
                            totals.outcomes_bytes += details.size;
                    } else if (details.isDirectory()) {
                        for (const name of await readdir(path))
                            pending.push({
                                path: join(path, name),
                                group: path === this.home.root ? name : group,
                            });
                    }
                })
            );
        }
        await this.home.write('disk.json', {
            ...totals,
            measured_at: now.toISOString(),
        });
    }
}
