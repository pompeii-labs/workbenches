import type { Pack } from 'tar-stream';

import { archiveRecords, type SnapshotEntry, type StagingContext } from './plan.js';
import type { TarEntry } from './tar.js';

/**
 * Writes the selected entries into a `tar-stream` pack and finalizes it. This is
 * the streaming writer the disk transfer uses. `archiveBytes` in `plan.ts`
 * builds the same archive in memory.
 */
export async function fillArchive(
    context: StagingContext,
    pack: Pack,
    source: string,
    entries: Map<string, SnapshotEntry>,
    sourceIsDirectory: boolean
): Promise<void> {
    for await (const record of archiveRecords(
        context,
        source,
        entries,
        sourceIsDirectory
    )) {
        await write(pack, record);
    }
    pack.finalize();
}

function write(pack: Pack, record: TarEntry): Promise<void> {
    return new Promise<void>((resolveEntry, reject) => {
        const done = (error?: Error | null) => (error ? reject(error) : resolveEntry());
        if (record.type === 'symlink') {
            pack.entry(
                {
                    name: record.name,
                    type: 'symlink',
                    linkname: record.link ?? '',
                    mode: record.mode,
                },
                done
            );
            return;
        }
        pack.entry(
            {
                name: record.name,
                type: 'file',
                size: record.content.byteLength,
                mode: record.mode,
            },
            Buffer.from(record.content),
            done
        );
    });
}
