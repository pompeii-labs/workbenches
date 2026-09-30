import { lstat, readFile } from 'node:fs/promises';

import type { OutcomeSink } from './collection.js';
import type { OutcomeContentDescriptor } from './contracts.js';
import { inferMediaType } from './media.js';

/**
 * Stores a local file in `sink`. A sink with a file path fast path keeps its own
 * streaming and limits. Any other sink receives the file's bytes.
 */
export async function putFileTo(
    sink: OutcomeSink,
    path: string,
    mediaType?: string
): Promise<OutcomeContentDescriptor> {
    if (sink.putFile) return sink.putFile(path, mediaType);
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isFile()) {
        throw new Error(`Outcome content must be a regular file: ${path}`);
    }
    return sink.putBytes(
        new Uint8Array(await readFile(path)),
        mediaType ?? inferMediaType(path)
    );
}
