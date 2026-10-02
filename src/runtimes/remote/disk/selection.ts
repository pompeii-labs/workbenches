import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The files of a native state directory that a run keeps, by relative path.
 * `provider` names the sandbox provider in messages.
 */
export class StateSelection {
    constructor(
        private readonly directory: string,
        private readonly files: readonly string[],
        private readonly provider: string
    ) {}

    /** The selected files that exist, sorted. A selected path that is not a regular file is refused. */
    async existing(): Promise<string[]> {
        const selected: string[] = [];
        for (const file of this.files.toSorted()) {
            let path = this.directory;
            const parts = file.split('/');
            for (const [index, part] of parts.entries()) {
                path = join(path, part);
                const details = await lstat(path).catch((error) => {
                    if (
                        error instanceof Error &&
                        'code' in error &&
                        error.code === 'ENOENT'
                    )
                        return undefined;
                    throw error;
                });
                if (!details) break;
                const last = index === parts.length - 1;
                if (
                    details.isSymbolicLink() ||
                    !(last ? details.isFile() : details.isDirectory())
                )
                    throw new Error(
                        `${this.provider} native state selection contains a non-regular file`
                    );
                if (last) selected.push(file);
            }
        }
        return selected;
    }
}
