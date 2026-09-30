import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import type { E2BSandbox } from './contracts.js';
import { formatBytes } from './infrastructure.js';

export async function downloadE2BFile(
    sandbox: Pick<E2BSandbox, 'download'>,
    remote: string,
    local: string,
    maximumBytes: number,
    reportedMaximumBytes: number,
    label = 'E2B'
): Promise<number> {
    const stream = await sandbox.download(remote);
    let bytes = 0;
    const limit = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.byteLength;
            if (bytes > maximumBytes) {
                callback(
                    new Error(
                        `${label} output exceeds the ${formatBytes(reportedMaximumBytes)} transfer safety limit`
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

export async function pipeWebOutput(
    stream: ReadableStream<Uint8Array> | undefined,
    output: NodeJS.WriteStream
): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            output.write(value);
        }
    } finally {
        reader.releaseLock();
    }
}
