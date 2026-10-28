import { readFile } from 'node:fs/promises';

import {
    type OutcomeContentDescriptor,
    OutcomeStore,
    type RunOutcome,
} from '../outcomes/index.js';
import { outcomeArtifactPath } from '../outcomes/paths.js';
import { TarArchive, type TarEntry } from '../runtimes/staging/tar.js';

const encoder = new TextEncoder();

/** The directory of the archive's own files, which a run's output never takes a place in. */
const ARCHIVE_DIRECTORY = '.workbench';

/**
 * Packs a run's outcome as the gzip tar the server stores, in the layout a
 * cloud run's outcome is stored in. Returned files sit at their own paths.
 * Everything else the outcome holds goes under `.workbench/`: `outcome.json`,
 * the files each changeset left behind, and its review diff. A repository
 * run's change against the commit it was cloned at is the changeset
 * `change_primary`, with its diff at
 * `.workbench/changes/change_primary/review.diff`.
 */
export class WorkerOutcomeArchive {
    readonly #store: OutcomeStore;

    constructor(home: string) {
        this.#store = new OutcomeStore(home);
    }

    async read(id: string): Promise<RunOutcome> {
        return this.#store.read(id);
    }

    async pack(outcome: RunOutcome): Promise<Uint8Array> {
        const entries: TarEntry[] = [];
        const seen = new Set<string>();
        const add = async (
            name: string,
            content: () => Promise<Uint8Array>,
            mode = 0o644
        ) => {
            const path = normalize(name);
            if (!path || seen.has(path)) return;
            seen.add(path);
            entries.push({ name: path, type: 'file', mode, content: await content() });
        };
        const blob = (descriptor: OutcomeContentDescriptor) => async () =>
            new Uint8Array(await readFile(await this.#store.blob(descriptor)));
        for (const artifact of outcome.artifacts) {
            const path = outcomeArtifactPath(artifact);
            if (normalize(path).split('/')[0] === ARCHIVE_DIRECTORY) continue;
            await add(path, blob(artifact.content));
        }
        for (const changeset of outcome.changesets) {
            for (const entry of changeset.entries) {
                if (entry.after?.kind === 'file')
                    await add(
                        `${ARCHIVE_DIRECTORY}/changes/${changeset.id}/${entry.path}`,
                        blob(entry.after.content),
                        entry.after.mode & 0o777
                    );
            }
            if (changeset.review)
                await add(
                    `${ARCHIVE_DIRECTORY}/changes/${changeset.id}/review.diff`,
                    blob(changeset.review)
                );
        }
        const manifest = encoder.encode(JSON.stringify(this.#manifest(outcome)));
        await add(`${ARCHIVE_DIRECTORY}/outcome.json`, async () => manifest);
        return await TarArchive.pack(entries).gzip();
    }

    /** What the outcome says about itself, as the server's archive records it. */
    #manifest(outcome: RunOutcome) {
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
                // The path the tar stores the artifact under, so a reader
                // finds its entry by name.
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

/** A path with its empty, `.`, and `..` segments dropped, as the tar stores it. */
function normalize(path: string): string {
    return path
        .split('/')
        .filter((part) => part !== '' && part !== '.' && part !== '..')
        .join('/');
}
