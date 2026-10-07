import { createWriteStream as writeStream } from 'node:fs';
import { lstat, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

import tar from 'tar-stream';

import { nativeCredentialPaths } from '../../../connections/index.js';
import type { OutcomeSink } from '../../../outcomes/collection.js';
import type {
    OutcomeChangeset,
    OutcomeWorkspace,
} from '../../../outcomes/contracts.js';
import { formatOutcomeBytes } from '../../../outcomes/presentation.js';
import { WorkspaceSnapshot } from '../../../outcomes/workspace.js';
import { type SnapshotEntry, TransferPlan } from '../../staging/plan.js';
import { WorkspaceProtection } from '../../staging/protection.js';
import type { TransferRules } from '../../staging/rules.js';
import type { AssetSource } from '../../staging/source.js';
import type { AssetBinding, StagedAsset } from '../../staging/transfer.js';
import { ArchiveWriter } from '../../staging/writer.js';
import { SandboxArchive } from './archive.js';
import { StateSelection } from './selection.js';
import { type StateSource, StateStore } from './state.js';

export interface SnapshotOutcome {
    readonly bytes: number;
    collect(store: OutcomeSink): Promise<OutcomeChangeset | undefined>;
    cleanup(): Promise<void>;
}

export interface RecoverySnapshot {
    binding: AssetBinding;
    archive?: string;
    excludedPaths: string[];
    syncExcludedPaths: string[];
    sourceIsDirectory: boolean;
    gitRevision?: string;
    stateVersion?: string;
}

export interface SnapshotSources {
    /** Where workspace, package, and asset files are read from. */
    assets: AssetSource;
    /** Where staged engine-owned native state and credentials are read from. */
    local: AssetSource;
    /** Which archive paths are safe to send and to take back. */
    rules: TransferRules;
}

interface SnapshotFields {
    rules: TransferRules;
    binding: AssetBinding;
    archive: string;
    entries: Map<string, SnapshotEntry>;
    excludedPaths: string[];
    syncExcludedPaths: string[];
    bytes: number;
    sourceIsDirectory: boolean;
    gitRevision: string | undefined;
    temporaryDirectory: string | undefined;
    stateSource: StateSource | undefined;
}

/**
 * A host path copied into a transfer archive: it reads files through an
 * `AssetSource` and records what it sent so outcomes can be diffed against it.
 */
export class DiskAssetSnapshot implements StagedAsset {
    readonly binding: AssetBinding;
    readonly archive: string;
    readonly entries: Map<string, SnapshotEntry>;
    readonly excludedPaths: string[];
    readonly syncExcludedPaths: string[];
    readonly bytes: number;
    readonly sourceIsDirectory: boolean;
    readonly gitRevision: string | undefined;
    private readonly rules: TransferRules;
    private readonly archives: SandboxArchive;
    private readonly protection = new WorkspaceProtection();
    private readonly temporaryDirectory: string | undefined;
    private readonly stateSource: StateSource | undefined;

    private constructor(fields: SnapshotFields) {
        this.rules = fields.rules;
        this.archives = new SandboxArchive(fields.rules);
        this.binding = fields.binding;
        this.archive = fields.archive;
        this.entries = fields.entries;
        this.excludedPaths = fields.excludedPaths;
        this.syncExcludedPaths = fields.syncExcludedPaths;
        this.bytes = fields.bytes;
        this.sourceIsDirectory = fields.sourceIsDirectory;
        this.gitRevision = fields.gitRevision;
        this.temporaryDirectory = fields.temporaryDirectory;
        this.stateSource = fields.stateSource;
    }

    static async create(
        binding: AssetBinding,
        maximumBytes: number,
        persistentDirectory: string | undefined,
        sources: SnapshotSources
    ): Promise<DiskAssetSnapshot> {
        if (
            binding.kind === 'state' ||
            binding.kind === 'credentials' ||
            binding.kind === 'git'
        ) {
            // Engine-owned native state is always read from the local store.
            return new StateStore(
                new SandboxArchive(sources.rules),
                binding.hostPath,
                binding.kind === 'credentials' ? nativeCredentialPaths : undefined,
                binding.stateOverlay
            ).withSource((source) =>
                DiskAssetSnapshot.createFrom(binding, maximumBytes, {
                    source: sources.local,
                    rules: sources.rules,
                    stateSource: source,
                })
            );
        }
        return DiskAssetSnapshot.createFrom(binding, maximumBytes, {
            source: sources.assets,
            rules: sources.rules,
            ...(persistentDirectory ? { persistentDirectory } : {}),
        });
    }

    private static async createFrom(
        binding: AssetBinding,
        maximumBytes: number,
        options: {
            source: AssetSource;
            rules: TransferRules;
            stateSource?: StateSource;
            persistentDirectory?: string;
        }
    ): Promise<DiskAssetSnapshot> {
        const { source: assets, rules, stateSource } = options;
        const plan = new TransferPlan(assets, rules);
        const temporaryDirectory = await mkdtemp(
            join(
                options.persistentDirectory ?? tmpdir(),
                `workbench-${rules.provider.toLowerCase()}-`
            )
        );
        const archive = join(temporaryDirectory, 'asset.tar.gz');
        const sourcePath = stateSource?.directory ?? binding.hostPath;
        try {
            const source = await assets.lstat(sourcePath);
            if (!source) throw new Error(`Runtime asset does not exist: ${sourcePath}`);
            const isDirectory = source.kind === 'directory';
            const excludedPaths: string[] = [];
            const syncExcludedPaths = binding.excludedHostPaths.map((path) =>
                rules.normalizeArchivePath(relative(binding.hostPath, path))
            );
            excludedPaths.push(...syncExcludedPaths);
            const paths = isDirectory
                ? binding.kind === 'credentials'
                    ? await new StateSelection(
                          sourcePath,
                          nativeCredentialPaths,
                          rules.provider
                      ).existing()
                    : await plan.selectPaths(
                          { ...binding, hostPath: sourcePath },
                          excludedPaths,
                          syncExcludedPaths
                      )
                : ['.workbench-file'];
            const entries = isDirectory
                ? await plan.describeEntries(sourcePath, paths, sourcePath)
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
            // A source that streams is digested while packing, one read per file.
            await plan.digestEntries(sourcePath, entries, isDirectory, true);
            const pack = tar.pack();
            const writing = pipeline(
                pack,
                createGzip(),
                writeStream(archive, { mode: 0o600 })
            );
            // Fail the pipeline and the fill together so neither is left hanging.
            await Promise.all([
                writing,
                new ArchiveWriter(rules)
                    .write(
                        pack,
                        plan.archiveRecords(sourcePath, entries, isDirectory, true)
                    )
                    .catch((error) => {
                        pack.destroy(error as Error);
                        throw error;
                    }),
            ]);
            return new DiskAssetSnapshot({
                rules,
                binding,
                archive,
                entries,
                excludedPaths,
                syncExcludedPaths,
                bytes,
                sourceIsDirectory: isDirectory,
                gitRevision:
                    binding.kind === 'workspace'
                        ? await assets.git?.revision(binding.hostPath)
                        : undefined,
                temporaryDirectory,
                stateSource,
            });
        } catch (error) {
            await rm(temporaryDirectory, { recursive: true, force: true });
            throw error;
        }
    }

    async persistState(archive: string, maximumBytes: number): Promise<number> {
        if (!this.stateSource) throw new Error('Snapshot is not managed native state');
        return new StateStore(
            this.archives,
            this.binding.hostPath,
            this.binding.kind === 'credentials' ? nativeCredentialPaths : undefined,
            this.binding.stateOverlay
        ).install(archive, this.stateSource.version, maximumBytes);
    }

    recoverySnapshot(directory: string): RecoverySnapshot {
        return {
            binding: this.binding,
            excludedPaths: this.excludedPaths,
            syncExcludedPaths: this.syncExcludedPaths,
            sourceIsDirectory: this.sourceIsDirectory,
            ...(this.binding.kind === 'workspace'
                ? { archive: relative(directory, this.archive) }
                : {}),
            ...(this.gitRevision ? { gitRevision: this.gitRevision } : {}),
            ...(this.stateSource ? { stateVersion: this.stateSource.version } : {}),
        };
    }

    static fromRecovery(
        record: RecoverySnapshot,
        directory: string,
        rules: TransferRules
    ): DiskAssetSnapshot {
        return new DiskAssetSnapshot({
            rules,
            binding: record.binding,
            archive: record.archive ? join(directory, record.archive) : '',
            entries: new Map(),
            excludedPaths: record.excludedPaths,
            syncExcludedPaths: record.syncExcludedPaths,
            bytes: 0,
            sourceIsDirectory: record.sourceIsDirectory,
            gitRevision: record.gitRevision,
            temporaryDirectory: undefined,
            stateSource: record.stateVersion
                ? { directory: record.binding.hostPath, version: record.stateVersion }
                : undefined,
        });
    }

    async prepareOutcome(
        archive: string,
        deletions: string[],
        workspace: OutcomeWorkspace,
        maximumBytes = 512 * 1_024 * 1_024,
        reportedMaximumBytes = maximumBytes
    ): Promise<SnapshotOutcome> {
        if (!this.sourceIsDirectory) {
            throw new Error(
                `${this.rules.provider} file assets cannot produce workspace outcomes`
            );
        }
        const materialized = await mkdtemp(
            join(tmpdir(), `workbench-${this.rules.provider.toLowerCase()}-outcome-`)
        );
        let baseline: WorkspaceSnapshot | undefined;
        try {
            await this.archives.extract(this.archive, materialized, {
                maximumBytes: Number.POSITIVE_INFINITY,
                reportedMaximumBytes: Number.POSITIVE_INFINITY,
            });
            baseline = await WorkspaceSnapshot.create(materialized, {
                workspace,
                maximumBytes,
            });
            for (const path of deletions) {
                this.rules.validateRelativePath(path);
                if (this.protectedOutputPath(path)) continue;
                await rm(join(materialized, path), { recursive: true, force: true });
            }
            const bytes = await this.archives.extract(archive, materialized, {
                maximumBytes,
                reportedMaximumBytes,
            });
            await this.removeProtectedOutputs(materialized);
            const captured = baseline;
            let cleaned = false;
            return {
                bytes,
                collect: async (store) => {
                    const changeset = await captured.collect(store);
                    if (!changeset || !this.gitRevision) return changeset;
                    return {
                        ...changeset,
                        base: {
                            ...changeset.base,
                            git_revision: this.gitRevision,
                        },
                    };
                },
                cleanup: async () => {
                    if (cleaned) return;
                    cleaned = true;
                    await Promise.allSettled([
                        captured.cleanup(),
                        rm(materialized, { recursive: true, force: true }),
                    ]);
                },
            };
        } catch (error) {
            await baseline?.cleanup().catch(() => undefined);
            await rm(materialized, { recursive: true, force: true });
            throw error;
        }
    }

    async archiveBytes(): Promise<Uint8Array> {
        return new Uint8Array(await readFile(this.archive));
    }

    cleanup(): Promise<void> {
        return this.temporaryDirectory
            ? rm(this.temporaryDirectory, { recursive: true, force: true })
            : Promise.resolve();
    }

    /** Removes every file or link below `root` that must not appear in an outcome. */
    private async removeProtectedOutputs(root: string, prefix = ''): Promise<void> {
        const directory = prefix ? join(root, prefix) : root;
        for (const entry of await readdir(directory)) {
            const path = this.rules.normalizeArchivePath(
                prefix ? `${prefix}/${entry}` : entry
            );
            const details = await lstat(join(root, path));
            if (details.isDirectory()) {
                await this.removeProtectedOutputs(root, path);
            } else if (
                (details.isFile() || details.isSymbolicLink()) &&
                this.protectedOutputPath(path)
            ) {
                await rm(join(root, path), { force: true });
            }
        }
    }

    private protectedOutputPath(path: string): boolean {
        return (
            this.protection.protectedWorkspacePath(path) ||
            this.rules.excludedByNestedAsset(path, this.syncExcludedPaths)
        );
    }
}
