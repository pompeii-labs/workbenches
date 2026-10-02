import type { TransferRules } from '../rules.js';
import type { AssetSource } from '../source.js';
import type {
    AssetBinding,
    CollectorOptions,
    PackOptions,
    RemoteTransfer,
    StagedAsset,
} from '../transfer.js';
import { MemoryOutcomeCollector } from './collector.js';
import { MemoryAssetSnapshot } from './snapshot.js';

/**
 * Remote transfer with no storage of its own: archives are byte arrays, and
 * collected content goes to the caller's `OutcomeSink`. Files are read through
 * `source`, and `rules` names the provider in messages. Runner-owned native
 * state is the host's to keep, so it is not copied out. It needs only
 * `CompressionStream`, which every current JavaScript runtime provides.
 */
export class MemoryTransfer implements RemoteTransfer {
    constructor(
        private readonly source: AssetSource,
        private readonly rules: TransferRules
    ) {}

    pack(
        binding: AssetBinding,
        maximumBytes: number,
        options?: PackOptions
    ): Promise<StagedAsset> {
        return MemoryAssetSnapshot.create(
            this.source,
            this.rules,
            binding,
            maximumBytes,
            options
        );
    }

    collector(options: CollectorOptions): MemoryOutcomeCollector {
        const snapshots = options.snapshots.map((snapshot) => {
            if (!(snapshot instanceof MemoryAssetSnapshot)) {
                throw new Error(
                    'The in-memory transfer collects only assets it packed'
                );
            }
            return snapshot;
        });
        return new MemoryOutcomeCollector(options.sandbox, this.rules, {
            snapshots,
            baselines: options.baselines,
            maximumTransferBytes: options.maximumTransferBytes,
        });
    }

    async captureNativeState(): Promise<void> {}
}
