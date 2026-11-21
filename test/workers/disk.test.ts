import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkerController } from '../../src/workers/controller.js';
import { WorkerDisk } from '../../src/workers/disk.js';
import { WorkerHome } from '../../src/workers/home.js';

const directories: string[] = [];
afterEach(async () => {
    for (const directory of directories.splice(0))
        await rm(directory, { recursive: true, force: true });
});

test('measures worker bytes without following links and serves cached status', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-worker-disk-'));
    directories.push(directory);
    const home = new WorkerHome(directory);
    await home.ensure();
    for (const [name, size] of [
        ['workspaces/run_1/source', 100],
        ['outcomes/manifest', 20],
        ['blobs/content', 30],
        ['members/context', 40],
    ] as const) {
        const path = join(home.root, name);
        await mkdir(join(path, '..'), { recursive: true });
        await writeFile(path, Buffer.alloc(size));
    }
    const outside = join(directory, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'large'), Buffer.alloc(10000));
    await symlink(outside, join(home.root, 'workspaces', 'linked'));
    const disk = new WorkerDisk(home);
    const now = new Date('2026-01-08T00:00:00.000Z');
    await disk.refresh(now);
    expect(await disk.read()).toMatchObject({
        home_bytes: 190,
        workspaces_bytes: 100,
        outcomes_bytes: 50,
        measured_at: now.toISOString(),
    });
    // A status query reads the measurement, not the changing workspace trees.
    await writeFile(
        join(home.root, 'workspaces', 'run_1', 'source'),
        Buffer.alloc(200)
    );
    const status = await new WorkerController(directory).status();
    expect(status.wb_version).toBeString();
    expect(status.disk.home_bytes).toBe(190);
    expect(status.disk.free_bytes).toBeGreaterThan(0);
});

test('status remains a cache read with hundreds of workspaces and no measurement yet', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-worker-disk-'));
    directories.push(directory);
    const home = new WorkerHome(directory);
    await home.ensure();
    await mkdir(join(home.root, 'workspaces'));
    for (let index = 0; index < 300; index++)
        await mkdir(home.workspaceDirectory(`run_${index}`));
    const status = await new WorkerController(directory).status();
    expect(status.disk.home_bytes).toBeNull();
    expect(status.disk.measured_at).toBeNull();
    expect(status.disk.free_bytes).toBeGreaterThan(0);
});
