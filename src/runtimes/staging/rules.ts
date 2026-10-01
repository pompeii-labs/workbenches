import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface SymlinkCheck {
    /** The directory the link sits in. */
    parent: string;
    /** What the link points at. */
    link: string;
    /** The link's path as shown in the message. */
    displayPath: string;
    /** When set, the link must stay inside this directory. */
    root?: string;
}

/**
 * Which paths are safe inside a transfer archive, for every provider that
 * copies host files into a sandbox. `provider` names the transfer in messages,
 * for example `E2B`.
 */
export class TransferRules {
    constructor(readonly provider: string) {}

    normalizeArchivePath(path: string): string {
        return path.split(sep).join('/').replace(/^\.\//, '');
    }

    contains(parent: string, child: string): boolean {
        const suffix = relative(resolve(parent), resolve(child));
        return (
            suffix === '' ||
            (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix))
        );
    }

    excludedByNestedAsset(path: string, roots: string[]): boolean {
        return roots.some((root) => path === root || path.startsWith(`${root}/`));
    }

    validateRelativePath(path: string): void {
        if (
            !path ||
            path === '.' ||
            isAbsolute(path) ||
            path.split('/').some((segment) => segment === '..' || segment === '')
        ) {
            throw new Error(`Unsafe ${this.provider} archive path: ${path}`);
        }
    }

    validateSymlink(check: SymlinkCheck): void {
        const { parent, link, displayPath, root } = check;
        if (isAbsolute(link)) {
            throw new Error(
                `Absolute symlink is not allowed in ${this.provider} transfer: ${displayPath}`
            );
        }
        if (root && !this.contains(root, resolve(parent, link))) {
            throw new Error(
                `Escaping symlink is not allowed in ${this.provider} transfer: ${displayPath}`
            );
        }
    }
}
