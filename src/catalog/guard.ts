import type { LeaseStore } from '../database/leases.js';
import type { SessionStore } from '../sessions/store.js';
import type { CatalogSnapshots } from './snapshots.js';

/**
 * One `snapshot:<digest>` lease guards each snapshot. A caller holds it from
 * materializing a snapshot until it has recorded its reference to it, and
 * {@link release} holds it while it checks references and removes.
 */
export class SnapshotGuard {
    constructor(
        private readonly snapshots: Pick<
            CatalogSnapshots,
            'root' | 'sweepRemoved' | 'discard'
        >,
        private readonly leases: Pick<LeaseStore, 'exclusive'>,
        private readonly sessions: Pick<SessionStore, 'list'>
    ) {}

    /** Runs `operation` while holding the lease for one snapshot digest. */
    exclusive<T>(digest: string, operation: () => Promise<T>): Promise<T> {
        return this.leases.exclusive(
            `snapshot:${digest}`,
            {
                timeoutMilliseconds: 30_000,
                pollMilliseconds: 25,
                timeoutMessage: `Timed out waiting for Workbench package snapshot: ${digest}`,
            },
            operation
        );
    }

    /**
     * Removes a snapshot nothing refers to. `saved` reports whether the
     * catalog still does; sessions are checked here. The check and the removal
     * happen under one lease.
     */
    async release(digest: string, saved: () => Promise<boolean>): Promise<void> {
        await this.exclusive(digest, async () => {
            await this.snapshots.sweepRemoved(digest);
            if (await saved()) return;
            // Sessions share snapshots with the catalog. Never remove a package a
            // session still resumes from or substitute a newer alias on resume.
            const root = this.snapshots.root(digest);
            if (
                (await this.sessions.list()).some((session) =>
                    session.workbench_path.startsWith(`${root}/`)
                )
            )
                return;
            await this.snapshots.discard(digest);
        });
    }
}
