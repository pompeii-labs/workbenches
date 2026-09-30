import { dirname, join, posix, relative } from 'node:path';

import type { OutcomeSink } from '../../outcomes/collection.js';
import type {
    OutcomeChangeEntry,
    OutcomeChangeset,
    OutcomeDigest,
    OutcomePathFingerprint,
    OutcomePathState,
    OutcomeWorkspace,
} from '../../outcomes/contracts.js';
import { inferMediaType } from '../../outcomes/media.js';
import {
    changesetId,
    protectedPath,
    snapshotDigestSource,
    WorkspaceSnapshotLimitError,
} from '../../outcomes/snapshot-rules.js';
import type { E2BAssetBinding } from '../e2b/paths.js';
import { type DiffSide, renderDiff } from './diff.js';
import {
    archiveBytes,
    describeEntries,
    describeEntry,
    digestBytes,
    digestEntries,
    type SnapshotEntry,
    selectPaths,
} from './plan.js';
import {
    excludedByNestedAsset,
    formatBytes,
    normalizeArchivePath,
    protectedWorkspacePath,
    validateRelativePath,
    validateSymlink,
} from './rules.js';
import type { AssetSource } from './source.js';
import { gunzip, readTar, type TarEntry } from './tar.js';
import type { StagedAsset } from './transfer.js';

/** Room for tar headers and padding on top of the file contents a limit counts. */
const archiveOverheadBytes = 64 * 1_024 * 1_024;
const symlinkMode = 0o777;
const archiveRoot = '/archive';

export interface MemorySnapshotOptions {
    source: AssetSource;
    label: string;
    /** False skips building the archive, for a snapshot that is only a record. */
    upload?: boolean;
}

interface ChangedEntry {
    type: 'file' | 'symlink';
    mode: number;
    content: Uint8Array;
    link?: string;
}

/**
 * A host path packed into a gzip tar held in memory. Files are read through an
 * `AssetSource`, so nothing touches a filesystem. It records what it sent, so
 * the changes a run makes can be computed against it without a second copy of
 * the workspace.
 */
export class MemoryAssetSnapshot implements StagedAsset {
    private archive: Uint8Array;

    private constructor(
        readonly binding: E2BAssetBinding,
        archive: Uint8Array,
        readonly entries: Map<string, SnapshotEntry>,
        readonly excludedPaths: string[],
        readonly syncExcludedPaths: string[],
        readonly bytes: number,
        readonly sourceIsDirectory: boolean,
        readonly gitRevision: string | undefined,
        readonly source: AssetSource,
        readonly label: string
    ) {
        this.archive = archive;
    }

    static async create(
        binding: E2BAssetBinding,
        maximumBytes: number,
        options: MemorySnapshotOptions
    ): Promise<MemoryAssetSnapshot> {
        const { source, label } = options;
        if (binding.kind === 'credentials') {
            throw new Error(
                `Runner credential storage cannot be staged through an in-memory ${label} transfer`
            );
        }
        const context = { source, label };
        const details = await source.lstat(binding.hostPath);
        if (!details) {
            throw new Error(`Runtime asset does not exist: ${binding.hostPath}`);
        }
        const isDirectory = details.kind === 'directory';
        const excludedPaths: string[] = [];
        const syncExcludedPaths = binding.excludedHostPaths.map((path) =>
            normalizeArchivePath(relative(binding.hostPath, path))
        );
        excludedPaths.push(...syncExcludedPaths);
        const paths = isDirectory
            ? await selectPaths(context, binding, excludedPaths, syncExcludedPaths)
            : ['.workbench-file'];
        const entries = isDirectory
            ? await describeEntries(context, binding.hostPath, paths, binding.hostPath)
            : new Map([
                  [
                      '.workbench-file',
                      await describeEntry(
                          context,
                          binding.hostPath,
                          '.workbench-file',
                          dirname(binding.hostPath)
                      ),
                  ],
              ]);
        const bytes = [...entries.values()].reduce(
            (total, entry) => total + entry.size,
            0
        );
        if (bytes > maximumBytes) {
            throw new Error(
                `${label} transfer exceeds the ${formatBytes(maximumBytes)} safety limit: ${binding.hostPath} is ${formatBytes(bytes)}`
            );
        }
        await digestEntries(context, binding.hostPath, entries, isDirectory);
        const archive =
            options.upload === false
                ? new Uint8Array()
                : await archiveBytes(context, binding.hostPath, entries, isDirectory);
        return new MemoryAssetSnapshot(
            binding,
            archive,
            entries,
            excludedPaths,
            syncExcludedPaths,
            bytes,
            isDirectory,
            binding.kind === 'workspace'
                ? await source.git?.revision(binding.hostPath)
                : undefined,
            source,
            label
        );
    }

    async archiveBytes(): Promise<Uint8Array> {
        return this.archive;
    }

    async cleanup(): Promise<void> {
        this.archive = new Uint8Array();
    }

    /**
     * Reads the archive of changed files a sandbox returned, and the paths it
     * deleted, and prepares the changeset against what was staged.
     */
    async prepareOutcome(
        archive: Uint8Array,
        deletions: string[],
        workspace: OutcomeWorkspace,
        maximumBytes = 512 * 1_024 * 1_024,
        reportedMaximumBytes = maximumBytes
    ): Promise<{
        bytes: number;
        collect(store: OutcomeSink): Promise<OutcomeChangeset | undefined>;
        cleanup(): Promise<void>;
    }> {
        if (!this.sourceIsDirectory) {
            throw new Error(
                `${this.label} file assets cannot produce workspace outcomes`
            );
        }
        const { changed, bytes } = await unpack(
            archive,
            maximumBytes,
            reportedMaximumBytes,
            this.label
        );
        for (const path of deletions) validateRelativePath(path, this.label);
        for (const path of [...changed.keys()]) {
            if (this.protectedOutputPath(path)) changed.delete(path);
        }
        return {
            bytes,
            collect: (store) =>
                this.changeset(store, changed, deletions, workspace, maximumBytes),
            cleanup: async () => {},
        };
    }

    private protectedOutputPath(path: string): boolean {
        return (
            protectedWorkspacePath(path) ||
            excludedByNestedAsset(path, this.syncExcludedPaths)
        );
    }

    private async changeset(
        store: OutcomeSink,
        changed: Map<string, ChangedEntry>,
        deletions: string[],
        workspace: OutcomeWorkspace,
        maximumBytes: number
    ): Promise<OutcomeChangeset | undefined> {
        const before = new Map<string, SnapshotEntry>();
        for (const [path, entry] of this.entries) {
            if (!protectedPath(path)) before.set(path, normalized(entry));
        }
        const after = new Map(before);
        for (const path of deletions) {
            if (this.protectedOutputPath(path)) continue;
            after.delete(path);
            for (const existing of [...after.keys()]) {
                if (existing.startsWith(`${path}/`)) after.delete(existing);
            }
        }
        const contents = new Map<string, Uint8Array>();
        for (const [path, entry] of changed) {
            if (protectedPath(path)) continue;
            contents.set(path, entry.content);
            after.set(path, {
                path,
                type: entry.type,
                mode: entry.type === 'symlink' ? symlinkMode : entry.mode & 0o777,
                size: entry.type === 'file' ? entry.content.byteLength : 0,
                ...(entry.type === 'file'
                    ? { digest: await digestBytes(entry.content) }
                    : { link: entry.link ?? '' }),
            });
        }
        const differing = [...new Set([...before.keys(), ...after.keys()])]
            .toSorted()
            .filter((path) => !sameEntry(before.get(path), after.get(path)));
        if (differing.length === 0) return undefined;
        const snapshotDigest = (await digestText(
            snapshotDigestSource(
                [...before.values()].map((entry) => ({
                    path: entry.path,
                    type: entry.type,
                    mode: entry.mode,
                    size: entry.size,
                    digest: entry.digest,
                    target: entry.link,
                }))
            )
        )) as OutcomeDigest;
        let materialized = 0;
        let binaryFiles = 0;
        const entries: OutcomeChangeEntry[] = [];
        const diffs: string[] = [];
        for (const path of differing) {
            const previous = before.get(path);
            const current = after.get(path);
            materialized += current?.size ?? 0;
            if (materialized > maximumBytes) {
                throw new WorkspaceSnapshotLimitError(
                    this.binding.hostPath,
                    maximumBytes,
                    materialized
                );
            }
            const previousSide = previous
                ? await this.baselineSide(previous)
                : undefined;
            const currentSide = current
                ? sideOf(current, contents.get(path) ?? new Uint8Array())
                : undefined;
            if (!previous && current) {
                entries.push({
                    path,
                    operation: 'add',
                    after: await this.state(store, current, contents.get(path)),
                });
            } else if (previous && !current) {
                entries.push({
                    path,
                    operation: 'delete',
                    before: fingerprint(previous),
                });
            } else if (previous && current) {
                entries.push({
                    path,
                    operation: 'modify',
                    before: fingerprint(previous),
                    after: await this.state(store, current, contents.get(path)),
                });
            }
            const probe = currentSide ?? previousSide;
            if (
                (current ?? previous)?.type === 'file' &&
                probe &&
                !probe.unavailable &&
                probe.content.subarray(0, 8_192).includes(0)
            ) {
                binaryFiles += 1;
            }
            const diff = renderDiff(path, previousSide, currentSide);
            if (diff) diffs.push(diff);
        }
        const review =
            diffs.length > 0
                ? await store.putBytes(diffs.join(''), 'text/x-diff')
                : undefined;
        return {
            id: changesetId(workspace),
            workspace,
            base: {
                snapshot_digest: snapshotDigest,
                ...(this.gitRevision ? { git_revision: this.gitRevision } : {}),
            },
            entries,
            ...(review ? { review } : {}),
            stats: {
                additions: entries.filter((entry) => entry.operation === 'add').length,
                modifications: entries.filter((entry) => entry.operation === 'modify')
                    .length,
                deletions: entries.filter((entry) => entry.operation === 'delete')
                    .length,
                binary_files: binaryFiles,
            },
        };
    }

    private async state(
        store: OutcomeSink,
        entry: SnapshotEntry,
        content: Uint8Array | undefined
    ): Promise<OutcomePathState> {
        if (entry.type === 'symlink') {
            return { kind: 'symlink', mode: entry.mode, target: entry.link ?? '' };
        }
        return {
            kind: 'file',
            mode: entry.mode,
            content: await store.putBytes(
                content ?? new Uint8Array(),
                inferMediaType(entry.path)
            ),
        };
    }

    /**
     * The staged content of a path, read back through the asset source for the
     * review diff. A file that changed on the host since staging cannot stand in
     * for what was sent, so its side is marked unavailable.
     */
    private async baselineSide(entry: SnapshotEntry): Promise<DiffSide> {
        if (entry.type === 'symlink') {
            return {
                mode: entry.mode,
                content: new TextEncoder().encode(entry.link ?? ''),
                symlink: true,
            };
        }
        try {
            const content = await this.source.read(
                join(this.binding.hostPath, entry.path)
            );
            if ((await digestBytes(content)) === entry.digest) {
                return { mode: entry.mode, content };
            }
        } catch {}
        return { mode: entry.mode, content: new Uint8Array(), unavailable: true };
    }
}

function normalized(entry: SnapshotEntry): SnapshotEntry {
    return entry.type === 'symlink' ? { ...entry, mode: symlinkMode } : entry;
}

function sideOf(entry: SnapshotEntry, content: Uint8Array): DiffSide {
    return entry.type === 'symlink'
        ? {
              mode: entry.mode,
              content: new TextEncoder().encode(entry.link ?? ''),
              symlink: true,
          }
        : { mode: entry.mode, content };
}

function fingerprint(entry: SnapshotEntry): OutcomePathFingerprint {
    if (entry.type === 'symlink') {
        return { kind: 'symlink', mode: entry.mode, target: entry.link ?? '' };
    }
    return {
        kind: 'file',
        digest: entry.digest as OutcomeDigest,
        mode: entry.mode,
        size_bytes: entry.size,
    };
}

function sameEntry(
    left: SnapshotEntry | undefined,
    right: SnapshotEntry | undefined
): boolean {
    return (
        left?.type === right?.type &&
        left?.mode === right?.mode &&
        left?.size === right?.size &&
        left?.digest === right?.digest &&
        left?.link === right?.link
    );
}

async function digestText(value: string): Promise<string> {
    return digestBytes(new TextEncoder().encode(value));
}

/**
 * Reads a gzip tar a sandbox returned. It refuses unsafe paths, links that
 * leave the tree, anything but files and links, and more content than the
 * limit allows.
 */
export async function unpack(
    archive: Uint8Array,
    maximumBytes: number,
    reportedMaximumBytes: number,
    label: string
): Promise<{ changed: Map<string, ChangedEntry>; bytes: number }> {
    const limitMessage = () =>
        `${label} output exceeds the ${formatBytes(reportedMaximumBytes)} transfer safety limit`;
    const raw = await gunzip(
        archive,
        Number.isFinite(maximumBytes)
            ? maximumBytes + archiveOverheadBytes
            : Number.POSITIVE_INFINITY,
        limitMessage
    );
    const entries = readTar(raw, { maximumBytes, limitMessage });
    const changed = new Map<string, ChangedEntry>();
    const kinds = new Map<string, TarEntry['type']>();
    let bytes = 0;
    for (const entry of entries) {
        const normalizedName = normalizeArchivePath(entry.name);
        const name =
            entry.type === 'directory'
                ? normalizedName.replace(/\/$/, '')
                : normalizedName;
        if (entry.type === 'directory' && (name === '.' || name === '')) continue;
        validateRelativePath(name, label);
        const segments = name.split('/');
        for (let depth = 1; depth < segments.length; depth++) {
            const ancestor = kinds.get(segments.slice(0, depth).join('/'));
            if (ancestor && ancestor !== 'directory') {
                throw new Error(`Unsafe ${label} archive parent: ${name}`);
            }
        }
        kinds.set(name, entry.type);
        if (entry.type === 'directory') continue;
        if (entry.type === 'symlink') {
            if (!entry.link) {
                throw new Error(`${label} archive symlink is missing: ${name}`);
            }
            // A virtual root stands in for the workspace, so a link that climbs
            // out of the returned tree is caught wherever the tree is mounted.
            validateSymlink(
                dirname(posix.join(archiveRoot, name)),
                entry.link,
                name,
                archiveRoot,
                label
            );
            changed.set(name, {
                type: 'symlink',
                mode: symlinkMode,
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
