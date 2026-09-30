import type {
    OutcomeApplicationState,
    OutcomeArtifact,
    OutcomeChangeset,
    OutcomeContentDescriptor,
    OutcomeLink,
    OutcomeWarning,
} from './contracts.js';

/**
 * Where a runtime puts the content it collects: the bytes of changed files,
 * returned artifacts, and review diffs. Runtimes call this and nothing else, so
 * a host can back it with any storage. `OutcomeStore` is the disk
 * implementation with quotas and leases. `MemoryOutcomeStore` keeps everything
 * in process memory.
 */
export interface OutcomeSink {
    /** Stores bytes and describes them by digest, size, and media type. */
    putBytes(
        bytes: Uint8Array | string,
        mediaType: string
    ): Promise<OutcomeContentDescriptor>;
    /**
     * Stores a file that lives on the machine running the engine. Only a
     * disk-backed sink implements it. Runtimes that read local files fall back to
     * `putBytes` when it is absent.
     */
    putFile?(path: string, mediaType?: string): Promise<OutcomeContentDescriptor>;
}

export interface RuntimeOutcomeCollection {
    application_state: OutcomeApplicationState;
    summary?: string;
    changesets: OutcomeChangeset[];
    artifacts: OutcomeArtifact[];
    links: OutcomeLink[];
    warnings: OutcomeWarning[];
}

export interface CollectedOutput {
    summary?: string;
    artifacts: OutcomeArtifact[];
    links: OutcomeLink[];
}
