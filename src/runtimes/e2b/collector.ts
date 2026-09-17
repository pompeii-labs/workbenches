import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    type OutcomeChangeset,
    OutcomeOutput,
    type OutcomeStore,
    type RuntimeOutcomeCollection,
} from '../../outcomes/index.js';
import type { E2BSandbox } from './contracts.js';
import { formatBytes } from './infrastructure.js';
import { quote } from './shell.js';
import { type E2BAssetSnapshot, extractArchive } from './snapshot.js';
import { downloadE2BFile } from './streams.js';

export class E2BOutcomeCollector {
    constructor(
        private readonly options: {
            sandbox: E2BSandbox;
            snapshots: E2BAssetSnapshot[];
            baselines: Map<number, string>;
            maximumTransferBytes: number;
        }
    ) {}

    async collect(store: OutcomeStore): Promise<RuntimeOutcomeCollection> {
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
        let excluded = 0;
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
                const remoteArchive = `/tmp/workbench-output-${index}.tar.gz`;
                const remoteChanged = `/tmp/workbench-changed-${index}`;
                const remoteDeleted = `/tmp/workbench-deleted-${index}`;
                const command = [
                    `git -C ${quote(root)} add -A`,
                    `git -C ${quote(root)} diff --cached --name-only --diff-filter=ACMRTUXB -z ${quote(baseline)} > ${quote(remoteChanged)}`,
                    `git -C ${quote(root)} diff --cached --name-only --diff-filter=D -z ${quote(baseline)} > ${quote(remoteDeleted)}`,
                    `tar -C ${quote(root)} --null --files-from=${quote(remoteChanged)} -czf ${quote(remoteArchive)}`,
                ].join(' && ');
                requireSuccess(
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
                        `E2B output exceeds the ${formatBytes(this.options.maximumTransferBytes)} transfer safety limit`
                    );
                }
                const localArchive = join(directory, `output-${index}.tar.gz`);
                const localDeleted = join(directory, `deleted-${index}`);
                transferred += await downloadE2BFile(
                    sandbox,
                    remoteArchive,
                    localArchive,
                    this.options.maximumTransferBytes - transferred,
                    this.options.maximumTransferBytes
                );
                const deletionBytes = await downloadE2BFile(
                    sandbox,
                    remoteDeleted,
                    localDeleted,
                    this.options.maximumTransferBytes - transferred,
                    this.options.maximumTransferBytes
                );
                transferred += deletionBytes;
                materialized += deletionBytes;
                if (materialized > this.options.maximumTransferBytes) {
                    throw new Error(
                        `E2B output exceeds the ${formatBytes(this.options.maximumTransferBytes)} transfer safety limit`
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
                excluded += snapshot.excludedPaths.length;
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
                warnings:
                    excluded > 0
                        ? [
                              {
                                  code: 'workspace_paths_excluded',
                                  message: `${excluded} protected or nested workspace path${excluded === 1 ? ' was' : 's were'} excluded from remote execution and its outcome.`,
                              },
                          ]
                        : [],
            };
        } finally {
            await Promise.allSettled(captures.map((capture) => capture.cleanup()));
            await rm(directory, { recursive: true, force: true });
        }
    }

    async collectOutput(store: OutcomeStore, transferred = 0, materialized = 0) {
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
                    [
                        `(cd ${quote(root)} && find . -mindepth 1 -print0) > ${quote(remoteFiles)}`,
                        `tar -C ${quote(root)} --no-recursion --null --files-from=${quote(remoteFiles)} -czf ${quote(remoteArchive)}`,
                    ].join(' && ')
                ),
                'Failed to collect E2B outcome artifacts'
            );
            const maximum = this.options.maximumTransferBytes;
            if (transferred + (await sandbox.fileSize(remoteArchive)) > maximum) {
                throw new Error(
                    `E2B output exceeds the ${formatBytes(maximum)} transfer safety limit`
                );
            }
            const archive = join(directory, 'artifacts.tar.gz');
            await downloadE2BFile(
                sandbox,
                remoteArchive,
                archive,
                maximum - transferred,
                maximum
            );
            const artifacts = join(directory, 'artifacts');
            await mkdir(artifacts, { mode: 0o700 });
            await extractArchive(archive, artifacts, maximum - materialized, maximum);
            return await OutcomeOutput.open(artifacts).collect(store);
        } finally {
            await sandbox
                .run(`rm -f ${quote(remoteArchive)} ${quote(remoteFiles)}`)
                .catch(() => {});
            await rm(directory, { recursive: true, force: true });
        }
    }
}

function requireSuccess(
    result: { code: number; stdout: string; stderr: string },
    message: string
): void {
    if (result.code === 0) return;
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(`${message}${detail ? `: ${detail}` : ''}`);
}
