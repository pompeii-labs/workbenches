import { basename } from 'node:path';

import type { OutcomeWorkspace } from './contracts.js';
import { formatOutcomeBytes } from './presentation.js';

export class WorkspaceSnapshotLimitError extends Error {
    readonly maximumBytes: number;
    readonly actualBytes: number;

    constructor(root: string, maximumBytes: number, actualBytes: number) {
        super(
            `Workspace snapshot exceeds the ${formatOutcomeBytes(maximumBytes)} safety limit: ${root} is ${formatOutcomeBytes(actualBytes)}`
        );
        this.name = 'WorkspaceSnapshotLimitError';
        this.maximumBytes = maximumBytes;
        this.actualBytes = actualBytes;
    }
}

/**
 * Rules the workspace snapshot shares with collection that has no filesystem.
 * They are pure, so the disk snapshot and the in-memory one agree on which
 * paths count, how a snapshot is identified, and what a changeset is named.
 */

/** A path that never appears in a workspace change, such as credentials or VCS data. */
export function protectedPath(path: string): boolean {
    const segments = path.split('/');
    if (
        segments.some((segment) =>
            ['.git', '.hg', '.svn', '.ssh', '.aws', '.gnupg', 'node_modules'].includes(
                segment
            )
        )
    ) {
        return true;
    }
    const name = basename(path).toLowerCase();
    if (
        name === '.env' ||
        (name.startsWith('.env.') && !['.env.example', '.env.sample'].includes(name))
    ) {
        return true;
    }
    if (
        ['.npmrc', '.netrc', '.pypirc', 'id_rsa', 'id_ed25519', 'credentials'].includes(
            name
        )
    ) {
        return true;
    }
    return ['.pem', '.key', '.p12', '.pfx', '.kubeconfig'].some((extension) =>
        name.endsWith(extension)
    );
}

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
