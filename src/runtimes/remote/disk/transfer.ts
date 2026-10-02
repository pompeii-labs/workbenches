import type { TransferRules } from '../../staging/rules.js';
import type { AssetSource } from '../../staging/source.js';
import type {
    AssetBinding,
    CollectorOptions,
    NativeStateOptions,
    PackOptions,
    RemoteTransfer,
    StagedAsset,
} from '../../staging/transfer.js';
import { DiskOutcomeCollector } from './collector.js';
import { NativeStateCapture } from './native.js';
import { DiskAssetSnapshot } from './snapshot.js';

export interface DiskPackOptions extends PackOptions {
    /** A directory that outlives the run, to keep the archive in for recovery. */
    persistentDirectory?: string;
}

/**
 * Remote transfer through temporary files on the local disk. Archives are
 * written to a private temporary directory, collected changes are extracted and
 * compared on disk, and runner-owned native state is copied back into the
 * Workbench home. It needs Node compatible `fs`, `os`, `zlib`, and `stream`.
 * `assets` is where workspace and package files are read from, and `local` is
 * the source that holds engine-owned native state.
 */
export class DiskTransfer implements RemoteTransfer {
    constructor(
        private readonly assets: AssetSource,
        private readonly local: AssetSource,
        private readonly rules: TransferRules
    ) {}

    pack(
        binding: AssetBinding,
        maximumBytes: number,
        options: DiskPackOptions = {}
    ): Promise<DiskAssetSnapshot> {
        return DiskAssetSnapshot.create(
            binding,
            maximumBytes,
            options.persistentDirectory,
            { assets: this.assets, local: this.local, rules: this.rules }
        );
    }

    collector(options: CollectorOptions): DiskOutcomeCollector {
        return new DiskOutcomeCollector({
            ...options,
            snapshots: this.disk(options.snapshots),
            rules: this.rules,
        });
    }

    captureNativeState(options: NativeStateOptions): Promise<void> {
        return new NativeStateCapture(options.sandbox, this.rules).capture(
            this.disk(options.snapshots),
            options.maximumBytes,
            options.completed,
            options.checkpoint
        );
    }

    private disk(snapshots: StagedAsset[]): DiskAssetSnapshot[] {
        return snapshots.map((snapshot) => {
            if (!(snapshot instanceof DiskAssetSnapshot)) {
                throw new Error('The disk transfer collects only assets it packed');
            }
            return snapshot;
        });
    }
}
