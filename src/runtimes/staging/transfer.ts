import type {
    CollectedOutput,
    OutcomeSink,
    RuntimeOutcomeCollection,
} from '../../outcomes/collection.js';
import type { E2BSandbox } from '../e2b/contracts.js';
import type { E2BAssetBinding } from '../e2b/paths.js';
import type { AssetSource } from './source.js';

/**
 * A host path packed for upload to a remote sandbox, with what was sent recorded
 * so the run's changes can be diffed against it later.
 */
export interface StagedAsset {
    readonly binding: E2BAssetBinding;
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
export type TransferSandbox = Pick<E2BSandbox, 'run' | 'fileSize' | 'download'>;

export interface OutcomeCollector {
    /** Collects workspace changes and returned files. */
    collect(store: OutcomeSink): Promise<RuntimeOutcomeCollection>;
    /** Collects only the files and links the runner returned. */
    collectOutput(store: OutcomeSink): Promise<CollectedOutput>;
}

/**
 * How a remote runtime packs files going into a sandbox and unpacks what comes
 * back. A remote provider calls it and never touches storage itself.
 * `memoryTransfer` keeps everything in byte arrays and needs only `fetch` and
 * the Compression Streams API. The CLI passes a disk implementation that
 * stages through temporary files and keeps runner-owned native state.
 */
export interface RemoteTransfer {
    /** Packs one binding into a gzip tar, reading files through `source`. */
    pack(
        binding: E2BAssetBinding,
        maximumBytes: number,
        options: {
            source: AssetSource;
            label: string;
            /**
             * False when the archive will not be uploaded, as when reconnecting to a
             * sandbox that already holds the files. The transfer then only records
             * what was staged.
             */
            upload?: boolean;
        }
    ): Promise<StagedAsset>;
    /** Builds the collector for a run's staged assets. */
    collector(options: {
        sandbox: TransferSandbox;
        snapshots: StagedAsset[];
        /** The Git baseline commit recorded at staging, by snapshot index. */
        baselines: Map<number, string>;
        maximumTransferBytes: number;
        label: string;
    }): OutcomeCollector;
    /**
     * Copies runner-owned native state, such as a session database, out of the
     * sandbox. `completed` holds the snapshot indexes already captured.
     */
    captureNativeState(
        sandbox: Pick<E2BSandbox, 'run' | 'download'>,
        snapshots: StagedAsset[],
        maximumBytes: number,
        completed: Set<number>,
        label: string
    ): Promise<void>;
}
