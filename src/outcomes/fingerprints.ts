import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { OutcomePathFingerprint, OutcomePathState } from './contracts.js';
import { assertSafeOutcomePath } from './validation.js';

export async function validateRoot(root: string): Promise<void> {
    const details = await lstat(root).catch(() => undefined);
    if (!details || details.isSymbolicLink() || !details.isDirectory())
        throw new Error(`Outcome workspace is unavailable or unsafe: ${root}`);
}

export async function validateDestination(root: string, path: string): Promise<void> {
    assertSafeOutcomePath(path);
    let parent = root;
    for (const segment of path.split('/').slice(0, -1)) {
        parent = join(parent, segment);
        const details = await lstat(parent).catch((error) => {
            if (isNodeError(error, 'ENOENT')) return undefined;
            throw error;
        });
        if (!details) return;
        if (details.isSymbolicLink() || !details.isDirectory())
            throw new Error(
                `Outcome destination has an unsafe parent: ${join(root, path)}`
            );
    }
}

export async function fingerprint(
    path: string,
    root: string,
    displayPath: string
): Promise<OutcomePathFingerprint | undefined> {
    const details = await lstat(path).catch((error) => {
        if (isNodeError(error, 'ENOENT')) return undefined;
        throw error;
    });
    if (!details) return undefined;
    if (details.isSymbolicLink()) {
        const target = await readlink(path);
        validateSymlinkTarget(dirname(path), target, root, displayPath);
        return { kind: 'symlink', mode: details.mode & 0o777, target };
    }
    if (!details.isFile())
        throw new Error(`Outcome destination is not a file: ${displayPath}`);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return {
        kind: 'file',
        digest: `sha256:${hash.digest('hex')}`,
        mode: details.mode & 0o777,
        size_bytes: details.size,
    };
}

export function sameState(
    current: OutcomePathFingerprint | undefined,
    after: OutcomePathState | undefined
): boolean {
    if (!after) return current === undefined;
    if (!current || current.kind !== after.kind || current.mode !== after.mode)
        return false;
    return current.kind === 'file' && after.kind === 'file'
        ? current.digest === after.content.digest &&
              current.size_bytes === after.content.size_bytes
        : current.kind === 'symlink' && after.kind === 'symlink'
          ? current.target === after.target
          : false;
}

export function sameFingerprint(
    left: OutcomePathFingerprint | undefined,
    right: OutcomePathFingerprint | undefined
): boolean {
    if (!left || !right) return left === right;
    if (left.kind !== right.kind || left.mode !== right.mode) return false;
    return left.kind === 'file' && right.kind === 'file'
        ? left.digest === right.digest && left.size_bytes === right.size_bytes
        : left.kind === 'symlink' && right.kind === 'symlink'
          ? left.target === right.target
          : false;
}

export function validateSymlinkTarget(
    parent: string,
    target: string,
    root: string,
    displayPath: string
): void {
    const suffix = relative(resolve(root), resolve(parent, target));
    if (
        isAbsolute(target) ||
        suffix === '..' ||
        suffix.startsWith(`..${sep}`) ||
        isAbsolute(suffix)
    )
        throw new Error(`Escaping symlink is not allowed in outcome: ${displayPath}`);
}

function isNodeError(error: unknown, code: string): boolean {
    return (
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === code
    );
}
