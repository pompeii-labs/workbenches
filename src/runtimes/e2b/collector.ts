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
import { formatOutcomeBytes } from '../../outcomes/presentation.js';
import { CollectionCommands } from '../staging/commands.js';
import type { TransferRules } from '../staging/rules.js';
import { quote } from '../staging/shell.js';
import { workspaceTracking } from '../staging/tracking.js';
import type { OutcomeCollector, TransferSandbox } from '../staging/transfer.js';
import { E2BArchive } from './archive.js';
import type { E2BAssetSnapshot } from './snapshot.js';
import { E2BTransfer } from './transfer.js';

export class E2BOutcomeCollector implements OutcomeCollector {
    private readonly transfer: E2BTransfer;
    private readonly archive: E2BArchive;
    private readonly commands: CollectionCommands;

    constructor(
        private readonly options: {
            sandbox: TransferSandbox;
            snapshots: E2BAssetSnapshot[];
            baselines: Map<number, string>;
            maximumTransferBytes: number;
            rules: TransferRules;
        }
    ) {
        this.transfer = new E2BTransfer(options.sandbox);
        this.archive = new E2BArchive(options.rules);
        this.commands = new CollectionCommands(options.rules);
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
                        `E2B workspace baseline is unavailable: ${snapshot.binding.hostPath}`
                    );
                }
                const root = snapshot.binding.runtimePath;
                const paths = this.commands.workspacePaths(index);
                const remoteArchive = paths.archive;
                const remoteChanged = paths.changed;
                const remoteDeleted = paths.deleted;
                const tracking = workspaceTracking(this.options.snapshots, index);
                const command = this.commands.workspace({
                    git: tracking.git,
                    root,
                    baseline,
                    paths,
                });
                this.commands.requireSuccess(
                    await sandbox.run(command),
                    `Failed to collect E2B workspace changes: ${snapshot.binding.hostPath}`
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
                        `E2B output exceeds the ${formatOutcomeBytes(this.options.maximumTransferBytes)} transfer safety limit`
                    );
                }
                const localArchive = join(directory, `output-${index}.tar.gz`);
                const localDeleted = join(directory, `deleted-${index}`);
                transferred += await this.transfer.download(
                    remoteArchive,
                    localArchive,
                    {
                        maximumBytes: this.options.maximumTransferBytes - transferred,
                        reportedMaximumBytes: this.options.maximumTransferBytes,
                    }
                );
                const deletionBytes = await this.transfer.download(
                    remoteDeleted,
                    localDeleted,
                    {
                        maximumBytes: this.options.maximumTransferBytes - transferred,
                        reportedMaximumBytes: this.options.maximumTransferBytes,
                    }
                );
                transferred += deletionBytes;
                materialized += deletionBytes;
                if (materialized > this.options.maximumTransferBytes) {
                    throw new Error(
                        `E2B output exceeds the ${formatOutcomeBytes(this.options.maximumTransferBytes)} transfer safety limit`
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
                warnings: this.commands.warnings([...excluded]),
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
            this.commands.requireSuccess(
                await sandbox.run(
                    this.commands.output({
                        root,
                        files: remoteFiles,
                        archive: remoteArchive,
                    })
                ),
                'Failed to collect E2B outcome artifacts'
            );
            const maximum = this.options.maximumTransferBytes;
            if (transferred + (await sandbox.fileSize(remoteArchive)) > maximum) {
                throw new Error(
                    `E2B output exceeds the ${formatOutcomeBytes(maximum)} transfer safety limit`
                );
            }
            const archive = join(directory, 'artifacts.tar.gz');
            await this.transfer.download(remoteArchive, archive, {
                maximumBytes: maximum - transferred,
                reportedMaximumBytes: maximum,
            });
            const artifacts = join(directory, 'artifacts');
            await mkdir(artifacts, { mode: 0o700 });
            await this.archive.extract(archive, artifacts, {
                maximumBytes: maximum - materialized,
                reportedMaximumBytes: maximum,
            });
            return await OutcomeOutput.open(artifacts).collect(store);
        } finally {
            await sandbox
                .run(`rm -f ${quote(remoteArchive)} ${quote(remoteFiles)}`)
                .catch(() => {});
            await rm(directory, { recursive: true, force: true });
        }
    }
}
