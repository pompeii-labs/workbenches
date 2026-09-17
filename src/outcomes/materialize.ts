import { randomBytes } from 'node:crypto';
import { chmod, copyFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { validExistingBlob, verifyBlob } from './content.js';
import type { RunOutcome } from './contracts.js';
import { outcomeStorageDirectory } from './directories.js';
import { assertArtifactPaths, outcomeArtifactPath } from './paths.js';
import type { OutcomeStorageQuota } from './quota.js';
import type { OutcomeStore } from './store.js';

/** Materialize the entire tree so entrypoints can resolve sibling assets. */
export async function materializeOutcomeArtifacts(
    home: string,
    outcome: RunOutcome,
    store: Pick<OutcomeStore, 'blob'>,
    quota: OutcomeStorageQuota
): Promise<Map<string, string>> {
    assertArtifactPaths(outcome.artifacts);
    const paths = new Map<string, string>();
    for (const artifact of outcome.artifacts) {
        const relativePath = outcomeArtifactPath(artifact);
        const segments = [
            'outcomes',
            outcome.id,
            'files',
            ...relativePath.split('/').slice(0, -1),
        ];
        await outcomeStorageDirectory(home, segments, true);
        const target = join(home, 'outcomes', outcome.id, 'files', relativePath);
        paths.set(artifact.id, target);
        if (await validExistingBlob(target, artifact.content)) continue;
        const source = await store.blob(artifact.content);
        const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
        let existing = false;
        await quota.write(
            async () => {
                existing = await validExistingBlob(target, artifact.content);
                return existing ? 0 : artifact.content.size_bytes;
            },
            async () => {
                if (existing) return;
                try {
                    await copyFile(source, temporary);
                    await chmod(temporary, 0o600);
                    await verifyBlob(temporary, artifact.content);
                    await rename(temporary, target);
                } finally {
                    await rm(temporary, { force: true });
                }
            }
        );
    }
    return paths;
}
