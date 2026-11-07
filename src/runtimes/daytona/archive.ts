import type { ArchiveUpload } from '../remote/stage.js';
import type { StagedAsset } from '../staging/transfer.js';
import type { DaytonaSandbox } from './contracts.js';

/** Puts a snapshot's archive into the sandbox. The toolbox takes whole byte arrays. */
export class DaytonaArchiveUpload implements ArchiveUpload<StagedAsset> {
    constructor(private readonly sandbox: Pick<DaytonaSandbox, 'upload'>) {}

    async upload(remotePath: string, asset: StagedAsset): Promise<void> {
        await this.sandbox.upload(remotePath, await asset.archiveBytes());
    }
}
