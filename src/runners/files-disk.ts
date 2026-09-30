import {
    chmod,
    cp,
    lstat,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RunnerFiles } from './files.js';

/** Runner file staging on the local disk. The CLI uses this implementation. */
export const diskRunnerFiles: RunnerFiles = {
    async readFile(path) {
        return new Uint8Array(await readFile(path));
    },
    async writeFile(path, data, options = {}) {
        await writeFile(path, data, {
            ...(options.mode === undefined ? {} : { mode: options.mode }),
            ...(options.exclusive ? { flag: 'wx' } : {}),
        });
    },
    async mkdir(path, options = {}) {
        await mkdir(path, options.recursive ? { recursive: true } : undefined);
    },
    list(path) {
        return readdir(path);
    },
    async stat(path) {
        const details = await lstat(path).catch((error) => {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
                return undefined;
            throw error;
        });
        if (!details) return undefined;
        return {
            kind: details.isSymbolicLink()
                ? 'symlink'
                : details.isFile()
                  ? 'file'
                  : details.isDirectory()
                    ? 'directory'
                    : 'other',
            size: details.size,
        };
    },
    tempDirectory(prefix) {
        return mkdtemp(join(tmpdir(), prefix));
    },
    copy(from, to) {
        return cp(from, to, { recursive: true, preserveTimestamps: true });
    },
    chmod(path, mode) {
        return chmod(path, mode);
    },
    remove(path) {
        return rm(path, { recursive: true, force: true });
    },
};
