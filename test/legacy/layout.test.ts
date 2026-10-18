import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LegacyLayout } from '../../src/legacy/layout.js';
import { ProcessProbe } from '../../src/processes/probe.js';

const cli = join(import.meta.dir, '..', '..', 'src', 'cli.ts');
const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
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
            const layout = new LegacyLayout(home, new ProcessProbe());

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
                new LegacyLayout(home, new ProcessProbe()).assertNoLiveWorker()
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
            new LegacyLayout(home, new ProcessProbe()).assertNoLiveWorker()
        ).resolves.toBeUndefined();
    });
});

async function temporaryHome(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-legacy-'));
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
