import { lstat, readFile } from 'node:fs/promises';

import type { OutcomeSink } from './collection.js';
import type { OutcomeContentDescriptor } from './contracts.js';
import { inferMediaType } from './media.js';

/**
 * Stores files that live on the machine running the engine in a sink. A sink
 * with its own `putFile` keeps its streaming and limits. Any other sink
 * receives the file's bytes.
 */
export class OutcomeFiles {
    constructor(private readonly sink: OutcomeSink) {}

    async put(path: string, mediaType?: string): Promise<OutcomeContentDescriptor> {
        if (this.sink.putFile) return this.sink.putFile(path, mediaType);
        const details = await lstat(path);
        if (details.isSymbolicLink() || !details.isFile()) {
            throw new Error(`Outcome content must be a regular file: ${path}`);
        }
        return this.sink.putBytes(
            new Uint8Array(await readFile(path)),
            mediaType ?? inferMediaType(path)
        );
    }
}
