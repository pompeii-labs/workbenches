import { readMigrationFolder } from './folder.js' with { type: 'macro' };

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
 * Append-only schema history, read from this folder at transpile time so the
 * compiled binary carries it. Add the next numbered file and never edit a
 * shipped one; see `migrations/README.md`.
 */
export const migrations: readonly Migration[] = readMigrationFolder();
