import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';

import { WorkbenchPackage } from './package.js';
import type { SnapshotFile } from './types.js';

export interface MaterializedSnapshot {
    digest: string;
    packagePath: string;
}

export class CatalogSnapshots {
    constructor(readonly home: string) {}

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
        const snapshotRoot = join(
            this.home,
            'packages',
            digest.slice('sha256:'.length)
        );
        const packagePath = join(snapshotRoot, '.workbenches', selector);
        await this.write(packagePath, files);
        return { digest, packagePath };
    }

    async remove(digest: string): Promise<void> {
        await rm(join(this.home, 'packages', digest.slice('sha256:'.length)), {
            recursive: true,
            force: true,
        });
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
