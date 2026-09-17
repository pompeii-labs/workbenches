import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Do not follow pre-existing symlinks inside engine-owned storage. */
export async function outcomeStorageDirectory(
    root: string,
    segments: string[],
    create = false
): Promise<void> {
    let path = root;
    for (const segment of ['', ...segments]) {
        if (segment) path = join(path, segment);
        if (create)
            await mkdir(path, { mode: 0o700 }).catch((error) => {
                if (
                    !(
                        error instanceof Error &&
                        'code' in error &&
                        error.code === 'EEXIST'
                    )
                )
                    throw error;
            });
        const details = await lstat(path).catch((error) => {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
                return undefined;
            throw error;
        });
        if (!details) return;
        if (!details.isDirectory() || details.isSymbolicLink()) {
            throw new Error(`Outcome storage must use real directories: ${path}`);
        }
    }
}
