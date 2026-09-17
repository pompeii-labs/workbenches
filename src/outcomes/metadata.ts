import { randomBytes } from 'node:crypto';
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function requireMetadataFile(path: string): Promise<void> {
    const details = await lstat(path).catch((error) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
            return undefined;
        throw error;
    });
    if (
        details &&
        (!details.isFile() ||
            details.isSymbolicLink() ||
            details.size > 16 * 1_024 * 1_024)
    ) {
        throw new Error('Outcome metadata is not a bounded regular file');
    }
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
        await writeJson(temporary, value);
        await rename(temporary, path);
    } finally {
        await rm(temporary, { force: true });
    }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
    await writeFile(path, jsonSource(value), { mode: 0o600, flag: 'wx' });
}

export function jsonSource(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
}
