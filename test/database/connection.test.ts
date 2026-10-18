import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Connection } from '../../src/database/connection.js';
import { DatabaseConstraintError } from '../../src/database/error.js';
import { migrations } from '../../src/database/migrations/index.js';

const directories: string[] = [];
const connections: Connection[] = [];

afterEach(async () => {
    for (const connection of connections.splice(0)) connection.close();
    await Promise.all(
        directories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('opening a home', () => {
    test('builds the whole schema in a private file', async () => {
        const home = join(await temporaryDirectory(), 'fresh');
        const database = open(home);

        expect(database.path).toBe(join(home, 'wb.db'));
        expect(((await stat(database.path)).mode & 0o777).toString(8)).toBe('600');
        expect(((await stat(home)).mode & 0o777).toString(8)).toBe('700');
        expect(
            database.one('SELECT MAX(version) AS version FROM __migrations')
        ).toEqual({ version: migrations.at(-1)?.version ?? -1 });
        expect(
            database
                .all(
                    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
                )
                .map((row) => row.name)
        ).toEqual(
            expect.arrayContaining([
                'control_receipts',
                'control_requests',
                'events',
                'leases',
                'notices',
                'repository_checkouts',
                'repository_receipts',
                'run_requests',
                'run_status',
                'runs',
                'sessions',
            ])
        );
        expect(database.one('PRAGMA journal_mode')).toEqual({ journal_mode: 'wal' });
        expect(database.one('PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 });
        expect(database.one('PRAGMA synchronous')).toEqual({ synchronous: 1 });
        expect(Number(database.one('PRAGMA busy_timeout')?.timeout)).toBeGreaterThan(0);
    });

    test('is silent for a home that never had an earlier layout', async () => {
        const home = await temporaryDirectory();
        const write = spyOn(process.stderr, 'write');
        try {
            open(home);
            expect(write).not.toHaveBeenCalled();
        } finally {
            write.mockRestore();
        }
    });

    test('indexes events so a run is read in order without sorting', async () => {
        const database = open(await temporaryDirectory());
        const plan = (sql: string, ...parameters: string[]) =>
            database
                .all(`EXPLAIN QUERY PLAN ${sql}`, ...parameters)
                .map((row) => String(row.detail))
                .join('; ');

        for (const sql of [
            'SELECT id, payload FROM events WHERE run_id = ? AND id > 0 ORDER BY id',
            'SELECT payload FROM events WHERE run_id = ? ORDER BY id DESC LIMIT 1',
        ]) {
            const detail = plan(sql, 'wb_x');
            expect(detail).toContain('events_run_cursor');
            expect(detail).not.toContain('TEMP B-TREE');
        }
    });
});

describe('change token', () => {
    test('changes when this connection writes and when another one does', async () => {
        const home = await temporaryDirectory();
        const reader = open(home);
        const writer = Connection.open(home);
        connections.push(writer);
        const before = reader.changeToken();

        writer.run("INSERT INTO notices (name, shown_at) VALUES ('seen', 'now')");
        const afterOther = reader.changeToken();
        reader.run("INSERT INTO notices (name, shown_at) VALUES ('mine', 'now')");

        expect(afterOther).not.toBe(before);
        expect(reader.changeToken()).not.toBe(afterOther);
    });
});

describe('delay', () => {
    test('ends early when its signal aborts', async () => {
        const database = open(await temporaryDirectory());
        const controller = new AbortController();
        const started = Date.now();
        const waiting = database.delay(10_000, controller.signal);

        controller.abort();
        await waiting;

        expect(Date.now() - started).toBeLessThan(5_000);
        await database.delay(10_000, controller.signal);
    });
});

describe('constraint errors', () => {
    test('are raised with a stable code, not a message to match', async () => {
        const database = open(await temporaryDirectory());
        database.run("INSERT INTO notices (name, shown_at) VALUES ('once', 'now')");

        const unique = (() => {
            try {
                database.run(
                    "INSERT INTO notices (name, shown_at) VALUES ('once', '')"
                );
            } catch (error) {
                return error;
            }
        })();
        const foreign = (() => {
            try {
                database.run(
                    "INSERT INTO run_requests (run_id, request) VALUES ('missing', '{}')"
                );
            } catch (error) {
                return error;
            }
        })();

        expect(unique).toBeInstanceOf(DatabaseConstraintError);
        expect((unique as DatabaseConstraintError).code).toBe('unique');
        expect(foreign).toBeInstanceOf(DatabaseConstraintError);
        expect((foreign as DatabaseConstraintError).code).toBe('foreign_key');
    });
});

function open(home: string): Connection {
    const connection = Connection.open(home);
    connections.push(connection);
    return connection;
}

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-database-'));
    directories.push(directory);
    return directory;
}
