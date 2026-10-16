import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkbenchPackage } from '../src/catalog/package.js';
import { CatalogSnapshots } from '../src/catalog/snapshots.js';
import type { SnapshotFile } from '../src/catalog/types.js';

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('package snapshots', () => {
    test('are not released while a concurrent run records its reference', async () => {
        const home = await temporaryHome();
        const snapshots = new CatalogSnapshots(home);
        const files = packageFiles();
        const digest = WorkbenchPackage.digest(files);
        const reference = join(home, 'reference');
        const packagePath = snapshots.packagePath(digest, 'core');
        await snapshots.exclusive(digest, async () => {
            await snapshots.materialize('core', files, digest);
        });

        for (let round = 0; round < 5; round += 1) {
            await rm(reference, { force: true });
            // The release finds no reference, then lingers before it removes.
            const release = snapshots.release(digest, async () => {
                const referenced = await exists(reference);
                await Bun.sleep(60);
                return referenced;
            });
            await Bun.sleep(10);
            const create = snapshots.exclusive(digest, async () => {
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
        const snapshots = new CatalogSnapshots(home);
        const files = packageFiles();
        const digest = WorkbenchPackage.digest(files);
        await snapshots.exclusive(digest, async () => {
            await snapshots.materialize('core', files, digest);
        });

        await snapshots.release(digest, async () => false);

        expect(await exists(snapshots.packagePath(digest, 'core'))).toBeFalse();
        expect(await readdir(join(home, 'packages'))).toEqual([]);
    });

    test('never appear at the package path half written', async () => {
        const home = await temporaryHome();
        const snapshots = new CatalogSnapshots(home);
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
            snapshots.exclusive(brokenDigest, () =>
                snapshots.materialize('core', broken)
            )
        ).rejects.toThrow('Invalid Workbench package file path');
        expect(await exists(snapshots.packagePath(brokenDigest, 'core'))).toBeFalse();

        await snapshots.exclusive(digest, async () => {
            await snapshots.materialize('core', files, digest);
        });

        expect(await readdir(packagePath)).toEqual(['workbench.yml']);
    });

    test('lose the leftovers of a crashed removal when materialized or released', async () => {
        const home = await temporaryHome();
        const snapshots = new CatalogSnapshots(home);
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

        await snapshots.exclusive(digest, async () => {
            await snapshots.materialize('core', files, digest);
        });

        expect(await exists(leftover('first'))).toBeFalse();
        expect(await exists(other)).toBeTrue();

        await plant(leftover('second'));
        await snapshots.release(digest, async () => true);

        expect(await exists(leftover('second'))).toBeFalse();
        expect(await exists(other)).toBeTrue();
        expect(await exists(snapshots.packagePath(digest, 'core'))).toBeTrue();
    });
});

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
