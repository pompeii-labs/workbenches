import type { WorkbenchDatabase } from '../database/workbenchdatabase.js';
import { isRepositoryBinding, type RepositoryBinding } from './contracts.js';

/** The provenance recorded when a session's managed checkout was created. */
export class RepositoryCheckoutStore {
    constructor(private readonly database: WorkbenchDatabase) {}

    find(sessionId: string): RepositoryBinding | undefined {
        const row = this.database.one(
            'SELECT binding FROM repository_checkouts WHERE session_id = ?',
            sessionId
        );
        if (!row || typeof row.binding !== 'string') return undefined;
        const saved: unknown = JSON.parse(row.binding);
        if (!isRepositoryBinding(saved))
            throw new Error('Invalid stored repository binding');
        return saved;
    }

    record(sessionId: string, binding: RepositoryBinding): void {
        this.database.run(
            'INSERT INTO repository_checkouts (session_id, binding) VALUES (?, ?)',
            sessionId,
            JSON.stringify(binding)
        );
    }

    forget(sessionId: string): void {
        this.database.run(
            'DELETE FROM repository_checkouts WHERE session_id = ?',
            sessionId
        );
    }
}
