import { lstat, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { OutcomeChangeEntry } from '../contracts.js';
import { components } from './rules.js';

/** Checks links under one workspace root on the host disk. */
export class FilesystemSymlinks {
    constructor(private readonly root: string) {}

    /** Checks unchanged host links as well as the prospective outcome tree. */
    async validate(
        path: string,
        target: string,
        entries: OutcomeChangeEntry[]
    ): Promise<void> {
        const prospective = new Map(entries.map((entry) => [entry.path, entry.after]));
        const walker = components(path, target);
        let step = walker.next();
        while (!step.done) {
            let link: string | undefined;
            if (prospective.has(step.value)) {
                const state = prospective.get(step.value);
                if (state?.kind === 'symlink') link = state.target;
            } else {
                const candidate = join(this.root, step.value);
                const details = await lstat(candidate).catch((error) => {
                    if (
                        error instanceof Error &&
                        'code' in error &&
                        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
                    )
                        return undefined;
                    throw error;
                });
                if (details?.isSymbolicLink()) link = await readlink(candidate);
            }
            step = walker.next(link);
        }
    }
}
