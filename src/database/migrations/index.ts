/// <reference path="./sql.d.ts" />
import initial from './0001_initial.sql' with { type: 'text' };
import projects from './0002_projects.sql' with { type: 'text' };
import cloudSessions from './0003_cloud_sessions.sql' with { type: 'text' };
import studio from './0004_studio.sql' with { type: 'text' };

/**
 * One schema change. `sql` is the text of `migrations/NNNN_name.sql`; its
 * sha256 is recorded when the migration is applied.
 */
export interface Migration {
    version: number;
    name: string;
    sql: string;
}

/**
 * Append-only schema history, embedded so the compiled binary carries it. Add
 * the next number to this list and never edit a shipped file; see
 * `migrations/README.md`.
 */
export const migrations: readonly Migration[] = [
    { version: 1, name: 'initial', sql: initial },
    { version: 2, name: 'projects', sql: projects },
    { version: 3, name: 'cloud_sessions', sql: cloudSessions },
    { version: 4, name: 'studio', sql: studio },
];
