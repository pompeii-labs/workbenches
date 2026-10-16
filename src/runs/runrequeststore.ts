import { RowReader } from '../database/rowreader.js';
import type { WorkbenchDatabase } from '../database/workbenchdatabase.js';
import {
    isRepositoryBinding,
    type RepositoryBinding,
} from '../repositories/contracts.js';
import type { WorkbenchWorkspaceBinding } from '../types.js';
import { isStoredWorkspaces } from './bindings.js';

export interface StoredRunRequest {
    version: 1;
    workbench_path: string;
    workspace: string;
    repository?: RepositoryBinding;
    task: string;
    workspaces?: WorkbenchWorkspaceBinding[];
    allow_host_docker?: boolean;
    /** The caller accepted a GPU requirement the runtime cannot verify. */
    allow_unchecked_gpu?: boolean;
    reference?: string;
    session_id?: string;
    native_session_id?: string;
    connection?: string;
    /** Selected runtime. Absent on requests stored before runtimes were selectable. */
    runtime?: string;
}

/** What a dispatched run is asked to do; taken once by its worker. */
export class RunRequestStore {
    constructor(private readonly database: WorkbenchDatabase) {}

    put(runId: string, request: StoredRunRequest): void {
        this.database.run(
            'INSERT INTO run_requests (run_id, request) VALUES (?, ?)',
            runId,
            JSON.stringify(request)
        );
    }

    /** Returns the request and removes it, so a second taker finds none. */
    take(runId: string): StoredRunRequest {
        const row = this.database.transaction(() => {
            const found = this.database.one(
                'SELECT request FROM run_requests WHERE run_id = ?',
                runId
            );
            if (found)
                this.database.run('DELETE FROM run_requests WHERE run_id = ?', runId);
            return found;
        });
        if (!row || typeof row.request !== 'string')
            throw new Error(`Workbench run request is unavailable: ${runId}`);
        let value: unknown;
        try {
            value = JSON.parse(row.request);
        } catch {
            throw new Error(`Invalid Workbench run request: ${runId}`);
        }
        if (!this.valid(value))
            throw new Error(`Invalid Workbench run request: ${runId}`);
        return value;
    }

    private valid(value: unknown): value is StoredRunRequest {
        return (
            RowReader.isRecord(value) &&
            value.version === 1 &&
            typeof value.workbench_path === 'string' &&
            typeof value.workspace === 'string' &&
            typeof value.task === 'string' &&
            (value.connection === undefined || typeof value.connection === 'string') &&
            (value.runtime === undefined || typeof value.runtime === 'string') &&
            (value.allow_unchecked_gpu === undefined ||
                typeof value.allow_unchecked_gpu === 'boolean') &&
            (value.repository === undefined || isRepositoryBinding(value.repository)) &&
            (value.workspaces === undefined || isStoredWorkspaces(value.workspaces)) &&
            (value.allow_host_docker === undefined ||
                typeof value.allow_host_docker === 'boolean') &&
            (value.reference === undefined || typeof value.reference === 'string') &&
            (value.session_id === undefined || typeof value.session_id === 'string') &&
            (value.native_session_id === undefined ||
                typeof value.native_session_id === 'string')
        );
    }
}
