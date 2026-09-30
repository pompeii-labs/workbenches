import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

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
        Readable.fromWeb(stream as globalThis.ReadableStream<Uint8Array>),
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
    for await (const chunk of stream) output.write(chunk);
}
