import { dirname, posix } from 'node:path';

import { formatOutcomeBytes } from '../../../outcomes/presentation.js';
import type { SnapshotEntry } from '../plan.js';
import type { TransferRules } from '../rules.js';
import { TarArchive, type TarEntry } from '../tar.js';

/** Room for tar headers and padding on top of the file contents a limit counts. */
const archiveOverheadBytes = 64 * 1_024 * 1_024;
const archiveRoot = '/archive';

export interface ChangedEntry {
    type: 'file' | 'symlink';
    mode: number;
    content: Uint8Array;
    link?: string;
}

/**
 * Reads gzip tar archives a sandbox returned, in memory. It refuses unsafe
 * paths, links that leave the tree, anything but files and links, and more
 * content than the limit allows. `baseline` holds what was staged: an entry
 * whose parent is a file or link there is refused, as on disk, where the same
 * check reads the tree the archive is extracted into.
 */
export class MemoryArchive {
    /** The mode a symbolic link carries, since a link's own permissions mean nothing. */
    static readonly symlinkMode = 0o777;
    private readonly baselineParents = new Set<string>();

    constructor(
        private readonly rules: TransferRules,
        private readonly baseline: ReadonlyMap<
            string,
            Pick<SnapshotEntry, 'type'>
        > = new Map()
    ) {
        for (const path of baseline.keys()) {
            const segments = path.split('/');
            for (let depth = 1; depth < segments.length; depth++) {
                this.baselineParents.add(segments.slice(0, depth).join('/'));
            }
        }
    }

    async unpack(
        archive: Uint8Array,
        maximumBytes: number,
        reportedMaximumBytes: number
    ): Promise<{ changed: Map<string, ChangedEntry>; bytes: number }> {
        const rules = this.rules;
        const limitMessage = `${rules.provider} output exceeds the ${formatOutcomeBytes(reportedMaximumBytes)} transfer safety limit`;
        const tar = await TarArchive.gunzip(archive, {
            maximumBytes: Number.isFinite(maximumBytes)
                ? maximumBytes + archiveOverheadBytes
                : Number.POSITIVE_INFINITY,
            message: limitMessage,
        });
        const entries = tar.entries({ maximumBytes, limitMessage });
        const changed = new Map<string, ChangedEntry>();
        const kinds = new Map<string, TarEntry['type']>();
        const parents = new Set<string>();
        let bytes = 0;
        for (const entry of entries) {
            const normalizedName = rules.normalizeArchivePath(entry.name);
            const name =
                entry.type === 'directory'
                    ? normalizedName.replace(/\/$/, '')
                    : normalizedName;
            if (entry.type === 'directory' && (name === '.' || name === '')) continue;
            rules.validateRelativePath(name);
            const segments = name.split('/');
            for (let depth = 1; depth < segments.length; depth++) {
                const ancestorPath = segments.slice(0, depth).join('/');
                const ancestor = kinds.get(ancestorPath);
                if (
                    this.baseline.has(ancestorPath) ||
                    (ancestor && ancestor !== 'directory')
                ) {
                    throw new Error(`Unsafe ${rules.provider} archive parent: ${name}`);
                }
                parents.add(ancestorPath);
            }
            // A file that comes after entries beneath its own path has no parent role,
            // and neither has one that stands where the baseline holds a directory.
            if (
                entry.type !== 'directory' &&
                (parents.has(name) || this.baselineParents.has(name))
            ) {
                throw new Error(`Unsafe ${rules.provider} archive parent: ${name}`);
            }
            // One path is one kind of entry. A later kind never replaces an earlier one.
            const earlier = kinds.get(name);
            if (earlier && earlier !== entry.type) {
                throw new Error(`Unsafe ${rules.provider} archive path: ${name}`);
            }
            kinds.set(name, entry.type);
            if (entry.type === 'directory') continue;
            if (entry.type === 'symlink') {
                if (!entry.link) {
                    throw new Error(
                        `${rules.provider} archive symlink is missing: ${name}`
                    );
                }
                // A virtual root stands in for the workspace, so a link that climbs
                // out of the returned tree is caught wherever the tree is mounted.
                rules.validateSymlink({
                    parent: dirname(posix.join(archiveRoot, name)),
                    link: entry.link,
                    displayPath: name,
                    root: archiveRoot,
                });
                changed.set(name, {
                    type: 'symlink',
                    mode: MemoryArchive.symlinkMode,
                    content: new Uint8Array(),
                    link: entry.link,
                });
            } else {
                bytes += entry.content.byteLength;
                changed.set(name, {
                    type: 'file',
                    mode: entry.mode,
                    content: entry.content,
                });
            }
        }
        return { changed, bytes };
    }
}
