import type {
    CollectedOutput,
    OutcomeSink,
    RuntimeOutcomeCollection,
} from '../../outcomes/collection.js';
import type { OutcomeChangeset } from '../../outcomes/contracts.js';
import {
    assembleOutput,
    maximumDeclarationBytes,
    outcomeDeclarationName,
    parseDeclarationSource,
} from '../../outcomes/declared.js';
import { quote } from '../e2b/shell.js';
import { workspaceTracking } from '../e2b/tracking.js';
import {
    exclusionWarnings,
    outputCollectionCommand,
    requireSuccess,
    workspaceCollectionCommand,
    workspaceCollectionPaths,
} from './collect.js';
import { type MemoryAssetSnapshot, unpack } from './memory-snapshot.js';
import { formatBytes } from './rules.js';
import type { OutcomeCollector, TransferSandbox } from './transfer.js';

async function downloadBytes(
    sandbox: Pick<TransferSandbox, 'download'>,
    remote: string,
    maximumBytes: number,
    reportedMaximumBytes: number,
    label: string
): Promise<Uint8Array> {
    const reader = (await sandbox.download(remote)).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > maximumBytes) {
            await reader.cancel().catch(() => {});
            throw new Error(
                `${label} output exceeds the ${formatBytes(reportedMaximumBytes)} transfer safety limit`
            );
        }
        chunks.push(next.value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

/** Collects a run's changes and returned files into byte arrays and a sink. */
export class MemoryOutcomeCollector implements OutcomeCollector {
    constructor(
        private readonly options: {
            sandbox: TransferSandbox;
            snapshots: MemoryAssetSnapshot[];
            baselines: Map<number, string>;
            maximumTransferBytes: number;
            label: string;
        }
    ) {}

    async collect(store: OutcomeSink): Promise<RuntimeOutcomeCollection> {
        const { sandbox, label } = this.options;
        const maximum = this.options.maximumTransferBytes;
        let transferred = 0;
        let materialized = 0;
        const changesets: OutcomeChangeset[] = [];
        let output: CollectedOutput = { artifacts: [], links: [] };
        const excluded = new Set<string>();
        for (const [index, snapshot] of this.options.snapshots.entries()) {
            if (
                snapshot.binding.kind !== 'workspace' ||
                snapshot.binding.access !== 'read-write' ||
                !snapshot.sourceIsDirectory
            ) {
                continue;
            }
            const baseline = this.options.baselines.get(index);
            if (!baseline) {
                throw new Error(
                    `${label} workspace baseline is unavailable: ${snapshot.binding.hostPath}`
                );
            }
            const paths = workspaceCollectionPaths(index);
            const tracking = workspaceTracking(this.options.snapshots, index);
            requireSuccess(
                await sandbox.run(
                    workspaceCollectionCommand({
                        git: tracking.git,
                        root: snapshot.binding.runtimePath,
                        baseline,
                        paths,
                    })
                ),
                `Failed to collect ${label} workspace changes: ${snapshot.binding.hostPath}`
            );
            const sizes = await Promise.all([
                sandbox.fileSize(paths.archive),
                sandbox.fileSize(paths.deleted),
            ]);
            if (transferred + sizes[0] + sizes[1] > maximum) {
                throw new Error(
                    `${label} output exceeds the ${formatBytes(maximum)} transfer safety limit`
                );
            }
            const archive = await downloadBytes(
                sandbox,
                paths.archive,
                maximum - transferred,
                maximum,
                label
            );
            transferred += archive.byteLength;
            const deleted = await downloadBytes(
                sandbox,
                paths.deleted,
                maximum - transferred,
                maximum,
                label
            );
            transferred += deleted.byteLength;
            materialized += deleted.byteLength;
            if (materialized > maximum) {
                throw new Error(
                    `${label} output exceeds the ${formatBytes(maximum)} transfer safety limit`
                );
            }
            const capture = await snapshot.prepareOutcome(
                archive,
                new TextDecoder().decode(deleted).split('\0').filter(Boolean),
                snapshot.binding.workspace
                    ? { kind: 'named', name: snapshot.binding.workspace }
                    : { kind: 'primary' },
                maximum - materialized,
                maximum
            );
            materialized += capture.bytes;
            const changeset = await capture.collect(store);
            if (changeset) changesets.push(changeset);
            for (const path of snapshot.excludedPaths) {
                if (snapshot.syncExcludedPaths.includes(path)) continue;
                excluded.add(
                    snapshot.binding.workspace
                        ? `${snapshot.binding.workspace}/${path}`
                        : path
                );
            }
            await sandbox
                .run(
                    `rm -f ${quote(paths.archive)} ${quote(paths.changed)} ${quote(paths.deleted)}`
                )
                .catch(() => {});
        }
        if (this.options.snapshots.some((entry) => entry.binding.kind === 'outcome')) {
            output = await this.collectOutput(store, transferred, materialized);
        }
        return {
            application_state: 'pending',
            ...(output.summary ? { summary: output.summary } : {}),
            changesets,
            artifacts: output.artifacts,
            links: output.links,
            warnings: exclusionWarnings([...excluded], label),
        };
    }

    async collectOutput(
        store: OutcomeSink,
        transferred = 0,
        materialized = 0
    ): Promise<CollectedOutput> {
        const snapshot = this.options.snapshots.find(
            (candidate) => candidate.binding.kind === 'outcome'
        );
        if (!snapshot) return { artifacts: [], links: [] };
        const { sandbox, label } = this.options;
        const maximum = this.options.maximumTransferBytes;
        const token = crypto.randomUUID();
        const remoteArchive = `/tmp/workbench-artifacts-${token}.tar.gz`;
        const remoteFiles = `/tmp/workbench-artifacts-files-${token}`;
        try {
            requireSuccess(
                await sandbox.run(
                    outputCollectionCommand({
                        root: snapshot.binding.runtimePath,
                        files: remoteFiles,
                        archive: remoteArchive,
                    })
                ),
                `Failed to collect ${label} outcome artifacts`
            );
            if (transferred + (await sandbox.fileSize(remoteArchive)) > maximum) {
                throw new Error(
                    `${label} output exceeds the ${formatBytes(maximum)} transfer safety limit`
                );
            }
            const archive = await downloadBytes(
                sandbox,
                remoteArchive,
                maximum - transferred,
                maximum,
                label
            );
            const { changed } = await unpack(
                archive,
                maximum - materialized,
                maximum,
                label
            );
            const files = new Map<string, Uint8Array>();
            for (const [path, entry] of changed) {
                if (entry.type === 'symlink') {
                    throw new Error(`Outcome artifacts cannot be symlinks: ${path}`);
                }
                files.set(path, entry.content);
            }
            const declared = files.get(outcomeDeclarationName);
            if (declared && declared.byteLength > maximumDeclarationBytes) {
                throw new Error('Outcome declaration exceeds the 1 MiB safety limit');
            }
            return await assembleOutput({
                declaration: declared
                    ? parseDeclarationSource(new TextDecoder().decode(declared))
                    : undefined,
                paths: [...files.keys()]
                    .filter((path) => path !== outcomeDeclarationName)
                    .toSorted(compareOutboxPaths),
                put: (path, mediaType) =>
                    store.putBytes(files.get(path) ?? new Uint8Array(), mediaType),
            });
        } finally {
            await sandbox
                .run(`rm -f ${quote(remoteArchive)} ${quote(remoteFiles)}`)
                .catch(() => {});
        }
    }
}

/** Orders paths as a directory walk that sorts each directory's entries by name. */
function compareOutboxPaths(left: string, right: string): number {
    const a = left.split('/');
    const b = right.split('/');
    for (let index = 0; index < Math.min(a.length, b.length); index++) {
        const difference = (a[index] ?? '').localeCompare(b[index] ?? '');
        if (difference !== 0) return difference;
    }
    return a.length - b.length;
}
