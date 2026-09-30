import { MemoryOutcomeCollector } from './memory-collector.js';
import { MemoryAssetSnapshot, type MemorySnapshotOptions } from './memory-snapshot.js';
import type { RemoteTransfer } from './transfer.js';

export { MemoryAssetSnapshot, type MemorySnapshotOptions };

/**
 * Remote transfer with no storage of its own: archives are byte arrays, and
 * collected content goes to the caller's `OutcomeSink`. Runner-owned native
 * state is the host's to keep, so it is not copied out. It needs only
 * `CompressionStream`, which every current JavaScript runtime provides.
 */
export const memoryTransfer: RemoteTransfer = {
    pack: (binding, maximumBytes, options) =>
        MemoryAssetSnapshot.create(binding, maximumBytes, options),
    collector(options) {
        const snapshots = options.snapshots.map((snapshot) => {
            if (!(snapshot instanceof MemoryAssetSnapshot)) {
                throw new Error(
                    'The in-memory transfer collects only assets it packed'
                );
            }
            return snapshot;
        });
        return new MemoryOutcomeCollector({ ...options, snapshots });
    },
    async captureNativeState() {},
};
