import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import { formatOutcomeBytes } from '../../outcomes/presentation.js';
import type { E2BSandbox } from './contracts.js';

export interface DownloadLimits {
    /** The download fails once it passes this many bytes. */
    maximumBytes: number;
    /** The limit named in the message, when it differs from the one enforced. */
    reportedMaximumBytes: number;
}

/** Copies files out of one E2B sandbox onto the host. */
export class E2BTransfer {
    constructor(private readonly sandbox: Pick<E2BSandbox, 'download'>) {}

    /** Downloads `remote` to `local` and returns the bytes written. */
    async download(
        remote: string,
        local: string,
        limits: DownloadLimits
    ): Promise<number> {
        const stream = await this.sandbox.download(remote);
        let bytes = 0;
        const limit = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
                bytes += chunk.byteLength;
                if (bytes > limits.maximumBytes) {
                    callback(
                        new Error(
                            `E2B output exceeds the ${formatOutcomeBytes(limits.reportedMaximumBytes)} transfer safety limit`
                        )
                    );
                    return;
                }
                callback(null, chunk);
            },
        });
        await pipeline(
            Readable.fromWeb(stream as unknown as NodeReadableStream<Uint8Array>),
            limit,
            createWriteStream(local, { mode: 0o600 })
        );
        return bytes;
    }
}
