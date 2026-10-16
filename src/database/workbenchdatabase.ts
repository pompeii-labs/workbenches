import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { DatabaseConstraintError } from './error.js';
import { type Migration, migrations } from './migrations.js';
import type { Row } from './rowreader.js';

export type Binding = SQLQueryBindings;

const BUSY_TIMEOUT_MILLISECONDS = 10_000;

export interface DatabaseOptions {
    /** A database file other than the home's own, for an explicit schema history. */
    filename?: string;
    history?: readonly Migration[];
}

/**
 * Owns the one SQLite connection a process uses for a Workbench home. Stores
 * hold the SQL; this class holds the connection, its pragmas, the schema
 * history and the change signal readers wait on.
 *
 * Writers in separate processes coordinate through SQLite itself: WAL mode,
 * a busy timeout, and `BEGIN IMMEDIATE` for every write transaction. WAL needs
 * shared memory, so the home must be on a local disk.
 */
export class WorkbenchDatabase {
    static readonly filename = 'wb.db';

    static #open = new Map<string, WorkbenchDatabase>();

    readonly #connection: Database;
    #writes = 0;
    #depth = 0;

    private constructor(
        readonly path: string,
        history: readonly Migration[]
    ) {
        this.#connection = new Database(path, { create: true });
        chmodSync(path, 0o600);
        this.#connection.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MILLISECONDS}`);
        this.enableWriteAheadLog();
        this.#connection.run('PRAGMA synchronous = NORMAL');
        this.#connection.run('PRAGMA foreign_keys = ON');
        this.migrate(history);
    }

    /**
     * The shared connection for a home, opened on first use. An explicit
     * filename or schema history opens a separate, uncached connection.
     */
    static forHome(home: string, options: DatabaseOptions = {}): WorkbenchDatabase {
        const root = resolve(home);
        const path = join(root, options.filename ?? WorkbenchDatabase.filename);
        if (options.filename !== undefined || options.history !== undefined) {
            mkdirSync(root, { recursive: true, mode: 0o700 });
            return new WorkbenchDatabase(path, options.history ?? migrations);
        }
        const existing = WorkbenchDatabase.#open.get(path);
        if (existing && existsSync(path)) return existing;
        // Release connections whose home was deleted while this process ran.
        for (const [known, database] of WorkbenchDatabase.#open) {
            if (existsSync(known)) continue;
            database.close();
            WorkbenchDatabase.#open.delete(known);
        }
        mkdirSync(root, { recursive: true, mode: 0o700 });
        const database = new WorkbenchDatabase(path, migrations);
        WorkbenchDatabase.#open.set(path, database);
        return database;
    }

    static closeAll(): void {
        for (const database of WorkbenchDatabase.#open.values()) database.close();
        WorkbenchDatabase.#open.clear();
    }

    get schemaVersion(): number {
        return this.userVersion();
    }

    /**
     * Changes whenever any connection, in this or another process, commits a
     * write. Readers compare it between polls instead of re-reading rows.
     */
    changeToken(): string {
        const row = this.#connection
            .query<{ data_version: number }, []>('PRAGMA data_version')
            .get();
        return `${row?.data_version ?? 0}.${this.#writes}`;
    }

    run(sql: string, ...parameters: Binding[]): { changes: number } {
        const result = this.translate(() =>
            this.#connection.query(sql).run(...parameters)
        );
        if (this.#depth === 0) this.#writes += 1;
        return { changes: result.changes };
    }

    one(sql: string, ...parameters: Binding[]): Row | undefined {
        return (
            this.translate(() =>
                this.#connection.query<Row, Binding[]>(sql).get(...parameters)
            ) ?? undefined
        );
    }

    all(sql: string, ...parameters: Binding[]): Row[] {
        return this.translate(() =>
            this.#connection.query<Row, Binding[]>(sql).all(...parameters)
        );
    }

    /** Runs a synchronous operation inside one write transaction. */
    transaction<T>(operation: () => T): T {
        if (this.#depth > 0) return operation();
        this.#connection.run('BEGIN IMMEDIATE');
        this.#depth = 1;
        try {
            const result = operation();
            this.#connection.run('COMMIT');
            this.#writes += 1;
            return result;
        } catch (error) {
            try {
                this.#connection.run('ROLLBACK');
            } catch {
                // The failed statement already ended the transaction.
            }
            throw error;
        } finally {
            this.#depth = 0;
        }
    }

    close(): void {
        try {
            this.#connection.close();
        } catch {
            // Closing twice is harmless.
        }
    }

    private translate<T>(operation: () => T): T {
        try {
            return operation();
        } catch (error) {
            throw DatabaseConstraintError.from(error) ?? error;
        }
    }

    /**
     * Switching a new file to WAL takes a lock that ignores the busy timeout
     * and fails at once when another process holds it, so retry until the
     * timeout has elapsed.
     */
    private enableWriteAheadLog(): void {
        const deadline = Date.now() + BUSY_TIMEOUT_MILLISECONDS;
        const wait = new Int32Array(new SharedArrayBuffer(4));
        for (let delay = 2; ; delay = Math.min(delay * 2, 100)) {
            try {
                this.#connection.run('PRAGMA journal_mode = WAL');
                return;
            } catch (error) {
                const busy =
                    error instanceof Error &&
                    'code' in error &&
                    (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED');
                if (!busy || Date.now() >= deadline) throw error;
                Atomics.wait(wait, 0, 0, delay);
            }
        }
    }

    private userVersion(): number {
        const row = this.#connection
            .query<{ user_version: number }, []>('PRAGMA user_version')
            .get();
        return row?.user_version ?? 0;
    }

    private migrate(history: readonly Migration[]): void {
        const latest = history.at(-1)?.version ?? 0;
        if (this.userVersion() === latest) return;
        this.transaction(() => {
            // Another process may have migrated while this one waited for the lock.
            const current = this.userVersion();
            if (current > latest)
                throw new Error(
                    `${this.path} was created by a newer version of Workbench (schema ${current}). Upgrade Workbench to use it.`
                );
            for (const migration of history) {
                if (migration.version <= current) continue;
                this.#connection.exec(migration.sql);
                this.#connection.exec(`PRAGMA user_version = ${migration.version}`);
            }
        });
    }
}
