import { lstat, readdir, readFile, readlink, stat } from 'node:fs/promises';

import type { AssetGit, AssetSource, AssetStat } from './source.js';

function describe(details: {
    isSymbolicLink(): boolean;
    isFile(): boolean;
    isDirectory(): boolean;
    size: number;
    mode: number;
}): AssetStat {
    return {
        kind: details.isSymbolicLink()
            ? 'symlink'
            : details.isFile()
              ? 'file'
              : details.isDirectory()
                ? 'directory'
                : 'other',
        size: details.size,
        mode: details.mode & 0o777,
    };
}

async function missingAsUndefined<T>(operation: Promise<T>): Promise<T | undefined> {
    return operation.catch((error) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
            return undefined;
        throw error;
    });
}

async function git(
    root: string,
    args: string[]
): Promise<{ code: number; stdout: Uint8Array }> {
    const child = Bun.spawn(['git', ...args], {
        cwd: root,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
    });
    const stdout = new Uint8Array(await new Response(child.stdout).arrayBuffer());
    return { code: await child.exited, stdout };
}

const diskGit: AssetGit = {
    async files(root) {
        const result = await git(root, [
            'ls-files',
            '--cached',
            '--others',
            '--exclude-standard',
            '-z',
            '--',
            '.',
        ]);
        if (result.code !== 0) return undefined;
        return new TextDecoder().decode(result.stdout).split('\0').filter(Boolean);
    },
    async tracked(root, path) {
        const result = await git(root, ['ls-files', '--error-unmatch', '--', path]);
        return result.code === 0;
    },
    async revision(root) {
        const result = await git(root, ['rev-parse', 'HEAD']);
        if (result.code !== 0) return undefined;
        const revision = new TextDecoder().decode(result.stdout).trim();
        return /^[a-f0-9]{40,64}$/.test(revision) ? revision : undefined;
    },
};

/** Reads staged assets from the local disk. The CLI uses this source. */
export const diskAssetSource: AssetSource = {
    async stat(path) {
        const details = await missingAsUndefined(stat(path));
        return details ? describe(details) : undefined;
    },
    async lstat(path) {
        const details = await missingAsUndefined(lstat(path));
        return details ? describe(details) : undefined;
    },
    list: (path) => readdir(path),
    readLink: (path) => readlink(path),
    async read(path) {
        return new Uint8Array(await readFile(path));
    },
    git: diskGit,
};
