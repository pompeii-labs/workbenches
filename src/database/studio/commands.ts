import type { Connection } from '../connection.js';

/** Results of Studio commands by run and idempotency key, so a retry repeats them. */
export class StudioCommandStore {
    constructor(private readonly database: Pick<Connection, 'run' | 'one'>) {}

    result(runId: string, key: string): unknown | undefined {
        const row = this.database.one(
            'SELECT result FROM studio_commands WHERE run_id = ? AND idempotency_key = ?',
            runId,
            key
        );
        if (typeof row?.result !== 'string') return undefined;
        const value: unknown = JSON.parse(row.result);
        return value;
    }

    /** Records a result once; a concurrent first record wins and is returned. */
    record(runId: string, key: string, result: unknown): unknown {
        this.database.run(
            `INSERT OR IGNORE INTO studio_commands (
                run_id, idempotency_key, result, created_at
             ) VALUES (?, ?, ?, ?)`,
            runId,
            key,
            JSON.stringify(result),
            new Date().toISOString()
        );
        return this.result(runId, key) ?? result;
    }
}
