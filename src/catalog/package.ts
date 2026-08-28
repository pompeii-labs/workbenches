import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

import type { ResolvedWorkbench } from '../types.js';
import type { SnapshotFile } from './types.js';

export class WorkbenchPackage {
    constructor(readonly workbench: ResolvedWorkbench) {}

    async files(): Promise<SnapshotFile[]> {
        this.ensurePortable();
        await this.rejectSymlinks();
        return this.readFiles();
    }

    static digest(files: SnapshotFile[]): string {
        const hash = createHash('sha256');
        for (const file of files.toSorted((left, right) =>
            left.path.localeCompare(right.path)
        )) {
            hash.update(file.path);
            hash.update('\0');
            hash.update(file.executable ? 'x' : '-');
            hash.update('\0');
            hash.update(file.bytes);
            hash.update('\0');
        }
        return `sha256:${hash.digest('hex')}`;
    }

    private async readFiles(relativePath = ''): Promise<SnapshotFile[]> {
        const entries = await readdir(
            join(this.workbench.packageDirectory, relativePath),
            { withFileTypes: true }
        );
        const files: SnapshotFile[] = [];
        for (const entry of entries.sort((left, right) =>
            left.name.localeCompare(right.name)
        )) {
            const path = join(relativePath, entry.name);
            if (entry.isDirectory()) {
                files.push(...(await this.readFiles(path)));
            } else if (entry.isFile()) {
                const details = await lstat(
                    join(this.workbench.packageDirectory, path)
                );
                files.push({
                    path,
                    bytes: await readFile(join(this.workbench.packageDirectory, path)),
                    executable: Boolean(details.mode & 0o111),
                });
            }
        }
        return files;
    }

    private async rejectSymlinks(relativePath = ''): Promise<void> {
        for (const entry of await readdir(
            join(this.workbench.packageDirectory, relativePath)
        )) {
            const path = join(relativePath, entry);
            const details = await lstat(join(this.workbench.packageDirectory, path));
            if (details.isSymbolicLink()) {
                throw new Error(`Workbench packages may not contain symlinks: ${path}`);
            }
            if (details.isDirectory()) await this.rejectSymlinks(path);
        }
    }

    private ensurePortable(): void {
        const paths = [
            this.workbench.instructionsPath,
            ...this.workbench.skills.map((skill) => skill.directory),
        ];
        for (const path of paths) {
            const relativePath = relative(this.workbench.packageDirectory, path);
            if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
                throw new Error(
                    'Saved Workbenches must keep instructions and skills inside the package'
                );
            }
        }
    }
}
