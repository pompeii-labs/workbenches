import { lstat, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { RunStore, type StoredRun } from '../runs/store.js';
import type { SessionStore, StoredSession } from '../sessions/store.js';
import { WorkerHome } from './home.js';

/** The continuation window and the storage owned by an expired worker session. */
export class WorkerSessionExpiry {
    static readonly milliseconds = 7 * 24 * 60 * 60 * 1000;

    constructor(
        private readonly home: WorkerHome,
        private readonly sessions: Pick<SessionStore, 'list'>
    ) {}

    static horizon(now: Date): Date {
        return new Date(now.getTime() - WorkerSessionExpiry.milliseconds);
    }

    timestamp(_session: StoredSession, runs: StoredRun[]): string {
        if (runs.some((run) => !run.finished_at)) return '';
        return (
            runs
                .map((run) => run.finished_at ?? '')
                .toSorted()
                .at(-1) ?? ''
        );
    }

    static expired(runs: StoredRun[], now: Date): boolean {
        return (
            runs.length > 0 &&
            runs.every(
                (run) =>
                    RunStore.isTerminal(run.status) &&
                    run.finished_at !== undefined &&
                    Date.parse(run.finished_at) <=
                        WorkerSessionExpiry.horizon(now).getTime()
            )
        );
    }

    /** Refuse linked storage roots before any store performs recursive removal. */
    async verify(): Promise<void> {
        for (const path of [
            this.home.root,
            join(this.home.root, 'workspaces'),
            join(this.home.root, 'files'),
            join(this.home.root, 'files', 'native'),
            join(this.home.root, 'files', 'repositories'),
            join(this.home.root, 'files', 'work'),
            join(this.home.root, 'packages'),
            join(this.home.root, 'outcomes'),
            join(this.home.root, 'blobs'),
        ]) {
            const details = await lstat(path).catch((error: unknown) => {
                if (
                    error instanceof Error &&
                    'code' in error &&
                    error.code === 'ENOENT'
                )
                    return undefined;
                throw error;
            });
            if (details && (!details.isDirectory() || details.isSymbolicLink()))
                throw new Error(
                    'Worker cleanup requires storage directories inside its home'
                );
        }
    }

    async remove(session: StoredSession): Promise<void> {
        if (
            (await this.sessions.list()).some(
                (other) =>
                    other.id !== session.id &&
                    resolve(other.workspace) === resolve(session.workspace)
            )
        )
            return;
        await this.removeWorkspace(session.workspace);
    }

    async removeWorkspace(path: string): Promise<void> {
        const workspace = resolve(path);
        if (dirname(workspace) !== resolve(this.home.root, 'workspaces')) return;
        const owned = this.home.workspaceDirectory(
            WorkerHome.validIdentifier(basename(workspace))
        );
        await rm(owned, { recursive: true, force: true });
    }
}
