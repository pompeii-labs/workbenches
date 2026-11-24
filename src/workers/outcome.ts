import {
    type OutcomeContentDescriptor,
    OutcomeStore,
    type RunOutcome,
} from '../outcomes/index.js';
import { outcomeArtifactPath } from '../outcomes/paths.js';

export interface WorkerOutcomeFile {
    path: string;
    source(): Promise<string>;
    content: OutcomeContentDescriptor;
}

export interface WorkerOutcomeData {
    files: WorkerOutcomeFile[];
    manifest: ReturnType<WorkerOutcomeLayout['manifest']>;
}

/** Reserved engine metadata directory, never occupied by returned files. */
const METADATA_DIRECTORY = '.workbench';

/**
 * Returned files sit at their own paths. Each changeset's review diff sits
 * under `.workbench/changes/`; after-file copies are not uploaded. The manifest
 * is sent separately after the files. A repository
 * run's change against the commit it was cloned at is the changeset
 * `change_primary`, with its diff at
 * `.workbench/changes/change_primary/review.diff`.
 */
export class WorkerOutcomeLayout {
    readonly #store: OutcomeStore;

    constructor(home: string) {
        this.#store = new OutcomeStore(home);
    }

    async read(id: string): Promise<RunOutcome> {
        return this.#store.read(id);
    }

    async files(outcome: RunOutcome): Promise<WorkerOutcomeData> {
        const files: WorkerOutcomeFile[] = [];
        const seen = new Set<string>();
        const add = (name: string, descriptor: OutcomeContentDescriptor) => {
            const path = normalize(name);
            if (!path || seen.has(path)) return;
            seen.add(path);
            files.push({
                path,
                source: () => this.#store.blob(descriptor),
                content: descriptor,
            });
        };
        for (const artifact of outcome.artifacts) {
            const path = outcomeArtifactPath(artifact);
            if (normalize(path).split('/')[0] === METADATA_DIRECTORY) continue;
            add(path, artifact.content);
        }
        for (const changeset of outcome.changesets) {
            if (changeset.review)
                add(
                    `${METADATA_DIRECTORY}/changes/${changeset.id}/review.diff`,
                    changeset.review
                );
        }
        return {
            files,
            manifest: this.manifest(outcome),
        };
    }

    /** The metadata sent after every file has been considered. */
    manifest(outcome: RunOutcome) {
        return {
            summary: outcome.summary ?? null,
            changesets: outcome.changesets.map((changeset) => ({
                id: changeset.id,
                workspace: changeset.workspace,
                stats: changeset.stats,
                entries: changeset.entries.map((entry) => ({
                    path: entry.path,
                    operation: entry.operation,
                })),
            })),
            artifacts: outcome.artifacts.map((artifact) => ({
                name: artifact.name,
                path: normalize(outcomeArtifactPath(artifact)),
                description: artifact.description ?? null,
                media_type: artifact.content.media_type,
                size_bytes: artifact.content.size_bytes,
            })),
            links: outcome.links,
            warnings: outcome.warnings,
        };
    }

    /** The number of the first pull request the outcome links to. */
    static pullRequest(outcome: RunOutcome): number | undefined {
        for (const link of outcome.links) {
            const match = /\/pull\/(\d+)(?:\/|$)/.exec(link.uri);
            if (link.kind === 'pull_request' && match?.[1]) return Number(match[1]);
        }
        return undefined;
    }
}

function normalize(path: string): string {
    return path
        .split('/')
        .filter((part) => part !== '' && part !== '.' && part !== '..')
        .join('/');
}
