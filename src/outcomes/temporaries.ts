import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunOutcome } from './contracts.js';
import { outcomeStorageDirectory } from './directories.js';
import { processIsAlive } from './lease.js';
import { outcomeArtifactPath } from './paths.js';
import { outcomeArtifactName } from './presentation.js';

/** Called under the shared storage lease; never reaps a live writer's files. */
export async function collectAbandonedOutcomeTemporaries(
    home: string,
    outcomes: RunOutcome[]
): Promise<number> {
    let bytes = 0;
    bytes += await reap(home, ['blobs'], (name) => name === '.usage.json', false);
    await outcomeStorageDirectory(home, ['blobs', 'sha256']);
    const prefixes = await entries(join(home, 'blobs', 'sha256'));
    for (const prefix of prefixes) {
        if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/.test(prefix.name)) continue;
        bytes += await reap(
            home,
            ['blobs', 'sha256', prefix.name],
            (name) => /^[a-f0-9]{62}$/.test(name),
            false
        );
    }
    bytes += await reap(
        home,
        ['outcomes'],
        (name) => /^wbo_[a-z0-9]{20,64}$/.test(name),
        true
    );
    for (const outcome of outcomes) {
        bytes += await reap(
            home,
            ['outcomes', outcome.id],
            (name) => name === 'application.json' || name === 'outcome.json',
            false
        );
        for (const artifact of outcome.artifacts) {
            const parts = outcomeArtifactPath(artifact).split('/');
            bytes += await reap(
                home,
                ['outcomes', outcome.id, 'files', ...parts.slice(0, -1)],
                (name) => name === parts.at(-1),
                false
            );
            const target = outcomeArtifactName(
                artifact.name,
                artifact.content.media_type
            );
            bytes += await reap(
                home,
                ['outcomes', outcome.id, 'artifacts', artifact.id],
                (name) => name === target,
                false
            );
        }
    }
    return bytes;
}

async function reap(
    home: string,
    segments: string[],
    acceptsTarget: (name: string) => boolean,
    directory: boolean
): Promise<number> {
    await outcomeStorageDirectory(home, segments);
    const root = join(home, ...segments);
    let bytes = 0;
    for (const entry of await entries(root)) {
        const match = entry.name.match(/^(.+)\.([1-9]\d{0,9})\.[a-f0-9]{12}\.tmp$/);
        if (
            !match ||
            !acceptsTarget(match[1] ?? '') ||
            processIsAlive(Number(match[2]))
        )
            continue;
        if (
            entry.isSymbolicLink() ||
            (directory ? !entry.isDirectory() : !entry.isFile())
        ) {
            throw new Error('Abandoned outcome temporary has an invalid storage type');
        }
        const path = join(root, entry.name);
        bytes += await storedBytes(path);
        await rm(path, { recursive: directory, force: true });
    }
    return bytes;
}

async function storedBytes(path: string): Promise<number> {
    const details = await lstat(path);
    if (details.isSymbolicLink())
        throw new Error('Outcome temporaries must not contain symlinks');
    if (details.isFile()) return details.size;
    if (!details.isDirectory())
        throw new Error('Outcome temporaries must contain regular files');
    let bytes = 0;
    for (const entry of await readdir(path))
        bytes += await storedBytes(join(path, entry));
    return bytes;
}

async function entries(path: string) {
    return readdir(path, { withFileTypes: true }).catch((error) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
            return [];
        throw error;
    });
}
