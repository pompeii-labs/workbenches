import type { WorkbenchDatabase } from '../database/workbenchdatabase.js';

/** The rows behind the request channel between a client and a running session. */
export class RunControlStore {
    constructor(private readonly database: WorkbenchDatabase) {}

    /** Queues a request. A run that does not exist raises a foreign key error. */
    enqueue(runId: string, id: string, kind: string, payload: string): void {
        this.database.run(
            "INSERT INTO control_requests (id, run_id, kind, state, payload) VALUES (?, ?, ?, 'pending', ?)",
            id,
            runId,
            kind,
            payload
        );
    }

    /** Takes the oldest pending request in one statement; no other receiver can also take it. */
    claimNext(runId: string): string | undefined {
        const row = this.database.one(
            `UPDATE control_requests SET state = 'active'
             WHERE state = 'pending' AND ordinal = (
                 SELECT ordinal FROM control_requests
                 WHERE run_id = ? AND state = 'pending' ORDER BY ordinal LIMIT 1
             ) RETURNING payload`,
            runId
        );
        return typeof row?.payload === 'string' ? row.payload : undefined;
    }

    /** Records the receipt and retires the request together. */
    settle(runId: string, id: string, receipt: string): void {
        this.database.transaction(() => {
            this.database.run(
                'INSERT OR REPLACE INTO control_receipts (id, run_id, payload) VALUES (?, ?, ?)',
                id,
                runId,
                receipt
            );
            this.database.run('DELETE FROM control_requests WHERE id = ?', id);
        });
    }

    receipt(id: string): unknown {
        return this.database.one(
            'SELECT payload FROM control_receipts WHERE id = ?',
            id
        )?.payload;
    }

    /** See {@link WorkbenchDatabase.changeToken}. */
    changeToken(): string {
        return this.database.changeToken();
    }
}
