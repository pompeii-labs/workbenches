import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { RuntimePrepareRequest } from '../runtimes/contracts.js';
import type {
    OutcomeApplicationState,
    OutcomeArtifact,
    OutcomeChangeset,
    OutcomeLink,
    OutcomeWarning,
} from './contracts.js';
import { type CollectedOutput, OutcomeOutput } from './output.js';
import type { OutcomeStore } from './store.js';
import { WorkspaceSnapshot, WorkspaceSnapshotLimitError } from './workspace.js';

export interface RuntimeOutcomeCollection {
    application_state: OutcomeApplicationState;
    summary?: string;
    changesets: OutcomeChangeset[];
    artifacts: OutcomeArtifact[];
    links: OutcomeLink[];
    warnings: OutcomeWarning[];
}

export interface HostOutcomeCaptureOptions {
    bestEffortWorkspaceChanges?: boolean;
    gitBaseline?: boolean;
}

export class HostOutcomeCapture {
    private collection: Promise<RuntimeOutcomeCollection> | undefined;

    private constructor(
        private readonly snapshots: WorkspaceSnapshot[],
        private readonly output: OutcomeOutput,
        private readonly warnings: OutcomeWarning[],
        private readonly bestEffortWorkspaceChanges: boolean
    ) {}

    static async create(
        request: RuntimePrepareRequest,
        options: HostOutcomeCaptureOptions = {}
    ): Promise<HostOutcomeCapture> {
        if (!request.outcome) {
            throw new Error('Host outcome capture requires an output directory');
        }
        const roots = writableWorkspaces(request);
        const snapshots: WorkspaceSnapshot[] = [];
        const warnings: OutcomeWarning[] = [];
        try {
            for (const candidate of roots) {
                if (
                    options.bestEffortWorkspaceChanges &&
                    !(await isGitWorkingTree(candidate.path))
                ) {
                    warnings.push({
                        code: 'workspace_changes_unavailable',
                        message: `${workspaceLabel(candidate.workspace)} changes were not captured because it is not a Git working tree. Returned files and links are still captured.`,
                    });
                    continue;
                }
                try {
                    snapshots.push(
                        await WorkspaceSnapshot.create(candidate.path, {
                            workspace: candidate.workspace,
                            ...(options.gitBaseline ? { baseline: 'git' } : {}),
                            excludedPaths: roots
                                .filter(
                                    (other) =>
                                        other.path !== candidate.path &&
                                        contains(candidate.path, other.path)
                                )
                                .map((other) => other.path),
                        })
                    );
                } catch (error) {
                    if (
                        !options.bestEffortWorkspaceChanges ||
                        !(error instanceof WorkspaceSnapshotLimitError)
                    ) {
                        throw error;
                    }
                    warnings.push({
                        code: 'workspace_changes_unavailable',
                        message: `${workspaceLabel(candidate.workspace)} changes were not captured because its ${formatBytes(error.actualBytes)} snapshot exceeds the ${formatBytes(error.maximumBytes)} safety limit. Returned files and links are still captured.`,
                    });
                }
            }
            return new HostOutcomeCapture(
                snapshots,
                OutcomeOutput.open(request.outcome.directory),
                warnings,
                options.bestEffortWorkspaceChanges ?? false
            );
        } catch (error) {
            await Promise.allSettled(snapshots.map((snapshot) => snapshot.cleanup()));
            throw error;
        }
    }

    async collect(store: OutcomeStore): Promise<RuntimeOutcomeCollection> {
        if (!this.collection) {
            this.collection = this.collectOnce(store).catch((error) => {
                this.collection = undefined;
                throw error;
            });
        }
        return this.collection;
    }

    /** Capture current repository edits without freezing final collection. */
    snapshot(store: OutcomeStore): Promise<RuntimeOutcomeCollection> {
        return this.collectOnce(store);
    }

    private async collectOnce(store: OutcomeStore): Promise<RuntimeOutcomeCollection> {
        const changesets: OutcomeChangeset[] = [];
        const warnings = [...this.warnings];
        for (const snapshot of this.snapshots) {
            try {
                const changeset = await snapshot.collect(store);
                if (changeset) changesets.push(changeset);
            } catch (error) {
                if (
                    !this.bestEffortWorkspaceChanges ||
                    !(error instanceof WorkspaceSnapshotLimitError)
                ) {
                    throw error;
                }
                warnings.push({
                    code: 'workspace_changes_unavailable',
                    message: `${workspaceLabel(snapshot.workspace)} changes were not captured because its ${formatBytes(error.actualBytes)} snapshot exceeds the ${formatBytes(error.maximumBytes)} safety limit. Returned files and links are still captured.`,
                });
            }
        }
        const output = await this.output.collect(store);
        return {
            application_state: 'present',
            ...(output.summary ? { summary: output.summary } : {}),
            changesets,
            artifacts: output.artifacts,
            links: output.links,
            warnings: [
                ...warnings,
                ...this.snapshots.flatMap((snapshot) => snapshot.warnings),
            ],
        };
    }

    collectOutput(store: OutcomeStore): Promise<CollectedOutput> {
        return this.output.collect(store);
    }

    async cleanup(): Promise<void> {
        const results = await Promise.allSettled([
            ...this.snapshots.map((snapshot) => snapshot.cleanup()),
            this.output.cleanup(),
        ]);
        const failure = results.find(
            (result): result is PromiseRejectedResult => result.status === 'rejected'
        );
        if (failure) throw failure.reason;
    }
}

async function isGitWorkingTree(path: string): Promise<boolean> {
    try {
        const child = Bun.spawn(['git', 'rev-parse', '--is-inside-work-tree'], {
            cwd: path,
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'ignore',
        });
        const output = (await new Response(child.stdout).text()).trim();
        return (await child.exited) === 0 && output === 'true';
    } catch {
        return false;
    }
}

function workspaceLabel(
    workspace: { kind: 'primary' } | { kind: 'named'; name: string }
): string {
    return workspace.kind === 'primary'
        ? 'Primary workspace'
        : `Workspace ${workspace.name}`;
}

function formatBytes(bytes: number): string {
    if (bytes < 1_024) return `${bytes} B`;
    const units = ['KiB', 'MiB', 'GiB'];
    let value = bytes;
    let unit = 'B';
    for (const next of units) {
        value /= 1_024;
        unit = next;
        if (value < 1_024) break;
    }
    return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
}

function writableWorkspaces(request: RuntimePrepareRequest): Array<{
    path: string;
    workspace: { kind: 'primary' } | { kind: 'named'; name: string };
}> {
    const primary = resolve(request.workspaceDirectory);
    const found = new Map<
        string,
        {
            path: string;
            workspace: { kind: 'primary' } | { kind: 'named'; name: string };
        }
    >();
    for (const asset of request.assets) {
        if (asset.access !== 'read-write') continue;
        const path = resolve(asset.path);
        if (asset.workspace) {
            found.set(path, {
                path,
                workspace: { kind: 'named', name: asset.workspace },
            });
        } else if (path === primary) {
            found.set(path, { path, workspace: { kind: 'primary' } });
        }
    }
    return [...found.values()];
}

function contains(parent: string, child: string): boolean {
    const suffix = relative(resolve(parent), resolve(child));
    return (
        suffix === '' ||
        (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix))
    );
}
