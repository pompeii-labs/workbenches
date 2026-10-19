import type { RepositoryCheckoutStore } from './checkouts.js';
import type { Connection } from './connection.js';
import type { Row } from './rows.js';

type Value = string | number | null;

/** The `sessions` columns a new session writes, in insert order. */
export type SessionColumns = readonly [string, ...Value[]];

/** The columns a session may change after it is created. */
export interface SessionChanges {
    name: string | null;
    native_session_id: string | null;
    latest_run_id: string;
    updated_at: string;
}

/** The `sessions` rows. */
export class SessionRecordStore {
    constructor(
        private readonly database: Pick<
            Connection,
            'run' | 'one' | 'all' | 'transaction'
        >,
        private readonly checkouts: Pick<RepositoryCheckoutStore, 'forget'>
    ) {}

    /** Inserts a new session; false when the id already exists. */
    insert(columns: SessionColumns): boolean {
        return (
            this.database.run(
                `INSERT OR IGNORE INTO sessions (
                    id, name, project_id, workbench, workbench_version, runner, model,
                    runtime, reference, workbench_path, source_workbench_path,
                    workbench_digest, workspace, repository, workspaces, registry,
                    allow_unchecked_gpu, native_path, native_session_id, latest_run_id,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                ...columns
            ).changes > 0
        );
    }

    /** One session with its project's display name as `project`. */
    row(id: string): Row | undefined {
        return this.database.one(`${sessionSelect} WHERE sessions.id = ?`, id);
    }

    /** Every session, most recently updated first. */
    rows(): Row[] {
        return this.database.all(
            `${sessionSelect} ORDER BY sessions.updated_at DESC, sessions.id DESC`
        );
    }

    change(id: string, changes: SessionChanges): void {
        this.database.run(
            `UPDATE sessions SET name = ?, native_session_id = ?, latest_run_id = ?,
                updated_at = ? WHERE id = ?`,
            changes.name,
            changes.native_session_id,
            changes.latest_run_id,
            changes.updated_at,
            id
        );
    }

    /** Deletes only the row, for a session whose creation did not finish. */
    discard(id: string): void {
        this.database.run('DELETE FROM sessions WHERE id = ?', id);
    }

    /** Deletes a session with its repository receipt and checkout record. */
    remove(id: string): void {
        this.database.transaction(() => {
            this.database.run('DELETE FROM sessions WHERE id = ?', id);
            this.database.run(
                "DELETE FROM repository_receipts WHERE scope = 'session' AND id = ?",
                id
            );
            this.checkouts.forget(id);
        });
    }
}

const sessionSelect = `SELECT sessions.*, projects.name AS project
FROM sessions LEFT JOIN projects ON projects.id = sessions.project_id`;
