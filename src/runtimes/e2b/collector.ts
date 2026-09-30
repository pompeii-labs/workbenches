import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    type OutcomeChangeset,
    OutcomeOutput,
    type OutcomeSink,
    type RuntimeOutcomeCollection,
} from '../../outcomes/index.js';
import {
    exclusionWarnings,
    outputCollectionCommand,
    requireSuccess,
    workspaceCollectionCommand,
    workspaceCollectionPaths,
} from '../staging/collect.js';
import type { E2BSandbox } from './contracts.js';
import { formatBytes } from './infrastructure.js';
import { quote } from './shell.js';
import { type E2BAssetSnapshot, extractArchive } from './snapshot.js';
import { downloadE2BFile } from './streams.js';
import { workspaceTracking } from './tracking.js';

/** The sandbox operations outcome collection needs. */
export type CollectionSandbox = Pick<E2BSandbox, 'run' | 'fileSize' | 'download'>;

export class E2BOutcomeCollector {
    private readonly label: string;

    constructor(
        private readonly options: {
            sandbox: CollectionSandbox;
            /** Provider name used in messages. Defaults to `E2B`. */
            label?: string;
            snapshots: E2BAssetSnapshot[];
            baselines: Map<number, string>;
            maximumTransferBytes: number;
        }
    ) {
        this.label = options.label ?? 'E2B';
    }

    async collect(store: OutcomeSink): Promise<RuntimeOutcomeCollection> {
        const sandbox = this.options.sandbox;
        const directory = await mkdtemp(join(tmpdir(), 'workbench-e2b-collect-'));
        let transferred = 0;
        let materialized = 0;
        const captures: Array<Awaited<ReturnType<E2BAssetSnapshot['prepareOutcome']>>> =
            [];
        const changesets: OutcomeChangeset[] = [];
        let output: Awaited<ReturnType<OutcomeOutput['collect']>> = {
            artifacts: [],
            links: [],
        };
        const excluded = new Set<string>();
        try {
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
                        `${this.label} workspace baseline is unavailable: ${snapshot.binding.hostPath}`
                    );
                }
                const root = snapshot.binding.runtimePath;
                const paths = workspaceCollectionPaths(index);
                const remoteArchive = paths.archive;
                const remoteChanged = paths.changed;
                const remoteDeleted = paths.deleted;
                const tracking = workspaceTracking(this.options.snapshots, index);
                const command = workspaceCollectionCommand({
                    git: tracking.git,
                    root,
                    baseline,
                    paths,
                });
                requireSuccess(
                    await sandbox.run(command),
                    `Failed to collect ${this.label} workspace changes: ${snapshot.binding.hostPath}`
                );
                const reportedSizes = await Promise.all([
                    sandbox.fileSize(remoteArchive),
                    sandbox.fileSize(remoteDeleted),
                ]);
                if (
                    transferred + reportedSizes[0] + reportedSizes[1] >
                    this.options.maximumTransferBytes
                ) {
                    throw new Error(
                        `${this.label} output exceeds the ${formatBytes(this.options.maximumTransferBytes)} transfer safety limit`
                    );
                }
                const localArchive = join(directory, `output-${index}.tar.gz`);
                const localDeleted = join(directory, `deleted-${index}`);
                transferred += await downloadE2BFile(
                    sandbox,
                    remoteArchive,
                    localArchive,
                    this.options.maximumTransferBytes - transferred,
                    this.options.maximumTransferBytes,
                    this.label
                );
                const deletionBytes = await downloadE2BFile(
                    sandbox,
                    remoteDeleted,
                    localDeleted,
                    this.options.maximumTransferBytes - transferred,
                    this.options.maximumTransferBytes,
                    this.label
                );
                transferred += deletionBytes;
                materialized += deletionBytes;
                if (materialized > this.options.maximumTransferBytes) {
                    throw new Error(
                        `${this.label} output exceeds the ${formatBytes(this.options.maximumTransferBytes)} transfer safety limit`
                    );
                }
                const deletions = (await readFile(localDeleted))
                    .toString('utf8')
                    .split('\0')
                    .filter(Boolean);
                const capture = await snapshot.prepareOutcome(
                    localArchive,
                    deletions,
                    snapshot.binding.workspace
                        ? { kind: 'named', name: snapshot.binding.workspace }
                        : { kind: 'primary' },
                    this.options.maximumTransferBytes - materialized,
                    this.options.maximumTransferBytes
                );
                materialized += capture.bytes;
                captures.push(capture);
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
                        `rm -f ${quote(remoteArchive)} ${quote(remoteChanged)} ${quote(remoteDeleted)}`
                    )
                    .catch(() => {});
            }
            const outputSnapshot = this.options.snapshots.find(
                (snapshot) => snapshot.binding.kind === 'outcome'
            );
            if (outputSnapshot) {
                output = await this.collectOutput(store, transferred, materialized);
            }
            return {
                application_state: 'pending',
                ...(output.summary ? { summary: output.summary } : {}),
                changesets,
                artifacts: output.artifacts,
                links: output.links,
                warnings: exclusionWarnings([...excluded], this.label),
            };
        } finally {
            await Promise.allSettled(captures.map((capture) => capture.cleanup()));
            await rm(directory, { recursive: true, force: true });
        }
    }

    async collectOutput(store: OutcomeSink, transferred = 0, materialized = 0) {
        const snapshot = this.options.snapshots.find(
            (candidate) => candidate.binding.kind === 'outcome'
        );
        if (!snapshot) return { artifacts: [], links: [] };
        const sandbox = this.options.sandbox;
        const directory = await mkdtemp(join(tmpdir(), 'workbench-e2b-results-'));
        const root = snapshot.binding.runtimePath;
        const token = randomUUID();
        const remoteArchive = `/tmp/workbench-artifacts-${token}.tar.gz`;
        const remoteFiles = `/tmp/workbench-artifacts-files-${token}`;
        try {
            requireSuccess(
                await sandbox.run(
                    outputCollectionCommand({
                        root,
                        files: remoteFiles,
                        archive: remoteArchive,
                    })
                ),
                `Failed to collect ${this.label} outcome artifacts`
            );
            const maximum = this.options.maximumTransferBytes;
            if (transferred + (await sandbox.fileSize(remoteArchive)) > maximum) {
                throw new Error(
                    `${this.label} output exceeds the ${formatBytes(maximum)} transfer safety limit`
                );
            }
            const archive = join(directory, 'artifacts.tar.gz');
            await downloadE2BFile(
                sandbox,
                remoteArchive,
                archive,
                maximum - transferred,
                maximum,
                this.label
            );
            const artifacts = join(directory, 'artifacts');
            await mkdir(artifacts, { mode: 0o700 });
            await extractArchive(
                archive,
                artifacts,
                maximum - materialized,
                maximum,
                this.label
            );
            return await OutcomeOutput.open(artifacts).collect(store);
        } finally {
            await sandbox
                .run(`rm -f ${quote(remoteArchive)} ${quote(remoteFiles)}`)
                .catch(() => {});
            await rm(directory, { recursive: true, force: true });
        }
    }
}
