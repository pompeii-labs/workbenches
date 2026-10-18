import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Connection } from '../../src/database/connection.js';
import { LeaseStore } from '../../src/database/leases.js';
import { ProcessProbe } from '../../src/processes/probe.js';

const process_ = join(import.meta.dir, 'process.ts');
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

        const database = open(home);
        expect(database.all('SELECT name FROM leases')).toEqual([{ name: 'crashed' }]);
        let entered = false;
        await new LeaseStore(database, new ProcessProbe()).exclusive(
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
        const leases = new LeaseStore(open(home), new ProcessProbe());
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
        const database = open(home);
        const probe = new ProcessProbe();
        expect(
            new LeaseStore(database, probe, () => longAgo).tryAcquire('aged', 'first')
        ).toBeTrue();

        expect(
            new LeaseStore(database, probe).tryAcquire('aged', 'second')
        ).toBeFalse();
        expect(database.one('SELECT acquired_at FROM leases')).toEqual({
            acquired_at: longAgo,
        });
    });

    test('are recovered when their owner process is gone', async () => {
        const home = await temporaryHome();
        const database = open(home);
        const leases = new LeaseStore(database, new ProcessProbe());
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

function open(home: string): Connection {
    const connection = Connection.open(home);
    connections.push(connection);
    return connection;
}

async function temporaryHome(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-leases-'));
    directories.push(directory);
    return directory;
}
