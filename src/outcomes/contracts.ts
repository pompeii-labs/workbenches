export type OutcomeCompleteness = 'complete' | 'partial';

export type OutcomeDigest = `sha256:${string}`;

export interface OutcomeContentDescriptor {
    digest: OutcomeDigest;
    media_type: string;
    size_bytes: number;
}

export interface OutcomeFileFingerprint {
    kind: 'file';
    digest: OutcomeDigest;
    mode: number;
    size_bytes: number;
}

export interface OutcomeSymlinkFingerprint {
    kind: 'symlink';
    mode: number;
    target: string;
}

export type OutcomePathFingerprint = OutcomeFileFingerprint | OutcomeSymlinkFingerprint;

export interface OutcomeFileState {
    kind: 'file';
    content: OutcomeContentDescriptor;
    mode: number;
}

export interface OutcomeSymlinkState {
    kind: 'symlink';
    mode: number;
    target: string;
}

export type OutcomePathState = OutcomeFileState | OutcomeSymlinkState;

export interface OutcomeChangeEntry {
    path: string;
    operation: 'add' | 'modify' | 'delete';
    before?: OutcomePathFingerprint;
    after?: OutcomePathState;
}

export type OutcomeWorkspace = { kind: 'primary' } | { kind: 'named'; name: string };

export interface OutcomeChangesetStats {
    additions: number;
    modifications: number;
    deletions: number;
    binary_files: number;
}

export interface OutcomeChangeset {
    id: string;
    workspace: OutcomeWorkspace;
    base: {
        snapshot_digest: OutcomeDigest;
        git_revision?: string;
    };
    entries: OutcomeChangeEntry[];
    review?: OutcomeContentDescriptor;
    stats: OutcomeChangesetStats;
}

export interface OutcomeArtifact {
    id: string;
    name: string;
    /** Original outbox-relative path, independent of the display name. */
    path?: string;
    content: OutcomeContentDescriptor;
    description?: string;
}

export interface OutcomeLink {
    id: string;
    label: string;
    uri: string;
    kind?: 'pull_request' | 'preview' | 'external';
}

export interface OutcomeWarning {
    code: string;
    message: string;
}

export interface RunOutcome {
    version: 1;
    id: string;
    run_id: string;
    created_at: string;
    completeness: OutcomeCompleteness;
    /** Outbox-only snapshot from a completed interactive turn, not a final result. */
    turn_index?: number;
    summary?: string;
    changesets: OutcomeChangeset[];
    artifacts: OutcomeArtifact[];
    links: OutcomeLink[];
    warnings: OutcomeWarning[];
}

export type OutcomeApplicationState = 'pending' | 'present' | 'applied';

export interface OutcomeApplicationReceipt {
    version: 1;
    outcome_id: string;
    state: OutcomeApplicationState;
    updated_at: string;
    applied_at?: string;
}

export interface DeclaredOutcomeArtifact {
    path: string;
    name?: string;
    description?: string;
    media_type?: string;
}

export interface DeclaredOutcome {
    version: 1;
    summary?: string;
    artifacts?: DeclaredOutcomeArtifact[];
    links?: Array<Omit<OutcomeLink, 'id'>>;
}
