import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SnapshotGuard } from '../src/catalog/guard.js';
import { WorkbenchPackage } from '../src/catalog/package.js';
import { CatalogSnapshots } from '../src/catalog/snapshots.js';
import type { SnapshotFile } from '../src/catalog/types.js';
import { Connection } from '../src/database/connection.js';
import { LeaseStore } from '../src/database/leases.js';
import { ProcessProbe } from '../src/processes/probe.js';
import { SessionStore } from '../src/sessions/store.js';

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

describe('package snapshots', () => {
    test('are not released while a concurrent run records its reference', async () => {
        const home = await temporaryHome();
        const { snapshots, guard } = fixture(home);
        const files = packageFiles();
        const digest = WorkbenchPackage.digest(files);
        const reference = join(home, 'reference');
        const packagePath = snapshots.packagePath(digest, 'core');
        await guard.exclusive(digest, async () => {
            await snapshots.materialize('core', files, digest);
        });

        for (let round = 0; round < 5; round += 1) {
            await rm(reference, { force: true });
            // The release finds no reference, then lingers before it removes.
            const release = guard.release(digest, async () => {
                const referenced = await exists(reference);
                await Bun.sleep(60);
                return referenced;
            });
            await Bun.sleep(10);
            const create = guard.exclusive(digest, async () => {
                await snapshots.materialize('core', files, digest);
                await writeFile(reference, '');
            });
            await Promise.all([release, create]);

            expect(await exists(reference)).toBeTrue();
            expect(await exists(join(packagePath, 'workbench.yml'))).toBeTrue();
        }
    });

    test('are removed in one step and leave nothing at the package path', async () => {
        const home = await temporaryHome();
        const { snapshots, guard } = fixture(home);
        const files = packageFiles();
        const digest = WorkbenchPackage.digest(files);
        await guard.exclusive(digest, async () => {
            await snapshots.materialize('core', files, digest);
        });

        await guard.release(digest, async () => false);

        expect(await exists(snapshots.packagePath(digest, 'core'))).toBeFalse();
        expect(await readdir(join(home, 'packages'))).toEqual([]);
    });

    test('never appear at the package path half written', async () => {
        const home = await temporaryHome();
        const { snapshots, guard } = fixture(home);
        const files = packageFiles();
        const digest = WorkbenchPackage.digest(files);
        const packagePath = snapshots.packagePath(digest, 'core');

        // A crashed removal leaves its partly deleted directory beside the root.
        const leftover = join(home, 'packages', `.${digest.slice(7)}.crashed.removing`);
        await mkdir(join(leftover, '.workbenches', 'core'), { recursive: true });
        await writeFile(join(leftover, '.workbenches', 'core', 'stale.txt'), '');
        // A write that fails midway must not leave a package behind.
        const broken: SnapshotFile[] = [
            files[0] as SnapshotFile,
            { path: '../escape', bytes: new Uint8Array(), executable: false },
        ];
        const brokenDigest = WorkbenchPackage.digest(broken);
        await expect(
            guard.exclusive(brokenDigest, () => snapshots.materialize('core', broken))
        ).rejects.toThrow('Invalid Workbench package file path');
        expect(await exists(snapshots.packagePath(brokenDigest, 'core'))).toBeFalse();

        await guard.exclusive(digest, async () => {
            await snapshots.materialize('core', files, digest);
        });

        expect(await readdir(packagePath)).toEqual(['workbench.yml']);
    });

    test('lose the leftovers of a crashed removal when materialized or released', async () => {
        const home = await temporaryHome();
        const { snapshots, guard } = fixture(home);
        const files = packageFiles();
        const digest = WorkbenchPackage.digest(files);
        const packages = join(home, 'packages');
        const leftover = (suffix: string, name = digest.slice(7)) =>
            join(packages, `.${name}.${suffix}.removing`);
        const plant = async (path: string) => {
            await mkdir(join(path, '.workbenches', 'core'), { recursive: true });
            await writeFile(join(path, '.workbenches', 'core', 'stale.txt'), '');
        };
        const other = leftover('crashed', 'f'.repeat(64));
        await plant(leftover('first'));
        await plant(other);

        await guard.exclusive(digest, async () => {
            await snapshots.materialize('core', files, digest);
        });

        expect(await exists(leftover('first'))).toBeFalse();
        expect(await exists(other)).toBeTrue();

        await plant(leftover('second'));
        await guard.release(digest, async () => true);

        expect(await exists(leftover('second'))).toBeFalse();
        expect(await exists(other)).toBeTrue();
        expect(await exists(snapshots.packagePath(digest, 'core'))).toBeTrue();
    });
});

function fixture(home: string) {
    const connection = Connection.open(home);
    connections.push(connection);
    const probe = new ProcessProbe();
    const snapshots = new CatalogSnapshots(home);
    const guard = new SnapshotGuard(
        snapshots,
        new LeaseStore(connection, probe),
        new SessionStore(connection, home, probe)
    );
    return { snapshots, guard };
}

function packageFiles(): SnapshotFile[] {
    return [
        {
            path: 'workbench.yml',
            bytes: new TextEncoder().encode('spec: 1\nname: core\n'),
            executable: false,
        },
    ];
}

async function exists(path: string): Promise<boolean> {
    return (await stat(path).catch(() => null)) !== null;
}

async function temporaryHome(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-snapshots-'));
    directories.push(directory);
    return directory;
}
