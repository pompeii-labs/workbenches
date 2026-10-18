import type { LeaseStore } from '../database/leases.js';

/** Serializes crash reconciliation of one run across processes. */
export class RunReconciliationLease {
    constructor(
        private readonly runId: string,
        private readonly leases: Pick<LeaseStore, 'exclusive'>
    ) {}

    exclusive<T>(operation: () => Promise<T>): Promise<T> {
        return this.leases.exclusive(
            `reconcile:${this.runId}`,
            {
                timeoutMilliseconds: 5_000,
                pollMilliseconds: 10,
                timeoutMessage: `Timed out reconciling Workbench run: ${this.runId}`,
            },
            operation
        );
    }
}
