import type {
    CollectedOutput,
    OutcomeSink,
    RuntimeOutcomeCollection,
} from '../../../outcomes/collection.js';
import type { OutcomeChangeset } from '../../../outcomes/contracts.js';
import {
    DeclaredOutput,
    maximumDeclarationBytes,
    outcomeDeclarationName,
    parseDeclarationSource,
} from '../../../outcomes/declared.js';
import { formatOutcomeBytes } from '../../../outcomes/presentation.js';
import { CollectionCommands } from '../commands.js';
import type { TransferRules } from '../rules.js';
import { quote } from '../shell.js';
import { workspaceTracking } from '../tracking.js';
import type { OutcomeCollector, TransferSandbox } from '../transfer.js';
import { MemoryArchive } from './archive.js';
import type { MemoryAssetSnapshot } from './snapshot.js';

/** Collects a run's changes and returned files into byte arrays and a sink. */
export class MemoryOutcomeCollector implements OutcomeCollector {
    private readonly commands: CollectionCommands;
    private readonly archive: MemoryArchive;

    constructor(
        private readonly sandbox: TransferSandbox,
        private readonly rules: TransferRules,
        private readonly options: {
            snapshots: MemoryAssetSnapshot[];
            /** The Git baseline commit recorded at staging, by snapshot index. */
            baselines: Map<number, string>;
            maximumTransferBytes: number;
        }
    ) {
        this.commands = new CollectionCommands(rules);
        this.archive = new MemoryArchive(rules);
    }

    async collect(store: OutcomeSink): Promise<RuntimeOutcomeCollection> {
        const sandbox = this.sandbox;
        const provider = this.rules.provider;
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
                    `${provider} workspace baseline is unavailable: ${snapshot.binding.hostPath}`
                );
            }
            const paths = this.commands.workspacePaths(index);
            const tracking = workspaceTracking(this.options.snapshots, index);
            this.commands.requireSuccess(
                await sandbox.run(
                    this.commands.workspace({
                        git: tracking.git,
                        root: snapshot.binding.runtimePath,
                        baseline,
                        paths,
                    })
                ),
                `Failed to collect ${provider} workspace changes: ${snapshot.binding.hostPath}`
            );
            const sizes = await Promise.all([
                sandbox.fileSize(paths.archive),
                sandbox.fileSize(paths.deleted),
            ]);
            if (transferred + sizes[0] + sizes[1] > maximum) {
                throw new Error(
                    `${provider} output exceeds the ${formatOutcomeBytes(maximum)} transfer safety limit`
                );
            }
            const archive = await this.download(paths.archive, maximum - transferred);
            transferred += archive.byteLength;
            const deleted = await this.download(paths.deleted, maximum - transferred);
            transferred += deleted.byteLength;
            materialized += deleted.byteLength;
            if (materialized > maximum) {
                throw new Error(
                    `${provider} output exceeds the ${formatOutcomeBytes(maximum)} transfer safety limit`
                );
            }
            const capture = await snapshot.prepareOutcome({
                archive,
                deletions: new TextDecoder()
                    .decode(deleted)
                    .split('\0')
                    .filter(Boolean),
                workspace: snapshot.binding.workspace
                    ? { kind: 'named', name: snapshot.binding.workspace }
                    : { kind: 'primary' },
                maximumBytes: maximum - materialized,
                reportedMaximumBytes: maximum,
            });
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
            warnings: this.commands.warnings([...excluded]),
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
        const sandbox = this.sandbox;
        const provider = this.rules.provider;
        const maximum = this.options.maximumTransferBytes;
        const token = crypto.randomUUID();
        const remoteArchive = `/tmp/workbench-artifacts-${token}.tar.gz`;
        const remoteFiles = `/tmp/workbench-artifacts-files-${token}`;
        try {
            this.commands.requireSuccess(
                await sandbox.run(
                    this.commands.output({
                        root: snapshot.binding.runtimePath,
                        files: remoteFiles,
                        archive: remoteArchive,
                    })
                ),
                `Failed to collect ${provider} outcome artifacts`
            );
            if (transferred + (await sandbox.fileSize(remoteArchive)) > maximum) {
                throw new Error(
                    `${provider} output exceeds the ${formatOutcomeBytes(maximum)} transfer safety limit`
                );
            }
            const archive = await this.download(remoteArchive, maximum - transferred);
            const { changed } = await this.archive.unpack(
                archive,
                maximum - materialized,
                maximum
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
            return await new DeclaredOutput({
                put: (path, mediaType) =>
                    store.putBytes(files.get(path) ?? new Uint8Array(), mediaType),
            }).assemble({
                declaration: declared
                    ? parseDeclarationSource(new TextDecoder().decode(declared))
                    : undefined,
                paths: [...files.keys()]
                    .filter((path) => path !== outcomeDeclarationName)
                    .toSorted(compareOutboxPaths),
            });
        } finally {
            await sandbox
                .run(`rm -f ${quote(remoteArchive)} ${quote(remoteFiles)}`)
                .catch(() => {});
        }
    }

    private async download(remote: string, maximumBytes: number): Promise<Uint8Array> {
        const { maximumTransferBytes } = this.options;
        const sandbox = this.sandbox;
        const provider = this.rules.provider;
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
                    `${provider} output exceeds the ${formatOutcomeBytes(maximumTransferBytes)} transfer safety limit`
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
