import { isAbsolute, join, relative, resolve } from 'node:path';

import type { RunnerFiles } from '../types.js';

/** Copies package content while replacing safe links and omitting escaping links. */
export async function copyPackageTree(
    files: RunnerFiles,
    source: string,
    destination: string,
    packageDirectory: string
): Promise<string[]> {
    await files.copy(source, destination);
    const warnings: string[] = [];
    const packageRoot = await files.realpath(packageDirectory);
    await sanitizeCopiedLinks(
        files,
        source,
        destination,
        packageRoot,
        warnings,
        new Set()
    );
    return warnings;
}

async function sanitizeCopiedLinks(
    files: RunnerFiles,
    source: string,
    destination: string,
    packageRoot: string,
    warnings: string[],
    visited: Set<string>
): Promise<void> {
    const details = await files.lstat(source);
    if (!details) return;
    if (details.kind === 'symlink') {
        const target = await files.realpath(source).catch(() => undefined);
        await files.remove(destination);
        if (!target || !within(packageRoot, target) || visited.has(target)) {
            warnings.push(
                `Package symlink ${relative(packageRoot, source)} was skipped because it resolves outside the package or forms a cycle`
            );
            return;
        }
        visited.add(target);
        await files.copy(target, destination);
        await sanitizeCopiedLinks(
            files,
            target,
            destination,
            packageRoot,
            warnings,
            visited
        );
        visited.delete(target);
        return;
    }
    if (details.kind !== 'directory') return;
    for (const child of await files.list(source)) {
        await sanitizeCopiedLinks(
            files,
            join(source, child),
            join(destination, child),
            packageRoot,
            warnings,
            visited
        );
    }
}

function within(root: string, candidate: string): boolean {
    const path = relative(resolve(root), resolve(candidate));
    return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}
