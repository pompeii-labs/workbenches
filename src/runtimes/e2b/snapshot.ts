import { createWriteStream as writeStream } from 'node:fs';
import { lstat, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

import tar from 'tar-stream';

import { nativeCredentialPaths } from '../../connections/index.js';
import type { OutcomeChangeset, OutcomeWorkspace } from '../../outcomes/contracts.js';
import { formatOutcomeBytes } from '../../outcomes/presentation.js';
import type { OutcomeStore } from '../../outcomes/store.js';
import { WorkspaceSnapshot } from '../../outcomes/workspace.js';
import { type SnapshotEntry, TransferPlan } from '../staging/plan.js';
import { WorkspaceProtection } from '../staging/protection.js';
import type { TransferRules } from '../staging/rules.js';
import type { AssetSource } from '../staging/source.js';
import { E2BArchive } from './archive.js';
import type { E2BAssetBinding } from './paths.js';
import { type E2BStateSource, E2BStateStore, selectedStateFiles } from './state.js';

export type E2BSnapshotEntry = SnapshotEntry;

export interface E2BSnapshotOutcome {
    readonly bytes: number;
    collect(store: OutcomeStore): Promise<OutcomeChangeset | undefined>;
    cleanup(): Promise<void>;
}

export interface E2BRecoverySnapshot {
    binding: E2BAssetBinding;
    archive?: string;
    excludedPaths: string[];
    syncExcludedPaths: string[];
    sourceIsDirectory: boolean;
    gitRevision?: string;
    stateVersion?: string;
}

export interface E2BSnapshotSources {
    /** Where workspace, package, and asset files are read from. */
    assets: AssetSource;
    /** Where staged engine-owned native state and credentials are read from. */
    local: AssetSource;
    /** Which archive paths are safe to send and to take back. */
    rules: TransferRules;
}

interface E2BSnapshotFields {
    rules: TransferRules;
    binding: E2BAssetBinding;
    archive: string;
    entries: Map<string, E2BSnapshotEntry>;
    excludedPaths: string[];
    syncExcludedPaths: string[];
    bytes: number;
    sourceIsDirectory: boolean;
    gitRevision: string | undefined;
    temporaryDirectory: string | undefined;
    stateSource: E2BStateSource | undefined;
}

/**
 * A host path copied into a transfer archive: it reads files through an
 * `AssetSource` and records what it sent so outcomes can be diffed against it.
 */
export class E2BAssetSnapshot {
    readonly binding: E2BAssetBinding;
    readonly archive: string;
    readonly entries: Map<string, E2BSnapshotEntry>;
    readonly excludedPaths: string[];
    readonly syncExcludedPaths: string[];
    readonly bytes: number;
    readonly sourceIsDirectory: boolean;
    readonly gitRevision: string | undefined;
    private readonly rules: TransferRules;
    private readonly archives: E2BArchive;
    private readonly protection = new WorkspaceProtection();
    private readonly temporaryDirectory: string | undefined;
    private readonly stateSource: E2BStateSource | undefined;

    private constructor(fields: E2BSnapshotFields) {
        this.rules = fields.rules;
        this.archives = new E2BArchive(fields.rules);
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
        binding: E2BAssetBinding,
        maximumBytes: number,
        persistentDirectory: string | undefined,
        sources: E2BSnapshotSources
    ): Promise<E2BAssetSnapshot> {
        if (
            binding.kind === 'state' ||
            binding.kind === 'credentials' ||
            binding.kind === 'git'
        ) {
            // Engine-owned native state is always read from the local store.
            return new E2BStateStore(
                new E2BArchive(sources.rules),
                binding.hostPath,
                binding.kind === 'credentials' ? nativeCredentialPaths : undefined
            ).withSource((source) =>
                E2BAssetSnapshot.createFrom(binding, maximumBytes, {
                    source: sources.local,
                    rules: sources.rules,
                    stateSource: source,
                })
            );
        }
        return E2BAssetSnapshot.createFrom(binding, maximumBytes, {
            source: sources.assets,
            rules: sources.rules,
            ...(persistentDirectory ? { persistentDirectory } : {}),
        });
    }

    private static async createFrom(
        binding: E2BAssetBinding,
        maximumBytes: number,
        options: {
            source: AssetSource;
            rules: TransferRules;
            stateSource?: E2BStateSource;
            persistentDirectory?: string;
        }
    ): Promise<E2BAssetSnapshot> {
        const { source: assets, rules, stateSource } = options;
        const plan = new TransferPlan(assets, rules);
        const temporaryDirectory = await mkdtemp(
            join(options.persistentDirectory ?? tmpdir(), 'workbench-e2b-')
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
                    ? await selectedStateFiles(sourcePath, nativeCredentialPaths)
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
            await plan.digestEntries(sourcePath, entries, isDirectory);
            const pack = tar.pack();
            const writing = pipeline(
                pack,
                createGzip(),
                writeStream(archive, { mode: 0o600 })
            );
            // Fail the pipeline and the fill together so neither is left hanging.
            await Promise.all([
                writing,
                plan
                    .fillArchive(pack, sourcePath, entries, isDirectory)
                    .catch((error) => {
                        pack.destroy(error as Error);
                        throw error;
                    }),
            ]);
            return new E2BAssetSnapshot({
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
        return new E2BStateStore(
            this.archives,
            this.binding.hostPath,
            this.binding.kind === 'credentials' ? nativeCredentialPaths : undefined
        ).install(archive, this.stateSource.version, maximumBytes);
    }

    recoverySnapshot(directory: string): E2BRecoverySnapshot {
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
        record: E2BRecoverySnapshot,
        directory: string,
        rules: TransferRules
    ): E2BAssetSnapshot {
        return new E2BAssetSnapshot({
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
    ): Promise<E2BSnapshotOutcome> {
        if (!this.sourceIsDirectory) {
            throw new Error(
                `${this.rules.provider} file assets cannot produce workspace outcomes`
            );
        }
        const materialized = await mkdtemp(join(tmpdir(), 'workbench-e2b-outcome-'));
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
