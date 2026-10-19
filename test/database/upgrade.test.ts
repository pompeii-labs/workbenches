import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Connection } from '../../src/database/connection.js';
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

const RUN = 'wb_upgraderun1234567890123';
const SESSION = 'wb_upgradesession1234567890';

/**
 * Every shipped schema version must upgrade to the current one with the rows a
 * real database holds. The seed uses only columns the first schema has, which
 * later migrations must keep. A migration that changes how these rows are
 * stored extends the seed.
 */
describe('upgrading a database from each schema version', () => {
    for (const { version } of migrations) {
        test(`from schema ${version} keeps its rows and matches a fresh database`, async () => {
            const directory = await temporaryDirectory();
            const path = join(directory, 'wb.db');

            const old = open(path, migrations.slice(0, version));
            seed(old);
            old.close();
            const upgraded = open(path, migrations);

            expect(upgraded.one('PRAGMA integrity_check')).toEqual({
                integrity_check: 'ok',
            });
            expect(upgraded.all('PRAGMA foreign_key_check')).toEqual([]);
            expect(
                upgraded.all('SELECT version FROM __migrations ORDER BY version')
            ).toEqual(migrations.map((migration) => ({ version: migration.version })));
            expect(
                upgraded.one('SELECT id, workbench, project_id FROM sessions')
            ).toEqual({
                id: SESSION,
                workbench: 'fixture-core',
                project_id: null,
            });
            expect(upgraded.one('SELECT id, status, session_id FROM runs')).toEqual({
                id: RUN,
                status: 'running',
                session_id: SESSION,
            });
            expect(
                upgraded.all(
                    'SELECT sequence, type FROM events WHERE run_id = ? ORDER BY id',
                    RUN
                )
            ).toEqual([
                { sequence: 1, type: 'run.started' },
                { sequence: 2, type: 'output.text' },
                { sequence: 3, type: 'run.completed' },
            ]);
            expect(upgraded.one('SELECT name, token FROM leases')).toEqual({
                name: `session:${SESSION}`,
                token: 'holder',
            });
            expect(
                upgraded.one('SELECT id, run_id, state FROM control_requests')
            ).toEqual({ id: 'ctl_1', run_id: RUN, state: 'pending' });

            const fresh = open(join(directory, 'fresh.db'), migrations);
            expect(schema(upgraded)).toEqual(schema(fresh));
        });
    }
});

function open(path: string, history: readonly Migration[]): Connection {
    const connection = new Connection(path, new Migrator(history));
    connections.push(connection);
    return connection;
}

function seed(connection: Connection): void {
    connection.run(
        `INSERT INTO sessions (
            id, name, workbench, workbench_version, runner, model, runtime, reference,
            workbench_path, workspace, workspaces, native_path, latest_run_id,
            created_at, updated_at
        ) VALUES (?, 'upgrade', 'fixture-core', '0.1.0', 'opencode', 'openai/gpt-5.6-terra',
            'local', 'fixture-core', '/packages/core', '/workspace', '[]', '/native', ?,
            '2026-08-18T00:00:00.000Z', '2026-08-18T00:00:00.000Z')`,
        SESSION,
        RUN
    );
    connection.run(
        `INSERT INTO runs (
            id, status, workbench, workbench_version, runner, model, workspace,
            dispatched_at, session_id
        ) VALUES (?, 'running', 'fixture-core', '0.1.0', 'opencode',
            'openai/gpt-5.6-terra', '/workspace', '2026-08-18T00:00:00.000Z', ?)`,
        RUN,
        SESSION
    );
    for (const [sequence, type] of [
        [1, 'run.started'],
        [2, 'output.text'],
        [3, 'run.completed'],
    ] as const)
        connection.run(
            `INSERT INTO events (run_id, sequence, type, timestamp, payload)
             VALUES (?, ?, ?, '2026-08-18T00:00:00.000Z', '{}')`,
            RUN,
            sequence,
            type
        );
    connection.run(
        "INSERT INTO leases (name, token, pid, acquired_at) VALUES (?, 'holder', ?, 0)",
        `session:${SESSION}`,
        process.pid
    );
    connection.run(
        `INSERT INTO control_requests (id, run_id, kind, state, payload)
         VALUES ('ctl_1', ?, 'send', 'pending', '{}')`,
        RUN
    );
}

function schema(connection: Connection) {
    return connection.all(
        `SELECT type, name, tbl_name, sql FROM sqlite_master
         WHERE substr(name, 1, 7) <> 'sqlite_' ORDER BY type, name`
    );
}

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-upgrade-'));
    directories.push(directory);
    return directory;
}
