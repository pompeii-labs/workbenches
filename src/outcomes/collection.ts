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
 * implementation with quotas and leases. `MemoryOutcomeSink` keeps everything
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
    /** Owns admission, transfer, and retries. Each open returns the whole file anew. */
    putRemoteFile?(
        file: OutcomeRemoteFile,
        open: () => Promise<ReadableStream<Uint8Array>>
    ): Promise<OutcomeRemoteResult>;
}

export interface OutcomeRemoteFile {
    /** Relative to the outcome directory, with / separators. */
    path: string;
    size: number;
    /** Lowercase hexadecimal SHA-256. */
    sha256: string;
    mediaType: string;
}

export type OutcomeRemoteResult =
    | { kind: 'stored'; descriptor: OutcomeContentDescriptor }
    | { kind: 'skipped'; warning: OutcomeWarning };

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
    warnings?: OutcomeWarning[];
}
