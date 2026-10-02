/**
 * Staging files into a remote sandbox and collecting what comes back, without a
 * filesystem. A host reads its files through an `AssetSource`, packs them with a
 * `RemoteTransfer`, and receives outcomes in an `OutcomeSink`. The disk
 * source is `DiskAssetSource` in `./runtimes/assets/disk`. A disk-backed
 * transfer ships with the provider that stages through temporary files.
 */
export { type DiffSide, renderDiff } from './diff.js';
export { MemoryAssetSnapshot } from './memory/snapshot.js';
export { MemoryAssetSource } from './memory/source.js';
export { MemoryTransfer } from './memory/transfer.js';
export { TransferRules } from './rules.js';
export type { AssetGit, AssetSource, AssetStat } from './source.js';
export {
    type ReadTarOptions,
    TarArchive,
    type TarEntry,
    type TarEntryType,
} from './tar.js';
export type {
    AssetBinding,
    CollectorOptions,
    NativeStateOptions,
    OutcomeCollector,
    PackOptions,
    RemoteTransfer,
    StagedAsset,
    TransferSandbox,
} from './transfer.js';
