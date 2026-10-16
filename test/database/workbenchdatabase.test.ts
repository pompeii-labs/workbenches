import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DatabaseConstraintError } from '../../src/database/error.js';
import { LeaseStore } from '../../src/database/leasestore.js';
import { type Migration, migrations } from '../../src/database/migrations.js';
import { WorkbenchDatabase } from '../../src/database/workbenchdatabase.js';
import { LegacyLayout } from '../../src/files/legacylayout.js';
import { ProcessProbe } from '../../src/processes/processprobe.js';
import { DuplicateEventSequenceError } from '../../src/runs/error.js';
import { MAXIMUM_EVENT_BYTES } from '../../src/runs/runeventstore.js';
import { RunStore } from '../../src/runs/store.js';

const process_ = join(import.meta.dir, 'process.ts');
const cli = join(import.meta.dir, '..', '..', 'src', 'cli.ts');
const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('database migrations', () => {
    test('build the whole schema from an empty file', async () => {
        const home = await temporaryHome();
        const database = WorkbenchDatabase.forHome(home, {
            filename: 'empty.db',
            history: migrations,
        });

        expect(database.schemaVersion).toBe(migrations.at(-1)?.version ?? -1);
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
        database.close();
    });

    test('apply only the migrations a database has not seen', async () => {
        const home = await temporaryHome();
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
        const at = (history: Migration[]) =>
            WorkbenchDatabase.forHome(home, { filename: 'history.db', history });

        const opened = at([first]);
        opened.run('INSERT INTO first (id) VALUES (7)');
        opened.close();
        const upgraded = at([first, second]);

        expect(upgraded.schemaVersion).toBe(2);
        expect(upgraded.one('SELECT id FROM first')).toEqual({ id: 7 });
        expect(upgraded.all('SELECT id FROM second')).toEqual([]);
        upgraded.close();
        expect(() => at([first])).toThrow('newer version of Workbench');
    });

    test('index events so a run is read in order without sorting', async () => {
        const home = await temporaryHome();
        const database = WorkbenchDatabase.forHome(home);
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

describe('constraint errors', () => {
    test('are raised with a stable code, not a message to match', async () => {
        const home = await temporaryHome();
        const database = WorkbenchDatabase.forHome(home);
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

describe('event size cap', () => {
    test('keeps an oversized event in sequence with its data replaced', async () => {
        const home = await temporaryHome();
        const store = new RunStore(home);
        const run = await store.create({
            metadata: {
                workbench: 'fixture-core',
                workbench_version: '0.1.0',
                runner: 'opencode',
                model: 'openai/gpt-5.6-terra',
                workspace: '/workspace',
            },
            request: {
                workbench_path: '/repo/.workbenches/core',
                workspace: '/w',
                task: '',
            },
        });
        const event = (sequence: number, data: unknown) => ({
            protocol: 0 as const,
            run_id: run.id,
            sequence,
            timestamp: '2026-08-18T00:00:00.000Z',
            type: 'tool.completed' as const,
            runner: 'opencode',
            data,
        });
        const oversized = 'x'.repeat(MAXIMUM_EVENT_BYTES + 1);

        await store.appendEvent(run.id, event(1, { output: 'small' }));
        await store.appendEvent(run.id, event(2, { output: oversized }));
        await store.appendEvent(run.id, event(3, { output: 'after' }));

        const events = await store.readEvents(run.id);
        expect(events.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
        expect(events[0]?.data).toEqual({ output: 'small' });
        expect(events[1]).toMatchObject({
            run_id: run.id,
            sequence: 2,
            type: 'tool.completed',
            data: {
                truncated: true,
                original_bytes: expect.any(Number),
                limit_bytes: MAXIMUM_EVENT_BYTES,
            },
        });
        expect(events[2]?.data).toEqual({ output: 'after' });
        const duplicate = store.appendEvent(run.id, event(3, {}));
        await expect(duplicate).rejects.toBeInstanceOf(DuplicateEventSequenceError);
        await expect(duplicate).rejects.toThrow('Duplicate event sequence 3');
    });
});

describe('leases', () => {
    test('recover from a holder that exited without releasing', async () => {
        const home = await temporaryHome();
        const holder = Bun.spawn(
            [process.execPath, process_, 'hold', home, 'crashed'],
            {
                stdout: 'pipe',
                stderr: 'pipe',
            }
        );
        expect((await new Response(holder.stdout).text()).trim()).toBe('held');
        await holder.exited;

        const database = WorkbenchDatabase.forHome(home);
        expect(database.all('SELECT name FROM leases')).toEqual([{ name: 'crashed' }]);
        let entered = false;
        await new LeaseStore(database).exclusive(
            'crashed',
            {
                timeoutMilliseconds: 1_000,
                pollMilliseconds: 5,
                timeoutMessage: 'timed out',
            },
            async () => {
                entered = true;
            }
        );

        expect(entered).toBeTrue();
        expect(database.all('SELECT name FROM leases')).toEqual([]);
    });

    test('are not taken from a live holder, and time out waiting', async () => {
        const home = await temporaryHome();
        const leases = new LeaseStore(WorkbenchDatabase.forHome(home));
        expect(leases.tryAcquire('busy', 'first')).toBeTrue();

        expect(leases.tryAcquire('busy', 'second')).toBeFalse();
        await expect(
            leases.exclusive(
                'busy',
                {
                    timeoutMilliseconds: 30,
                    pollMilliseconds: 5,
                    timeoutMessage: 'waited',
                },
                async () => undefined
            )
        ).rejects.toThrow('waited');
        leases.release('busy', 'second');
        expect(leases.tryAcquire('busy', 'third')).toBeFalse();
        leases.release('busy', 'first');
        expect(leases.tryAcquire('busy', 'third')).toBeTrue();
    });

    test('stay with a live holder however old they are', async () => {
        const home = await temporaryHome();
        const longAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
        const database = WorkbenchDatabase.forHome(home);
        expect(
            new LeaseStore(database, () => longAgo).tryAcquire('aged', 'first')
        ).toBeTrue();

        expect(new LeaseStore(database).tryAcquire('aged', 'second')).toBeFalse();
        expect(database.one('SELECT acquired_at FROM leases')).toEqual({
            acquired_at: longAgo,
        });
    });

    test('are recovered when their owner process is gone', async () => {
        const home = await temporaryHome();
        const database = WorkbenchDatabase.forHome(home);
        const leases = new LeaseStore(database);
        const finished = Bun.spawn(['true']);
        await finished.exited;
        database.run(
            'INSERT INTO leases (name, token, pid, acquired_at) VALUES (?, ?, ?, 0)',
            'gone',
            'planted',
            finished.pid
        );

        expect(leases.tryAcquire('gone', 'next')).toBeTrue();
    });
});

describe('earlier file-based layout', () => {
    test('is noticed once per database and never touched', async () => {
        const home = await legacyHome();

        const first = await runCli(home, ['ps', '--all']);
        const second = await runCli(home, ['ps', '--all']);

        expect(first.code).toBe(0);
        expect(notices(first.stderr)).toHaveLength(1);
        expect(first.stderr).toContain(home);
        expect(second.code).toBe(0);
        expect(notices(second.stderr)).toEqual([]);
        expect((await stat(join(home, 'runs', 'keep.txt'))).isFile()).toBeTrue();
        expect((await stat(join(home, 'sessions'))).isDirectory()).toBeTrue();
    });

    test('is announced by ps even after a status line opened the database', async () => {
        const home = await legacyHome();

        const line = await runCli(home, ['status', '--line']);
        const ps = await runCli(home, ['ps', '--all']);

        expect(line.code).toBe(0);
        expect(notices(line.stderr)).toEqual([]);
        expect(notices(ps.stderr)).toHaveLength(1);
    });

    test('is silent when a database is opened for a home that never had it', async () => {
        const home = await temporaryHome();
        const write = spyOn(process.stderr, 'write');
        try {
            WorkbenchDatabase.forHome(home);
            expect(write).not.toHaveBeenCalled();
        } finally {
            write.mockRestore();
        }
    });

    test('blocks new runs while one of its workers is alive', async () => {
        const home = await temporaryHome();
        const run = 'wb_oldworker1234567890123';
        // The shell stays the parent of sleep, so the old worker argv is its own.
        const worker = Bun.spawn(['sh', '-c', 'sleep 30; true', '__worker', home, run]);
        try {
            const record = await legacyRecord(home, run, {
                status: 'running',
                pid: worker.pid,
            });
            const layout = new LegacyLayout(home);

            await expect(layout.assertNoLiveWorker()).rejects.toThrow(
                `earlier version of Workbench is still active (${run}, process ${worker.pid})`
            );
            await expect(layout.assertNoLiveWorker()).rejects.toThrow(record);

            worker.kill();
            await worker.exited;
            await expect(layout.assertNoLiveWorker()).resolves.toBeUndefined();
        } finally {
            worker.kill();
        }
    });

    test('does not block on a recorded pid that is not an old worker', async () => {
        const home = await temporaryHome();
        const unrelated = Bun.spawn(['sleep', '30']);
        const finished = Bun.spawn(['true']);
        await finished.exited;
        try {
            // A reused pid now running something else.
            await legacyRecord(home, 'wb_reusedpid12345678901234', {
                status: 'running',
                pid: unrelated.pid,
            });
            // Another user's process, as pid 1 is to this one.
            await legacyRecord(home, 'wb_foreignpid1234567890123', {
                status: 'running',
                pid: 1,
            });
            await legacyRecord(home, 'wb_deadpid123456789012345', {
                status: 'dispatched',
                pid: finished.pid,
            });

            await expect(
                new LegacyLayout(home).assertNoLiveWorker()
            ).resolves.toBeUndefined();
        } finally {
            unrelated.kill();
        }
    });

    test('blocks when the recorded pid is alive but its command line cannot be read', async () => {
        const home = await temporaryHome();
        const record = await legacyRecord(home, 'wb_unreadable12345678901234', {
            status: 'running',
            pid: 4242,
        });
        const probe = new ProcessProbe();
        probe.alive = () => true;
        probe.command = () => undefined;

        await expect(
            new LegacyLayout(home, probe).assertNoLiveWorker()
        ).rejects.toThrow(record);
    });

    test('does not block on finished runs or runs with no process', async () => {
        const home = await temporaryHome();
        await legacyRecord(home, 'wb_finished12345678901234', {
            status: 'completed',
            pid: process.pid,
        });
        await legacyRecord(home, 'wb_noprocess12345678901234', { status: 'running' });

        await expect(
            new LegacyLayout(home).assertNoLiveWorker()
        ).resolves.toBeUndefined();
    });
});

async function temporaryHome(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-database-'));
    directories.push(directory);
    return directory;
}

async function legacyHome(): Promise<string> {
    const home = await temporaryHome();
    await mkdir(join(home, 'sessions', 'wb_oldsession1234567890123'), {
        recursive: true,
    });
    await mkdir(join(home, 'runs'));
    await writeFile(join(home, 'runs', 'keep.txt'), 'old data');
    return home;
}

async function legacyRecord(
    home: string,
    run: string,
    record: Record<string, unknown>
): Promise<string> {
    const directory = join(home, 'runs', run);
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'run.json');
    await writeFile(path, JSON.stringify(record));
    return path;
}

function notices(text: string): string[] {
    return text.split('\n').filter((line) => line.includes('earlier version'));
}

async function runCli(home: string, args: string[]) {
    const child = Bun.spawn([process.execPath, cli, ...args], {
        env: { ...process.env, WORKBENCH_HOME: home },
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    return { stdout, stderr, code };
}
