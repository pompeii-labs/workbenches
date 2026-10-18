import { createHash } from 'node:crypto';

import type { Connection } from './connection.js';
import { MigrationError } from './error.js';
import type { Migration } from './migrations/index.js';
import { RowReader } from './rows.js';

interface AppliedMigration {
    version: number;
    name: string;
    checksum: string;
}

/**
 * Brings a database up to the end of a schema history and refuses one whose
 * recorded history this history cannot continue.
 */
export class Migrator {
    constructor(private readonly history: readonly Migration[]) {}

    apply(
        connection: Pick<Connection, 'path' | 'run' | 'all' | 'script' | 'transaction'>
    ): void {
        connection.run(
            `CREATE TABLE IF NOT EXISTS __migrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                checksum TEXT NOT NULL,
                applied_at TEXT NOT NULL
            ) STRICT`
        );
        const applied = this.applied(connection);
        this.verify(connection.path, applied);
        if (applied.length === this.history.length) return;
        for (let done = false; !done; ) {
            done = connection.transaction(() => {
                // Another process may have migrated while this one waited for the lock.
                const current = this.applied(connection);
                this.verify(connection.path, current);
                const next = this.history[current.length];
                if (!next) return true;
                connection.script(next.sql);
                connection.run(
                    'INSERT INTO __migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
                    next.version,
                    next.name,
                    Migrator.checksum(next),
                    new Date().toISOString()
                );
                return false;
            });
        }
    }

    private applied(connection: Pick<Connection, 'all'>): AppliedMigration[] {
        return connection
            .all('SELECT version, name, checksum FROM __migrations ORDER BY version')
            .map((row) => {
                const reader = new RowReader(row, 'migration record');
                return {
                    version: reader.integer('version'),
                    name: reader.text('name'),
                    checksum: reader.text('checksum'),
                };
            });
    }

    /** Throws unless the recorded history is a contiguous prefix of this one. */
    private verify(path: string, applied: AppliedMigration[]): void {
        this.history.forEach((migration, index) => {
            if (migration.version !== index + 1)
                throw new MigrationError(
                    'gap',
                    `Workbench migrations are not numbered contiguously from 1 (found ${migration.version} at position ${index + 1}).`
                );
        });
        const unknown = applied.find((entry) => entry.version > this.history.length);
        if (unknown)
            throw new MigrationError(
                'newer',
                `${path} was created by a newer version of Workbench (schema ${unknown.version}). Upgrade Workbench to use it.`
            );
        applied.forEach((entry, index) => {
            if (entry.version !== index + 1)
                throw new MigrationError(
                    'gap',
                    `${path} records migrations that are not contiguous from 1 (found ${entry.version} at position ${index + 1}).`
                );
            const migration = this.history[index];
            if (migration && entry.checksum !== Migrator.checksum(migration))
                throw new MigrationError(
                    'checksum',
                    `Migration ${entry.version} (${entry.name}) in ${path} was applied from a different file than this Workbench ships. A shipped migration must never be edited.`
                );
        });
    }

    private static checksum(migration: Migration): string {
        return createHash('sha256').update(migration.sql).digest('hex');
    }
}
