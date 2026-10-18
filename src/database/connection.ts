import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { DatabaseConstraintError } from './error.js';
import { migrations } from './migrations/index.js';
import { Migrator } from './migrator.js';
import type { Row } from './rows.js';

type Binding = SQLQueryBindings;

const BUSY_TIMEOUT_MILLISECONDS = 10_000;

/**
 * The one SQLite connection a process uses for a Workbench home. Stores hold
 * the SQL; this class holds the connection, its pragmas, the change signal
 * readers wait on and the pause between polls.
 *
 * Writers in separate processes coordinate through SQLite itself: WAL mode,
 * a busy timeout, and `BEGIN IMMEDIATE` for every write transaction. WAL needs
 * shared memory, so the home must be on a local disk.
 */
export class Connection {
    readonly #connection: Database;
    #writes = 0;
    #depth = 0;

    constructor(
        readonly path: string,
        migrator: Migrator
    ) {
        this.#connection = new Database(path, { create: true });
        chmodSync(path, 0o600);
        this.#connection.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MILLISECONDS}`);
        this.enableWriteAheadLog();
        this.#connection.run('PRAGMA synchronous = NORMAL');
        this.#connection.run('PRAGMA foreign_keys = ON');
        migrator.apply(this);
    }

    /** Opens the database of a Workbench home, creating the home when needed. */
    static open(home: string): Connection {
        const root = resolve(home);
        mkdirSync(root, { recursive: true, mode: 0o700 });
        return new Connection(join(root, 'wb.db'), new Migrator(migrations));
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

    /** A wait between polls that ends early when its signal aborts. */
    delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) return Promise.resolve();
        return new Promise((done) => {
            const finish = () => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', finish);
                done();
            };
            const timer = setTimeout(finish, milliseconds);
            signal?.addEventListener('abort', finish, { once: true });
        });
    }

    run(sql: string, ...parameters: Binding[]): { changes: number } {
        const result = this.translate(() =>
            this.#connection.query(sql).run(...parameters)
        );
        if (this.#depth === 0) this.#writes += 1;
        return { changes: result.changes };
    }

    /** Runs a script of several statements that take no parameters. */
    script(sql: string): void {
        this.#connection.exec(sql);
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
}
