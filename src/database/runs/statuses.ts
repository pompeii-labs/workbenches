import { RunFold } from '../../runs/fold.js';
import type { Connection } from '../connection.js';

interface CachedRunFold {
    /** Cursor of the last event folded into `fold`. */
    cursor: number;
    fold: RunFold;
}

/** The fold of each run's events, cached with the last event it covers. */
export class RunStatusStore {
    constructor(private readonly database: Pick<Connection, 'run' | 'one'>) {}

    read(runId: string): CachedRunFold | undefined {
        const row = this.database.one(
            'SELECT last_event, fold FROM run_status WHERE run_id = ?',
            runId
        );
        if (!row || typeof row.last_event !== 'number' || typeof row.fold !== 'string')
            return undefined;
        try {
            const fold = RunFold.restore(JSON.parse(row.fold));
            return fold ? { cursor: row.last_event, fold } : undefined;
        } catch {
            return undefined;
        }
    }

    write(runId: string, cache: CachedRunFold): void {
        try {
            this.database.run(
                `INSERT INTO run_status (run_id, last_event, fold) VALUES (?, ?, ?)
                 ON CONFLICT (run_id) DO UPDATE SET last_event = excluded.last_event,
                    fold = excluded.fold`,
                runId,
                cache.cursor,
                JSON.stringify(cache.fold.state)
            );
        } catch {
            // A run removed while being read only costs the cache.
        }
    }
}
