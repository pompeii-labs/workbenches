import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ProcessProbe } from '../processes/processprobe.js';

/** The argument earlier versions gave a detached worker: `__worker <home> <run id>`. */
const WORKER_MARKER = '__worker';

/**
 * The file-based session and run layout that earlier versions kept under the
 * Workbench home. This version never reads, imports, moves or deletes it. It
 * only notices that it exists and refuses to race a worker that still uses it.
 */
export class LegacyLayout {
    constructor(
        private readonly home: string,
        private readonly probe = new ProcessProbe()
    ) {}

    exists(): boolean {
        return (
            existsSync(join(this.home, 'sessions')) ||
            existsSync(join(this.home, 'runs'))
        );
    }

    notice(): string {
        return `Workbench: sessions and runs recorded in ${this.home} by an earlier version are not shown by this version.`;
    }

    /** Refuse to start new work while an old-format detached worker is alive. */
    async assertNoLiveWorker(): Promise<void> {
        const root = join(this.home, 'runs');
        const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (!entry.isDirectory() || !entry.name.startsWith('wb_')) continue;
            const record = join(root, entry.name, 'run.json');
            const pid = await this.liveWorker(record, entry.name);
            if (pid !== undefined)
                throw new Error(
                    `A run started by an earlier version of Workbench is still active (${entry.name}, process ${pid}). Wait for it to finish or stop it, then start new runs. If it is not running, remove ${record}.`
                );
        }
    }

    /** The recorded pid, when it is still an old worker for this run. */
    private async liveWorker(path: string, runId: string): Promise<number | undefined> {
        const source = await readFile(path, 'utf8').catch(() => undefined);
        if (!source) return undefined;
        let record: unknown;
        try {
            record = JSON.parse(source);
        } catch {
            return undefined;
        }
        if (typeof record !== 'object' || record === null) return undefined;
        const pid: unknown = Reflect.get(record, 'pid');
        const status: unknown = Reflect.get(record, 'status');
        if (
            typeof pid !== 'number' ||
            !Number.isSafeInteger(pid) ||
            pid <= 0 ||
            (status !== 'dispatched' && status !== 'running')
        )
            return undefined;
        if (!this.probe.alive(pid)) return undefined;
        // Alive but unreadable cannot be ruled out, so it blocks.
        const command = this.probe.command(pid);
        if (command === undefined) return pid;
        // A readable command line that is not this run's worker is a reused pid.
        const words = command.split(/\s+/);
        return words.includes(WORKER_MARKER) && words.includes(runId) ? pid : undefined;
    }
}
