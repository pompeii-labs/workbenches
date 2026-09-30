/**
 * Staging files into a remote sandbox and collecting what comes back, without a
 * filesystem. A host reads its files through an `AssetSource`, packs them with a
 * `RemoteTransfer`, and receives outcomes in an `OutcomeSink`. The disk
 * implementations are `./runtimes/staging/disk`.
 */
export { type DiffSide, renderDiff } from './diff.js';
export {
    MemoryAssetSnapshot,
    type MemorySnapshotOptions,
    memoryTransfer,
} from './memory.js';
export { MemoryAssetSource } from './memory-source.js';
export type { AssetGit, AssetSource, AssetStat } from './source.js';
export {
    gunzip,
    gzip,
    packTar,
    packTarGzip,
    type ReadTarOptions,
    readTar,
    type TarEntry,
    type TarEntryType,
} from './tar.js';
export type {
    OutcomeCollector,
    RemoteTransfer,
    StagedAsset,
    TransferSandbox,
} from './transfer.js';
