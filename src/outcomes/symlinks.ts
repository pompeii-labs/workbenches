import { lstat, readlink } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { OutcomeChangeEntry } from './contracts.js';

/** Resolve components before '..': a relative link can change the effective depth. */
export function validateOutcomeSymlinks(entries: OutcomeChangeEntry[]): void {
    for (const side of ['before', 'after'] as const) {
        const links = new Map<string, string>();
        for (const entry of entries) {
            const state = entry[side];
            if (state?.kind === 'symlink') links.set(entry.path, state.target);
        }
        for (const [path, target] of links) {
            const walker = components(path, target);
            let step = walker.next();
            while (!step.done) step = walker.next(links.get(step.value));
        }
    }
}

/** Checks unchanged host links as well as the prospective outcome tree. */
export async function validateFilesystemSymlink(
    root: string,
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
            const candidate = join(root, step.value);
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

function* components(
    path: string,
    target: string
): Generator<string, void, string | undefined> {
    const stack: string[] = [];
    const pending = [
        ...posix.dirname(path).split('/'),
        ...relativeTarget(target, path),
    ];
    let followed = 0;
    while (pending.length) {
        const segment = pending.shift();
        if (!segment || segment === '.') continue;
        if (segment === '..') {
            if (!stack.length)
                throw new Error(`Escaping symlink is not allowed in outcome: ${path}`);
            stack.pop();
            continue;
        }
        stack.push(segment);
        const link = yield stack.join('/');
        if (link !== undefined) {
            if (++followed > 40)
                throw new Error(`Cyclic symlink is not allowed in outcome: ${path}`);
            stack.pop();
            pending.unshift(...relativeTarget(link, path));
        }
    }
}

function relativeTarget(target: string, path: string): string[] {
    if (target.startsWith('/') || target.includes('\\') || /^[a-z]:/i.test(target))
        throw new Error(`Escaping symlink is not allowed in outcome: ${path}`);
    return target.split('/');
}
