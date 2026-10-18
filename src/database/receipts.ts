import type { Connection } from './connection.js';
import type { Row } from './rows.js';

export type RepositoryReceiptScope = 'run' | 'session';

/** The serialized delivery receipts, one per run and one per session. */
export class RepositoryReceiptRecords {
    constructor(private readonly database: Pick<Connection, 'run' | 'one'>) {}

    save(scope: RepositoryReceiptScope, id: string, payload: string): void {
        this.database.run(
            `INSERT INTO repository_receipts (scope, id, payload) VALUES (?, ?, ?)
             ON CONFLICT (scope, id) DO UPDATE SET payload = excluded.payload`,
            scope,
            id,
            payload
        );
    }

    row(scope: RepositoryReceiptScope, id: string): Row | undefined {
        return this.database.one(
            'SELECT payload FROM repository_receipts WHERE scope = ? AND id = ?',
            scope,
            id
        );
    }
}
