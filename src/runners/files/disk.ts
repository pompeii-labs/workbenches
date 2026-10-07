import type { Stats } from 'node:fs';
import {
    chmod,
    cp,
    lstat,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    realpath,
    rm,
    stat,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RunnerFileStat, RunnerFiles } from '../types.js';

/** Runner file staging on the local disk. The runner registry wires it in. */
export class DiskRunnerFiles implements RunnerFiles {
    async readFile(path: string): Promise<Uint8Array> {
        return new Uint8Array(await readFile(path));
    }

    async writeFile(
        path: string,
        data: string | Uint8Array,
        options: { mode?: number; exclusive?: boolean } = {}
    ): Promise<void> {
        await writeFile(path, data, {
            ...(options.mode === undefined ? {} : { mode: options.mode }),
            ...(options.exclusive ? { flag: 'wx' } : {}),
        });
    }

    async mkdir(path: string, options: { recursive?: boolean } = {}): Promise<void> {
        await mkdir(path, options.recursive ? { recursive: true } : undefined);
    }

    list(path: string): Promise<string[]> {
        return readdir(path);
    }

    lstat(path: string): Promise<RunnerFileStat | undefined> {
        return this.describe(lstat(path));
    }

    stat(path: string): Promise<RunnerFileStat | undefined> {
        return this.describe(stat(path));
    }

    realpath(path: string): Promise<string> {
        return realpath(path);
    }

    async symlink(target: string, path: string): Promise<void> {
        await symlink(target, path);
    }

    private async describe(
        details: Promise<Stats>
    ): Promise<RunnerFileStat | undefined> {
        const found = await details.catch((error) => {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
                return undefined;
            throw error;
        });
        if (!found) return undefined;
        return {
            kind: found.isSymbolicLink()
                ? 'symlink'
                : found.isFile()
                  ? 'file'
                  : found.isDirectory()
                    ? 'directory'
                    : 'other',
            size: found.size,
        };
    }

    tempDirectory(prefix: string): Promise<string> {
        return mkdtemp(join(tmpdir(), prefix));
    }

    copy(from: string, to: string): Promise<void> {
        return cp(from, to, { recursive: true, preserveTimestamps: true });
    }

    chmod(path: string, mode: number): Promise<void> {
        return chmod(path, mode);
    }

    remove(path: string): Promise<void> {
        return rm(path, { recursive: true, force: true });
    }
}
