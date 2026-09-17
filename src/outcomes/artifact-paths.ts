import { extname, isAbsolute, posix } from 'node:path';

import type { OutcomeArtifact } from './contracts.js';
import { outcomeArtifactName } from './presentation.js';

export function safeArtifactPath(value: unknown): string {
    if (
        typeof value !== 'string' ||
        !value.trim() ||
        value.length > 4_096 ||
        isAbsolute(value) ||
        /^[a-zA-Z]:/.test(value) ||
        value.includes('\\') ||
        /\p{Cc}/u.test(value) ||
        value.split('/').some((part) => !part || part === '.' || part === '..') ||
        posix.normalize(value) !== value ||
        value === 'outcome.json'
    )
        throw new Error('Outcome artifact path must be a safe relative path');
    return value;
}

export function outcomeArtifactPath(artifact: OutcomeArtifact): string {
    if (artifact.path !== undefined) return safeArtifactPath(artifact.path);
    // Older snapshots used the path as their name unless a display name was set.
    try {
        if (!extname(artifact.name)) throw new Error('Legacy display name');
        return safeArtifactPath(artifact.name);
    } catch {
        return safeArtifactPath(
            outcomeArtifactName(artifact.name, artifact.content.media_type)
        );
    }
}

export function assertArtifactPaths(artifacts: OutcomeArtifact[]): void {
    const paths = new Set<string>();
    for (const artifact of artifacts) {
        const path = outcomeArtifactPath(artifact).normalize('NFC').toLowerCase();
        if (paths.has(path)) throw new Error('Outcome artifact paths must be unique');
        paths.add(path);
    }
    for (const path of paths) {
        const parts = path.split('/');
        for (let i = 1; i < parts.length; i++) {
            if (paths.has(parts.slice(0, i).join('/')))
                throw new Error('Outcome artifact file and directory paths conflict');
        }
    }
}
