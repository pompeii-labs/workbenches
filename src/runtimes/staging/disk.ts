import { E2BOutcomeCollector } from '../e2b/collector.js';
import { captureE2BNativeState } from '../e2b/native.js';
import { E2BAssetSnapshot } from '../e2b/snapshot.js';
import { diskAssetSource } from './disk-source.js';
import type { RemoteTransfer, StagedAsset } from './transfer.js';

export { diskAssetSource };

function disk(snapshots: StagedAsset[]): E2BAssetSnapshot[] {
    return snapshots.map((snapshot) => {
        if (!(snapshot instanceof E2BAssetSnapshot)) {
            throw new Error('The disk transfer collects only assets it packed');
        }
        return snapshot;
    });
}

/**
 * Remote transfer through temporary files on the local disk. Archives are
 * written to a private temporary directory, collected changes are extracted and
 * compared on disk, and runner-owned native state is copied back into the
 * Workbench home. The CLI passes this. It needs Node compatible `fs`, `os`,
 * `zlib`, and `stream`.
 */
export const diskTransfer: RemoteTransfer = {
    pack: (binding, maximumBytes, options) =>
        E2BAssetSnapshot.create(binding, maximumBytes, undefined, options),
    collector: (options) =>
        new E2BOutcomeCollector({ ...options, snapshots: disk(options.snapshots) }),
    captureNativeState: (sandbox, snapshots, maximumBytes, completed, label) =>
        captureE2BNativeState(
            sandbox,
            disk(snapshots),
            maximumBytes,
            completed,
            undefined,
            label
        ),
};
