import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { WorkbenchPackage } from './package.js';
import type { SnapshotFile } from './types.js';

export interface MaterializedSnapshot {
    digest: string;
    packagePath: string;
}

/**
 * Content addressed package snapshots shared by the catalog and by sessions.
 * The files only: a `SnapshotGuard` serializes callers that record or drop
 * references to a digest.
 */
export class CatalogSnapshots {
    constructor(readonly home: string) {}

    /** Writes a snapshot. The caller holds the guard for its digest. */
    async materialize(
        selector: string,
        files: SnapshotFile[],
        expectedDigest?: string
    ): Promise<MaterializedSnapshot> {
        const digest = WorkbenchPackage.digest(files);
        if (expectedDigest && digest !== expectedDigest) {
            throw new Error(
                `Registry package digest mismatch: expected ${expectedDigest}, received ${digest}`
            );
        }
        const packagePath = this.packagePath(digest, selector);
        await this.sweepRemoved(digest);
        await this.write(packagePath, files);
        return { digest, packagePath };
    }

    /** Where a snapshot lives. Snapshots are content addressed and shared. */
    packagePath(digest: string, selector: string): string {
        return join(this.root(digest), '.workbenches', selector);
    }

    /**
     * Removes a snapshot. The snapshot leaves its path in one rename, so a
     * partly deleted snapshot is never found where a package should be.
     */
    async discard(digest: string): Promise<void> {
        const root = this.root(digest);
        const removing = join(
            dirname(root),
            `.${basename(root)}.${crypto.randomUUID()}.removing`
        );
        const moved = await rename(root, removing).then(
            () => true,
            (error) => {
                if (error?.code === 'ENOENT') return false;
                throw error;
            }
        );
        if (moved) await rm(removing, { recursive: true, force: true });
    }

    /** Deletes what a crash left between a removal's rename and its delete. */
    async sweepRemoved(digest: string): Promise<void> {
        const root = this.root(digest);
        const prefix = `.${basename(root)}.`;
        const names = await readdir(dirname(root)).catch(() => []);
        await Promise.all(
            names
                .filter((name) => name.startsWith(prefix) && name.endsWith('.removing'))
                .map((name) =>
                    rm(join(dirname(root), name), { recursive: true, force: true })
                )
        );
    }

    root(digest: string): string {
        return join(this.home, 'packages', digest.slice('sha256:'.length));
    }

    private async write(packagePath: string, files: SnapshotFile[]): Promise<void> {
        if (await stat(packagePath).catch(() => null)) return;
        await mkdir(dirname(packagePath), { recursive: true });
        const staging = join(
            dirname(packagePath),
            `.${basename(packagePath)}.${crypto.randomUUID()}`
        );
        try {
            await mkdir(staging);
            for (const file of files) {
                const destination = join(staging, file.path);
                const fromPackage = relative(staging, destination);
                if (fromPackage.startsWith('..') || isAbsolute(fromPackage)) {
                    throw new Error(
                        `Invalid Workbench package file path: ${file.path}`
                    );
                }
                await mkdir(dirname(destination), { recursive: true });
                await writeFile(destination, file.bytes, {
                    mode: file.executable ? 0o755 : 0o644,
                });
            }
            await rename(staging, packagePath).catch(async (error) => {
                if (await stat(packagePath).catch(() => null)) return;
                throw error;
            });
        } finally {
            await rm(staging, { recursive: true, force: true });
        }
    }
}
