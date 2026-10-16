import { LeaseStore } from '../database/leasestore.js';
import type { WorkbenchDatabase } from '../database/workbenchdatabase.js';

/** Serializes crash reconciliation of one run across processes. */
export class RunReconciliationLease {
    readonly #leases: LeaseStore;

    constructor(
        private readonly runId: string,
        database: WorkbenchDatabase
    ) {
        this.#leases = new LeaseStore(database);
    }

    exclusive<T>(operation: () => Promise<T>): Promise<T> {
        return this.#leases.exclusive(
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
