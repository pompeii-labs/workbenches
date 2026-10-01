import { dirname, join, relative } from 'node:path';

import type { OutcomeSink } from '../../../outcomes/collection.js';
import type {
    OutcomeChangeEntry,
    OutcomeChangeset,
    OutcomeDigest,
    OutcomePathFingerprint,
    OutcomePathState,
    OutcomeWorkspace,
} from '../../../outcomes/contracts.js';
import { inferMediaType } from '../../../outcomes/media.js';
import { formatOutcomeBytes } from '../../../outcomes/presentation.js';
import { WorkspaceSnapshotLimitError } from '../../../outcomes/snapshot/limit.js';
import { SnapshotProtection } from '../../../outcomes/snapshot/protection.js';
import { changesetId, snapshotDigestSource } from '../../../outcomes/snapshot/rules.js';
import { type DiffSide, renderDiff } from '../diff.js';
import { digestBytes, type SnapshotEntry, TransferPlan } from '../plan.js';
import { WorkspaceProtection } from '../protection.js';
import type { TransferRules } from '../rules.js';
import type { AssetSource } from '../source.js';
import type { AssetBinding, PackOptions, StagedAsset } from '../transfer.js';
import { type ChangedEntry, MemoryArchive } from './archive.js';
import { MemoryOutcomeCapture } from './capture.js';

const symlinkMode = MemoryArchive.symlinkMode;

interface MemorySnapshotFields {
    binding: AssetBinding;
    archive: Uint8Array;
    entries: Map<string, SnapshotEntry>;
    excludedPaths: string[];
    syncExcludedPaths: string[];
    bytes: number;
    sourceIsDirectory: boolean;
    gitRevision: string | undefined;
}

/**
 * A host path packed into a gzip tar held in memory. Files are read through an
 * `AssetSource`, so nothing touches a filesystem. It records what it sent, so
 * the changes a run makes can be computed against it without a second copy of
 * the workspace.
 */
export class MemoryAssetSnapshot implements StagedAsset {
    readonly binding: AssetBinding;
    readonly entries: Map<string, SnapshotEntry>;
    readonly excludedPaths: string[];
    readonly syncExcludedPaths: string[];
    readonly bytes: number;
    readonly sourceIsDirectory: boolean;
    readonly gitRevision: string | undefined;
    private readonly protection = new WorkspaceProtection();
    private readonly snapshotProtection = new SnapshotProtection();
    private archive: Uint8Array;

    private constructor(
        private readonly source: AssetSource,
        /** Which archive paths are safe, and the provider named in messages. */
        private readonly rules: TransferRules,
        fields: MemorySnapshotFields
    ) {
        this.binding = fields.binding;
        this.archive = fields.archive;
        this.entries = fields.entries;
        this.excludedPaths = fields.excludedPaths;
        this.syncExcludedPaths = fields.syncExcludedPaths;
        this.bytes = fields.bytes;
        this.sourceIsDirectory = fields.sourceIsDirectory;
        this.gitRevision = fields.gitRevision;
    }

    /**
     * Reads `binding` through `source` and packs it. `maximumBytes` is the most
     * file content the asset may hold, and must be a positive integer.
     */
    static async create(
        source: AssetSource,
        rules: TransferRules,
        binding: AssetBinding,
        maximumBytes: number,
        options: PackOptions = {}
    ): Promise<MemoryAssetSnapshot> {
        if (binding.kind === 'credentials') {
            throw new Error(
                `Runner credential storage cannot be staged through an in-memory ${rules.provider} transfer`
            );
        }
        if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
            throw new Error(
                `${rules.provider} transfer maximumBytes must be a positive integer`
            );
        }
        const plan = new TransferPlan(source, rules);
        const details = await source.lstat(binding.hostPath);
        if (!details) {
            throw new Error(`Runtime asset does not exist: ${binding.hostPath}`);
        }
        const isDirectory = details.kind === 'directory';
        const excludedPaths: string[] = [];
        const syncExcludedPaths = binding.excludedHostPaths.map((path) =>
            rules.normalizeArchivePath(relative(binding.hostPath, path))
        );
        excludedPaths.push(...syncExcludedPaths);
        const paths = isDirectory
            ? await plan.selectPaths(binding, excludedPaths, syncExcludedPaths)
            : ['.workbench-file'];
        const entries = isDirectory
            ? await plan.describeEntries(binding.hostPath, paths, binding.hostPath)
            : new Map([
                  [
                      '.workbench-file',
                      await plan.describeEntry(
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
                `${rules.provider} transfer exceeds the ${formatOutcomeBytes(maximumBytes)} safety limit: ${binding.hostPath} is ${formatOutcomeBytes(bytes)}`
            );
        }
        await plan.digestEntries(binding.hostPath, entries, isDirectory);
        const archive =
            options.upload === false
                ? new Uint8Array()
                : await plan.archiveBytes(binding.hostPath, entries, isDirectory);
        return new MemoryAssetSnapshot(source, rules, {
            binding,
            archive,
            entries,
            excludedPaths,
            syncExcludedPaths,
            bytes,
            sourceIsDirectory: isDirectory,
            gitRevision:
                binding.kind === 'workspace'
                    ? await source.git?.revision(binding.hostPath)
                    : undefined,
        });
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
    async prepareOutcome(options: {
        archive: Uint8Array;
        deletions: string[];
        workspace: OutcomeWorkspace;
        maximumBytes?: number;
        reportedMaximumBytes?: number;
    }): Promise<MemoryOutcomeCapture> {
        const { archive, deletions, workspace } = options;
        const maximumBytes = options.maximumBytes ?? 512 * 1_024 * 1_024;
        const reportedMaximumBytes = options.reportedMaximumBytes ?? maximumBytes;
        if (!this.sourceIsDirectory) {
            throw new Error(
                `${this.rules.provider} file assets cannot produce workspace outcomes`
            );
        }
        const removed = deletions.map((path) => this.rules.normalizeArchivePath(path));
        for (const path of removed) this.rules.validateRelativePath(path);
        // A path the run deleted may come back as a directory. Anything else the
        // baseline holds as a file or link cannot be the parent of a returned path.
        const gone = new Set(removed);
        const surviving = new Map(
            [...this.entries].filter(([path]) => !gone.has(path))
        );
        const { changed, bytes } = await new MemoryArchive(
            this.rules,
            surviving
        ).unpack(archive, maximumBytes, reportedMaximumBytes);
        for (const path of [...changed.keys()]) {
            if (this.protectedOutputPath(path)) changed.delete(path);
        }
        return new MemoryOutcomeCapture(bytes, this, {
            changed,
            deletions: removed,
            workspace,
            maximumBytes,
        });
    }

    private protectedOutputPath(path: string): boolean {
        return (
            this.protection.protectedWorkspacePath(path) ||
            this.rules.excludedByNestedAsset(path, this.syncExcludedPaths)
        );
    }

    /** Compares what a run returned with what was staged. */
    async changeset(
        store: OutcomeSink,
        options: {
            changed: Map<string, ChangedEntry>;
            deletions: string[];
            workspace: OutcomeWorkspace;
            maximumBytes: number;
        }
    ): Promise<OutcomeChangeset | undefined> {
        const { changed, deletions, workspace, maximumBytes } = options;
        const before = new Map<string, SnapshotEntry>();
        for (const [path, entry] of this.entries) {
            if (!this.snapshotProtection.isProtected(path)) {
                before.set(path, normalized(entry));
            }
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
            if (this.snapshotProtection.isProtected(path)) continue;
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
