import { createHash } from 'node:crypto';

import type { Pack } from 'tar-stream';

import type { StreamedRecord } from './plan.js';
import type { TransferRules } from './rules.js';
import type { TarEntry } from './tar.js';

/**
 * Writes archive records into a `tar-stream` pack and finalizes it. This is the
 * streaming writer the disk transfer uses. A source that can stream has each
 * file read once, digested as it is packed. `TransferPlan.archiveBytes` builds
 * the same archive in memory. `rules` names the provider in messages.
 */
export class ArchiveWriter {
    constructor(private readonly rules: TransferRules) {}

    async write(pack: Pack, records: AsyncIterable<TarEntry | StreamedRecord>) {
        for await (const record of records) {
            if (record.type === 'stream') {
                await this.writeStreamed(pack, record);
            } else {
                await this.writeEntry(pack, record);
            }
        }
        pack.finalize();
    }

    private async writeStreamed(pack: Pack, record: StreamedRecord): Promise<void> {
        const changed = () =>
            new Error(
                `${this.rules.provider} transfer source changed while reading: ${record.name}`
            );
        const hash = createHash('sha256');
        let received = 0;
        let sink!: ReturnType<Pack['entry']>;
        const done = new Promise<void>((resolveEntry, reject) => {
            sink = pack.entry(
                {
                    name: record.name,
                    type: 'file',
                    size: record.size,
                    mode: record.mode,
                },
                (error) => (error ? reject(error) : resolveEntry())
            );
        });
        // A failure while reading destroys the sink; that rejection is already handled.
        done.catch(() => undefined);
        sink.on('error', () => undefined);
        const reader = record.body.getReader();
        try {
            for (;;) {
                const chunk = await reader.read();
                if (chunk.done) break;
                received += chunk.value.byteLength;
                if (received > record.size) throw changed();
                hash.update(chunk.value);
                if (!sink.write(Buffer.from(chunk.value))) {
                    await this.drained(pack, sink);
                }
            }
            if (received !== record.size) throw changed();
            sink.end();
            await done;
            record.entry.digest = `sha256:${hash.digest('hex')}`;
        } catch (error) {
            sink.destroy(error as Error);
            await reader.cancel().catch(() => undefined);
            throw error;
        }
    }

    /**
     * Waits for `sink` to take more data. A pack that is destroyed mid-entry
     * never drains, so its error or close ends the wait instead of leaving the
     * fill hanging.
     */
    private drained(pack: Pack, sink: ReturnType<Pack['entry']>): Promise<void> {
        return new Promise<void>((resolveDrain, reject) => {
            const closed = () =>
                settle(
                    new Error(
                        `${this.rules.provider} transfer archive closed before the file was written`
                    )
                );
            const settle = (error?: Error) => {
                sink.off('drain', drained);
                sink.off('error', settle);
                sink.off('close', closed);
                pack.off('error', settle);
                pack.off('close', closed);
                if (error) reject(error);
                else resolveDrain();
            };
            const drained = () => settle();
            sink.once('drain', drained);
            sink.once('error', settle);
            sink.once('close', closed);
            pack.once('error', settle);
            pack.once('close', closed);
        });
    }

    private writeEntry(pack: Pack, record: TarEntry): Promise<void> {
        return new Promise<void>((resolveEntry, reject) => {
            const done = (error?: Error | null) =>
                error ? reject(error) : resolveEntry();
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
}
