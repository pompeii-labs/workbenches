import type {
    CollectedOutput,
    OutcomeRemoteFile,
    OutcomeSink,
    RuntimeOutcomeCollection,
} from '../../../outcomes/collection.js';
import type { OutcomeChangeset, OutcomeWarning } from '../../../outcomes/contracts.js';
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
import { readBoundedBytes } from './bounded.js';
import type { MemoryAssetSnapshot } from './snapshot.js';

/** Collects a run's changes and returned files into byte arrays and a sink. */
export class MemoryOutcomeCollector implements OutcomeCollector {
    private readonly commands: CollectionCommands;

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
            output = await this.collectOutput(store);
        }
        return {
            application_state: 'pending',
            ...(output.summary ? { summary: output.summary } : {}),
            changesets,
            artifacts: output.artifacts,
            links: output.links,
            warnings: [
                ...this.commands.warnings([...excluded]),
                ...(output.warnings ?? []),
            ],
        };
    }

    async collectOutput(store: OutcomeSink): Promise<CollectedOutput> {
        const snapshot = this.options.snapshots.find(
            (candidate) => candidate.binding.kind === 'outcome'
        );
        if (!snapshot) return { artifacts: [], links: [] };
        const root = snapshot.binding.runtimePath;
        const result = await this.sandbox.run(this.commands.remoteFiles(root));
        this.commands.requireSuccess(
            result,
            `Failed to collect ${this.rules.provider} outcome artifacts`
        );
        const [tool, ...fields] = result.stdout.split('\0');
        const files = new Map<string, Omit<OutcomeRemoteFile, 'mediaType'>>();
        if (
            fields.pop() !== '' ||
            !['sha256sum', 'shasum', 'none'].includes(tool ?? '') ||
            fields.length % 4 !== 0
        )
            throw new Error('Malformed outcome file listing');
        for (let index = 0; index < fields.length; index += 4) {
            const type = fields[index];
            const path = fields[index + 1] ?? '';
            this.rules.validateRelativePath(path);
            if (type === 'l')
                throw new Error(`Outcome artifacts cannot be symlinks: ${path}`);
            const size = Number(fields[index + 2]);
            const sha256 = fields[index + 3] ?? '';
            if (
                type !== 'f' ||
                !Number.isSafeInteger(size) ||
                size < 0 ||
                !/^[a-f0-9]{64}$/.test(sha256) ||
                files.has(path)
            )
                throw new Error('Malformed outcome file listing');
            files.set(path, { path, size, sha256 });
        }
        if (tool === 'none')
            return {
                artifacts: [],
                links: [],
                warnings: [
                    {
                        code: 'outcome_tools_missing',
                        message:
                            'The sandbox has neither sha256sum nor shasum, so its returned files were not kept.',
                    },
                ],
            };
        const open = (path: string) => this.sandbox.download(`${root}/${path}`);
        const declared = files.get(outcomeDeclarationName);
        if (declared && declared.size > maximumDeclarationBytes)
            throw new Error('Outcome declaration exceeds the 1 MiB safety limit');
        const declaration = declared
            ? parseDeclarationSource(
                  new TextDecoder().decode(
                      await readBoundedBytes(
                          await open(outcomeDeclarationName),
                          maximumDeclarationBytes,
                          'Outcome declaration exceeds the 1 MiB safety limit'
                      )
                  )
              )
            : undefined;
        const warnings: OutcomeWarning[] = [];
        const output = await new DeclaredOutput({
            put: async (path, mediaType) => {
                const file = files.get(path);
                if (!file) throw new Error(`Outcome file is unavailable: ${path}`);
                if (!store.putRemoteFile)
                    return store.putBytes(
                        new Uint8Array(
                            await new Response(await open(path)).arrayBuffer()
                        ),
                        mediaType
                    );
                const result = await store.putRemoteFile({ ...file, mediaType }, () =>
                    open(path)
                );
                if (result.kind === 'stored') return result.descriptor;
                warnings.push(result.warning);
                return undefined;
            },
        }).assemble({
            declaration,
            paths: [...files.keys()]
                .filter((path) => path !== outcomeDeclarationName)
                .toSorted(compareOutboxPaths),
        });
        return { ...output, warnings };
    }

    private async download(remote: string, maximumBytes: number): Promise<Uint8Array> {
        const { maximumTransferBytes } = this.options;
        return readBoundedBytes(
            await this.sandbox.download(remote),
            maximumBytes,
            `${this.rules.provider} output exceeds the ${formatOutcomeBytes(maximumTransferBytes)} transfer safety limit`
        );
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
