import type { Connection } from '../connection.js';
import type { Row } from '../rows.js';

type Value = string | number | null;

/**
 * The run record columns in table order, starting with `id`. `RunStore` owns
 * their meaning; this store owns how they are written and read.
 */
export type RunColumns = readonly [string, ...Value[]];

/** The `runs` rows. */
export class RunRecordStore {
    constructor(
        private readonly database: Pick<
            Connection,
            'run' | 'one' | 'all' | 'transaction'
        >
    ) {}

    /** Inserts a new run; false when the id already exists. */
    insert(columns: RunColumns): boolean {
        return (
            this.database.run(
                `INSERT OR IGNORE INTO runs (
                    id, status, workbench, workbench_version, runner, model, runtime,
                    workspace, repository, mode, execution, workspaces, allow_host_docker,
                    registry, registry_event_id, dispatched_at, started_at, finished_at,
                    pid, runner_session_id, session_id, resumed_from, exit_code, outcome_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                ...columns
            ).changes > 0
        );
    }

    row(id: string): Row | undefined {
        return this.database.one('SELECT * FROM runs WHERE id = ?', id);
    }

    /** Every run, newest first. */
    rows(): Row[] {
        return this.database.all(
            'SELECT * FROM runs ORDER BY dispatched_at DESC, id DESC'
        );
    }

    /** Rewrites every column but `id` from a full set of columns. */
    replace(columns: RunColumns): void {
        const [id, ...values] = columns;
        this.database.run(
            `UPDATE runs SET status = ?, workbench = ?, workbench_version = ?, runner = ?,
                model = ?, runtime = ?, workspace = ?, repository = ?, mode = ?,
                execution = ?, workspaces = ?, allow_host_docker = ?, registry = ?,
                registry_event_id = ?, dispatched_at = ?, started_at = ?,
                finished_at = ?, pid = ?, runner_session_id = ?, session_id = ?,
                resumed_from = ?, exit_code = ?, outcome_id = ? WHERE id = ?`,
            ...values,
            id
        );
    }

    /** Deletes a run with its repository receipt. */
    remove(id: string): void {
        this.database.transaction(() => {
            this.database.run(
                "DELETE FROM repository_receipts WHERE scope = 'run' AND id = ?",
                id
            );
            this.database.run('DELETE FROM runs WHERE id = ?', id);
        });
    }
}
