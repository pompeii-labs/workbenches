import { createWriteStream as writeStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

import tar from 'tar-stream';

import { nativeCredentialPaths } from '../../connections/index.js';
import type { OutcomeSink } from '../../outcomes/collection.js';
import type { OutcomeChangeset, OutcomeWorkspace } from '../../outcomes/contracts.js';
import { WorkspaceSnapshot } from '../../outcomes/workspace.js';
import { diskAssetSource } from '../staging/disk-source.js';
import {
    describeEntries,
    describeEntry,
    digestEntries,
    fillArchive,
    type SnapshotEntry,
    selectPaths,
    walk,
} from '../staging/plan.js';
import {
    excludedByNestedAsset,
    formatBytes,
    normalizeArchivePath,
    protectedWorkspacePath,
    validateRelativePath,
} from '../staging/rules.js';
import type { AssetSource } from '../staging/source.js';
import { extractArchive } from './archive.js';
import type { E2BAssetBinding } from './paths.js';
import { type E2BStateSource, E2BStateStore, selectedStateFiles } from './state.js';

export { extractArchive } from './archive.js';

export type E2BSnapshotEntry = SnapshotEntry;

export interface E2BSnapshotOutcome {
    readonly bytes: number;
    collect(store: OutcomeSink): Promise<OutcomeChangeset | undefined>;
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

export interface E2BSnapshotOptions {
    /** Where asset files are read from. Defaults to the local disk. */
    source?: AssetSource;
    /** Provider name used in error messages. Defaults to `E2B`. */
    label?: string;
}

/**
 * A host path copied into a transfer archive. Remote sandbox providers share it:
 * it reads files through an `AssetSource` and records what it sent so outcomes
 * can be diffed against it.
 */
export class E2BAssetSnapshot {
    private constructor(
        readonly binding: E2BAssetBinding,
        readonly archive: string,
        readonly entries: Map<string, E2BSnapshotEntry>,
        readonly excludedPaths: string[],
        readonly syncExcludedPaths: string[],
        readonly bytes: number,
        readonly sourceIsDirectory: boolean,
        readonly gitRevision: string | undefined,
        private readonly temporaryDirectory: string | undefined,
        readonly label: string,
        private readonly stateSource?: E2BStateSource
    ) {}

    static async create(
        binding: E2BAssetBinding,
        maximumBytes: number,
        persistentDirectory?: string,
        options: E2BSnapshotOptions = {}
    ): Promise<E2BAssetSnapshot> {
        const label = options.label ?? 'E2B';
        if (
            binding.kind === 'state' ||
            binding.kind === 'credentials' ||
            binding.kind === 'git'
        ) {
            // Engine-owned native state is always read from the local store.
            return new E2BStateStore(
                binding.hostPath,
                binding.kind === 'credentials' ? nativeCredentialPaths : undefined
            ).withSource((source) =>
                E2BAssetSnapshot.createFrom(binding, maximumBytes, {
                    source: diskAssetSource,
                    label,
                    stateSource: source,
                })
            );
        }
        return E2BAssetSnapshot.createFrom(binding, maximumBytes, {
            source: options.source ?? diskAssetSource,
            label,
            ...(persistentDirectory ? { persistentDirectory } : {}),
        });
    }

    private static async createFrom(
        binding: E2BAssetBinding,
        maximumBytes: number,
        options: {
            source: AssetSource;
            label: string;
            stateSource?: E2BStateSource;
            persistentDirectory?: string;
        }
    ): Promise<E2BAssetSnapshot> {
        const { source: assets, label, stateSource } = options;
        const context = { source: assets, label };
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
                normalizeArchivePath(relative(binding.hostPath, path))
            );
            excludedPaths.push(...syncExcludedPaths);
            const paths = isDirectory
                ? binding.kind === 'credentials'
                    ? await selectedStateFiles(sourcePath, nativeCredentialPaths)
                    : await selectPaths(
                          context,
                          { ...binding, hostPath: sourcePath },
                          excludedPaths,
                          syncExcludedPaths
                      )
                : ['.workbench-file'];
            const entries = isDirectory
                ? await describeEntries(context, sourcePath, paths, sourcePath)
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
            await digestEntries(context, sourcePath, entries, isDirectory);
            const pack = tar.pack();
            const writing = pipeline(
                pack,
                createGzip(),
                writeStream(archive, { mode: 0o600 })
            );
            // Fail the pipeline and the fill together so neither is left hanging.
            await Promise.all([
                writing,
                fillArchive(context, pack, sourcePath, entries, isDirectory).catch(
                    (error) => {
                        pack.destroy(error as Error);
                        throw error;
                    }
                ),
            ]);
            return new E2BAssetSnapshot(
                binding,
                archive,
                entries,
                excludedPaths,
                syncExcludedPaths,
                bytes,
                isDirectory,
                binding.kind === 'workspace'
                    ? await assets.git?.revision(binding.hostPath)
                    : undefined,
                temporaryDirectory,
                label,
                stateSource
            );
        } catch (error) {
            await rm(temporaryDirectory, { recursive: true, force: true });
            throw error;
        }
    }

    async persistState(archive: string, maximumBytes: number): Promise<number> {
        if (!this.stateSource) throw new Error('Snapshot is not managed native state');
        return new E2BStateStore(
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
        directory: string
    ): E2BAssetSnapshot {
        return new E2BAssetSnapshot(
            record.binding,
            record.archive ? join(directory, record.archive) : '',
            new Map(),
            record.excludedPaths,
            record.syncExcludedPaths,
            0,
            record.sourceIsDirectory,
            record.gitRevision,
            undefined,
            'E2B',
            record.stateVersion
                ? { directory: record.binding.hostPath, version: record.stateVersion }
                : undefined
        );
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
                `${this.label} file assets cannot produce workspace outcomes`
            );
        }
        const materialized = await mkdtemp(join(tmpdir(), 'workbench-e2b-outcome-'));
        let baseline: WorkspaceSnapshot | undefined;
        try {
            await extractArchive(
                this.archive,
                materialized,
                Number.POSITIVE_INFINITY,
                Number.POSITIVE_INFINITY,
                this.label
            );
            baseline = await WorkspaceSnapshot.create(materialized, {
                workspace,
                maximumBytes,
            });
            for (const path of deletions) {
                validateRelativePath(path, this.label);
                if (this.protectedOutputPath(path)) continue;
                await rm(join(materialized, path), { recursive: true, force: true });
            }
            const bytes = await extractArchive(
                archive,
                materialized,
                maximumBytes,
                reportedMaximumBytes,
                this.label
            );
            const local = { source: diskAssetSource, label: this.label };
            for (const path of await walk(local, materialized, '', false)) {
                if (this.protectedOutputPath(path))
                    await rm(join(materialized, path), { force: true });
            }
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

    private protectedOutputPath(path: string): boolean {
        return (
            protectedWorkspacePath(path) ||
            excludedByNestedAsset(path, this.syncExcludedPaths)
        );
    }
}
