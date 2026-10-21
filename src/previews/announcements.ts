import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import { AnnouncementLog, type PreviewPorts } from './log.js';
import type { PreviewAnnouncement, PreviewPolicy } from './policy.js';

/** Reads the control file at most this many bytes at a time. */
const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Reads a run's control file on this host from where it last stopped and
 * applies what it finds to the run's announcement log. A file that shrank was
 * replaced, so it is read again from the start.
 */
export class PreviewAnnouncements {
    readonly #log: AnnouncementLog;

    constructor(
        private readonly file: string,
        policy: PreviewPolicy,
        ports: PreviewPorts,
        warn: (message: string) => void
    ) {
        this.#log = new AnnouncementLog(policy, ports, warn);
    }

    /** Applies every line appended since the last read, in order, and returns the newly accepted previews. */
    async read(): Promise<PreviewAnnouncement[]> {
        const handle = await open(
            this.file,
            constants.O_RDONLY | constants.O_NOFOLLOW
        ).catch((error) => {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
                return undefined;
            throw error;
        });
        if (!handle) return [];
        try {
            const details = await handle.stat();
            if (!details.isFile())
                throw new Error('Preview control file is not a file');
            if (details.size < this.#log.offset) this.#log.restart();
            const accepted: PreviewAnnouncement[] = [];
            const buffer = new Uint8Array(READ_CHUNK_BYTES);
            for (;;) {
                const start = this.#log.offset;
                const { bytesRead } = await handle.read(
                    buffer,
                    0,
                    buffer.byteLength,
                    start
                );
                if (bytesRead === 0) break;
                accepted.push(
                    ...(await this.#log.offer(buffer.subarray(0, bytesRead), start))
                );
            }
            return accepted;
        } finally {
            await handle.close();
        }
    }
}
