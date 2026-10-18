import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Connection } from '../../src/database/connection.js';
import { MigrationError } from '../../src/database/error.js';
import { type Migration, migrations } from '../../src/database/migrations/index.js';
import { Migrator } from '../../src/database/migrator.js';

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

const first: Migration = {
    version: 1,
    name: 'first',
    sql: 'CREATE TABLE first (id INTEGER PRIMARY KEY) STRICT;',
};
const second: Migration = {
    version: 2,
    name: 'second',
    sql: 'CREATE TABLE second (id INTEGER PRIMARY KEY) STRICT;',
};

describe('migration history', () => {
    test('records the whole history in __migrations on a fresh database', async () => {
        const home = await temporaryHome();
        const database = open(home, migrations);

        expect(database.all('SELECT version, name FROM __migrations')).toEqual(
            migrations.map(({ version, name }) => ({ version, name }))
        );
        expect(
            database.one('SELECT checksum FROM __migrations WHERE version = 1')
        ).toEqual({ checksum: checksum(migrations[0]?.sql ?? '') });
        expect(database.one('PRAGMA user_version')).toEqual({ user_version: 0 });
    });

    test('a second open applies nothing', async () => {
        const home = await temporaryHome();
        const opened = open(home, [first]);
        const stamp = opened.one('SELECT applied_at FROM __migrations');
        opened.close();
        const again = open(home, [first]);

        expect(again.one('SELECT applied_at FROM __migrations')).toEqual(stamp);
        expect(again.all('SELECT version FROM __migrations')).toHaveLength(1);
    });

    test('upgrades an existing database with the migrations it lacks', async () => {
        const home = await temporaryHome();
        const opened = open(home, [first]);
        opened.run('INSERT INTO first (id) VALUES (7)');
        opened.close();
        const upgraded = open(home, [first, second]);

        expect(upgraded.all('SELECT version, name FROM __migrations')).toEqual([
            { version: 1, name: 'first' },
            { version: 2, name: 'second' },
        ]);
        expect(upgraded.one('SELECT id FROM first')).toEqual({ id: 7 });
        expect(upgraded.all('SELECT id FROM second')).toEqual([]);
    });

    test('rolls back a migration that fails and keeps the earlier ones', async () => {
        const home = await temporaryHome();
        open(home, [first]).close();
        const broken: Migration = {
            version: 2,
            name: 'broken',
            sql: 'CREATE TABLE half (id INTEGER) STRICT; SELECT * FROM missing;',
        };

        expect(() => open(home, [first, broken])).toThrow();
        const database = open(home, [first]);
        expect(database.all('SELECT version FROM __migrations')).toHaveLength(1);
        expect(
            database.all("SELECT name FROM sqlite_master WHERE name = 'half'")
        ).toEqual([]);
    });

    test('refuses a database from a newer Workbench', async () => {
        const home = await temporaryHome();
        open(home, [first, second]).close();

        expect(refusal(() => open(home, [first]))).toMatchObject({
            code: 'newer',
            message: expect.stringContaining('newer version of Workbench'),
        });
    });

    test('refuses a shipped migration whose file was edited', async () => {
        const home = await temporaryHome();
        open(home, [first]).close();
        const edited = {
            ...first,
            sql: `${first.sql}\nCREATE TABLE extra (id INTEGER);`,
        };

        expect(refusal(() => open(home, [edited]))).toMatchObject({
            code: 'checksum',
            message: expect.stringContaining('Migration 1 (first)'),
        });
    });

    test('refuses a recorded history with a gap', async () => {
        const home = await temporaryHome();
        open(home, [first, second]).close();
        const raw = new Database(join(home, 'history.db'));
        raw.run('DELETE FROM __migrations WHERE version = 1');
        raw.close();

        expect(refusal(() => open(home, [first, second]))).toMatchObject({
            code: 'gap',
        });
    });

    test('refuses a registry that is not numbered from 1', async () => {
        const home = await temporaryHome();

        expect(refusal(() => open(home, [second]))).toMatchObject({ code: 'gap' });
    });

    test('opens a brand new database from several processes at once', async () => {
        const home = join(await temporaryHome(), 'fresh');
        const start = Date.now() + 1_500;
        const openers = Array.from({ length: 6 }, () =>
            Bun.spawn(
                [
                    process.execPath,
                    join(import.meta.dir, 'process.ts'),
                    'open',
                    home,
                    'x',
                    `${start}`,
                ],
                { stdout: 'pipe', stderr: 'pipe' }
            )
        );
        const codes = await Promise.all(openers.map((opener) => opener.exited));
        expect(codes).toEqual(Array(6).fill(0));

        const database = Connection.open(home);
        connections.push(database);
        expect(database.all('SELECT version FROM __migrations')).toEqual([
            { version: 1 },
        ]);
    });
});

function open(home: string, history: readonly Migration[]): Connection {
    const connection = new Connection(join(home, 'history.db'), new Migrator(history));
    connections.push(connection);
    return connection;
}

function refusal(operation: () => unknown): MigrationError {
    try {
        operation();
    } catch (error) {
        if (error instanceof MigrationError) return error;
        throw error;
    }
    throw new Error('expected the database to be refused');
}

function checksum(text: string): string {
    return createHash('sha256').update(text).digest('hex');
}

async function temporaryHome(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-migrations-'));
    directories.push(directory);
    return directory;
}
