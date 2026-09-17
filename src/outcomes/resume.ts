import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { RunStore } from '../runs/store.js';
import { verifyBlob } from './content.js';
import type { OutcomeArtifact } from './contracts.js';
import type { OutcomeOutput } from './output.js';
import { assertArtifactPaths, outcomeArtifactPath } from './paths.js';
import { OutcomeStore } from './store.js';

const maximumRestoredBytes = 512 * 1_024 * 1_024;

/** The session's retained file library, never another session or an edited preview. */
export async function restoreSessionArtifacts(
    home: string,
    sessionId: string,
    runId: string,
    output: OutcomeOutput
): Promise<number> {
    RunStore.validateId(sessionId);
    const runs = (await new RunStore(home).list())
        .filter(
            (run) =>
                run.id !== runId &&
                RunStore.isTerminal(run.status) &&
                (run.session_id === sessionId ||
                    (!run.session_id && run.id === sessionId))
        )
        .toSorted((a, b) => a.dispatched_at.localeCompare(b.dispatched_at));
    const store = new OutcomeStore(home);
    const artifacts = new Map<string, OutcomeArtifact>();
    // Each retained file belongs to the session library. Absence from a later
    // snapshot is not a tombstone; the latest published revision of a path wins.
    const outcomes = await store.list();
    for (const run of runs) {
        for (const outcome of outcomes
            .filter((outcome) => outcome.run_id === run.id)
            .toReversed()) {
            for (const artifact of outcome.artifacts) {
                const path = outcomeArtifactPath(artifact);
                artifacts.set(path.normalize('NFC').toLowerCase(), {
                    ...artifact,
                    path,
                });
            }
        }
    }
    const files = [...artifacts.values()];
    assertArtifactPaths(files);
    const bytes = files.reduce(
        (total, artifact) => total + artifact.content.size_bytes,
        0
    );
    if (bytes > maximumRestoredBytes)
        throw new Error('Session deliverables exceed the 512 MiB restore safety limit');
    // Verify all source content before creating any working copies.
    const sources = await Promise.all(
        files.map((artifact) => store.blob(artifact.content))
    );
    for (const [index, artifact] of files.entries()) {
        const target = join(output.directory, outcomeArtifactPath(artifact));
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await copyFile(sources[index] as string, target);
        await chmod(target, 0o600);
        await verifyBlob(target, artifact.content);
    }
    // Do not replay old declarations, links or summaries as newly produced work.
    // Files are collected automatically; the harness can supply fresh metadata.
    return files.length;
}
