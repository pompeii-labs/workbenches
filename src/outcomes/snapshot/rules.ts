import type { OutcomeWorkspace } from '../contracts.js';

/**
 * Rules the workspace snapshot shares with collection that has no filesystem.
 * They are pure, so the disk snapshot and the in-memory one agree on how a
 * snapshot is identified and what a changeset is named.
 */

export function changesetId(workspace: OutcomeWorkspace): string {
    if (workspace.kind === 'primary') return 'change_primary';
    const normalized = workspace.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    return `change_${normalized || 'workspace'}`;
}

export interface DigestedEntry {
    path: string;
    type: string;
    mode: number;
    size: number;
    digest?: string | undefined;
    target?: string | undefined;
}

/**
 * The text a snapshot digest is computed over: one record per entry, in path
 * order. The digest is the SHA-256 of this text.
 */
export function snapshotDigestSource(entries: Iterable<DigestedEntry>): string {
    let source = '';
    for (const entry of [...entries].toSorted((left, right) =>
        left.path.localeCompare(right.path)
    )) {
        source += `${entry.path}\0${entry.type}\0${entry.mode}\0${entry.digest ?? entry.target ?? ''}\0${entry.size}\0`;
    }
    return source;
}
