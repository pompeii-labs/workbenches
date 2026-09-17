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
import { WorkspaceSnapshot } from './workspace.js';

export interface RuntimeOutcomeCollection {
    application_state: OutcomeApplicationState;
    summary?: string;
    changesets: OutcomeChangeset[];
    artifacts: OutcomeArtifact[];
    links: OutcomeLink[];
    warnings: OutcomeWarning[];
}

export class HostOutcomeCapture {
    private collection: Promise<RuntimeOutcomeCollection> | undefined;

    private constructor(
        private readonly snapshots: WorkspaceSnapshot[],
        private readonly output: OutcomeOutput
    ) {}

    static async create(request: RuntimePrepareRequest): Promise<HostOutcomeCapture> {
        if (!request.outcome) {
            throw new Error('Host outcome capture requires an output directory');
        }
        const roots = writableWorkspaces(request);
        const snapshots: WorkspaceSnapshot[] = [];
        try {
            for (const candidate of roots) {
                snapshots.push(
                    await WorkspaceSnapshot.create(candidate.path, {
                        workspace: candidate.workspace,
                        excludedPaths: roots
                            .filter(
                                (other) =>
                                    other.path !== candidate.path &&
                                    contains(candidate.path, other.path)
                            )
                            .map((other) => other.path),
                    })
                );
            }
            return new HostOutcomeCapture(
                snapshots,
                OutcomeOutput.open(request.outcome.directory)
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

    private async collectOnce(store: OutcomeStore): Promise<RuntimeOutcomeCollection> {
        const changesets = (
            await Promise.all(this.snapshots.map((snapshot) => snapshot.collect(store)))
        ).flatMap((changeset) => (changeset ? [changeset] : []));
        const output = await this.output.collect(store);
        return {
            application_state: 'present',
            ...(output.summary ? { summary: output.summary } : {}),
            changesets,
            artifacts: output.artifacts,
            links: output.links,
            warnings: [],
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
