import type {
    CollectedOutput,
    OutcomeSink,
    RuntimeOutcomeCollection,
} from '../../outcomes/collection.js';
import type { RuntimeCommandResult } from '../contracts.js';

/** A host path and where it appears in the sandbox. */
export interface AssetBinding {
    hostPath: string;
    runtimePath: string;
    access: 'read-only' | 'read-write';
    excludedHostPaths: string[];
    workspace?: string;
    kind:
        | 'workspace'
        | 'package'
        | 'asset'
        | 'credentials'
        | 'state'
        | 'outcome'
        | 'git';
}

/**
 * A host path packed for upload to a remote sandbox, with what was sent recorded
 * so the run's changes can be diffed against it later.
 */
export interface StagedAsset {
    readonly binding: AssetBinding;
    readonly sourceIsDirectory: boolean;
    readonly bytes: number;
    /** Paths left out because they are protected or nested inside another asset. */
    readonly excludedPaths: string[];
    /** The subset of `excludedPaths` that belongs to a nested asset. */
    readonly syncExcludedPaths: string[];
    /** The gzip tar to upload. */
    archiveBytes(): Promise<Uint8Array>;
    cleanup(): Promise<void>;
}

/** The sandbox operations that collecting outcomes needs. */
export interface TransferSandbox {
    run(command: string): Promise<RuntimeCommandResult>;
    fileSize(path: string): Promise<number>;
    download(path: string): Promise<ReadableStream<Uint8Array>>;
}

export interface PackOptions {
    /**
     * False when the archive will not be uploaded, as when reconnecting to a
     * sandbox that already holds the files. The transfer then only records
     * what was staged.
     */
    upload?: boolean;
}

export interface CollectorOptions {
    sandbox: TransferSandbox;
    snapshots: StagedAsset[];
    /** The Git baseline commit recorded at staging, by snapshot index. */
    baselines: Map<number, string>;
    maximumTransferBytes: number;
}

export interface NativeStateOptions {
    sandbox: Pick<TransferSandbox, 'run' | 'download'>;
    snapshots: StagedAsset[];
    maximumBytes: number;
    /** The snapshot indexes already captured. */
    completed: Set<number>;
    /** Called after each capture with the indexes completed so far. */
    checkpoint?: (completed: Set<number>) => Promise<void>;
}

export interface OutcomeCollector {
    /** Collects workspace changes and returned files. */
    collect(store: OutcomeSink): Promise<RuntimeOutcomeCollection>;
    /** Collects only the files and links the runner returned. */
    collectOutput(store: OutcomeSink): Promise<CollectedOutput>;
}

/**
 * How a remote runtime packs files going into a sandbox and unpacks what comes
 * back. A remote provider calls it and never touches storage itself. An
 * implementation is built over the `AssetSource` it reads and the
 * `TransferRules` that name its provider. `MemoryTransfer` keeps everything in
 * byte arrays and needs only the Compression Streams API. `DiskTransfer`
 * stages through temporary files and keeps runner-owned native state.
 */
export interface RemoteTransfer {
    /** Packs one binding into a gzip tar. */
    pack(
        binding: AssetBinding,
        maximumBytes: number,
        options?: PackOptions
    ): Promise<StagedAsset>;
    /** Builds the collector for a run's staged assets. */
    collector(options: CollectorOptions): OutcomeCollector;
    /**
     * Copies runner-owned native state, such as a session database, out of the
     * sandbox.
     */
    captureNativeState(options: NativeStateOptions): Promise<void>;
}
