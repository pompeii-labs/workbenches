import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import { type PreviewAnnouncement, PreviewPolicy } from './policy.js';
import type { LoopbackPorts } from './probe.js';

/** Reads the control file at most this many bytes at a time. */
const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Owns the previews one run has accepted. It reads the control file from where
 * it last stopped, applies the policy to each complete line, and checks that
 * the port is listening before accepting it. A repeated name replaces the
 * earlier preview; repeating the same name and port changes nothing.
 */
export class PreviewAnnouncements {
    readonly #accepted = new Map<string, number>();
    #offset = 0;
    #pending = '';
    #discarding = false;
    #decoder = new TextDecoder();

    constructor(
        private readonly file: string,
        private readonly policy: PreviewPolicy,
        private readonly ports: Pick<LoopbackPorts, 'listening'>,
        private readonly warn: (message: string) => void
    ) {}

    /** Applies every line appended since the last read, in order, and returns the newly accepted previews. */
    async read(): Promise<PreviewAnnouncement[]> {
        const accepted: PreviewAnnouncement[] = [];
        for (const line of await this.lines()) {
            const decision = this.policy.decide(line, this.#accepted);
            if (!decision.accepted) {
                this.warn(`Ignored a preview announcement: ${decision.reason}`);
                continue;
            }
            const { name, port } = decision.preview;
            if (this.#accepted.get(name) === port) continue;
            if (!(await this.ports.listening(port))) {
                this.warn(
                    `Ignored preview ${name}: nothing is listening on port ${port}`
                );
                continue;
            }
            this.#accepted.set(name, port);
            accepted.push(decision.preview);
        }
        return accepted;
    }

    private async lines(): Promise<string[]> {
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
            if (details.size < this.#offset) this.restart();
            const lines: string[] = [];
            const buffer = new Uint8Array(READ_CHUNK_BYTES);
            for (;;) {
                const { bytesRead } = await handle.read(
                    buffer,
                    0,
                    buffer.byteLength,
                    this.#offset
                );
                if (bytesRead === 0) break;
                this.#offset += bytesRead;
                lines.push(
                    ...this.split(
                        this.#decoder.decode(buffer.subarray(0, bytesRead), {
                            stream: true,
                        })
                    )
                );
            }
            return lines;
        } finally {
            await handle.close();
        }
    }

    private split(text: string): string[] {
        const parts = (this.#pending + text).split('\n');
        this.#pending = parts.pop() ?? '';
        const lines = parts.flatMap((line) => {
            if (this.#discarding) {
                this.#discarding = false;
                return [];
            }
            return line.trim() ? [line] : [];
        });
        // An unterminated line longer than the policy allows is never accepted.
        if (this.#pending.length > PreviewPolicy.maximumLineBytes) {
            this.#pending = '';
            if (!this.#discarding)
                this.warn(
                    'Ignored a preview announcement: the announcement is too long'
                );
            this.#discarding = true;
        }
        return lines;
    }

    private restart(): void {
        this.#offset = 0;
        this.#pending = '';
        this.#discarding = false;
        this.#decoder = new TextDecoder();
    }
}
