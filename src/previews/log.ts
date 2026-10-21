import { type PreviewAnnouncement, PreviewPolicy } from './policy.js';

/** Checks whether a server accepts connections on a port where the runner runs. */
export interface PreviewPorts {
    listening(port: number): Promise<boolean>;
}

/**
 * Owns the previews one run has accepted from its control file. Bytes arrive
 * with the offset they start at in the file, from whichever source read them,
 * and only bytes past what was already applied are used, so a source that
 * replays the file from its start never repeats an announcement. Each complete
 * line goes through the policy, and the port must be listening before a
 * preview is accepted. A repeated name replaces the earlier preview; repeating
 * the same name and port changes nothing. Calls must not overlap.
 */
export class AnnouncementLog {
    readonly #accepted = new Map<string, number>();
    #offset = 0;
    #pending = '';
    #discarding = false;
    #decoder = new TextDecoder();

    constructor(
        private readonly policy: PreviewPolicy,
        private readonly ports: PreviewPorts,
        private readonly warn: (message: string) => void
    ) {}

    /** How many bytes of the control file have been applied. */
    get offset(): number {
        return this.#offset;
    }

    /** True when `port` belongs to a preview this run currently shows. */
    shows(port: number): boolean {
        return [...this.#accepted.values()].includes(port);
    }

    /** True when the run has accepted at least one preview. */
    get empty(): boolean {
        return this.#accepted.size === 0;
    }

    /**
     * Applies the control file's bytes that start at offset `start` and
     * returns the newly accepted previews, in order. Bytes already applied are
     * skipped. Bytes that start past the applied offset cannot be placed and
     * are left for a later read from an earlier offset.
     */
    async offer(bytes: Uint8Array, start: number): Promise<PreviewAnnouncement[]> {
        const skip = this.#offset - start;
        if (skip < 0 || skip >= bytes.byteLength) return [];
        const fresh = bytes.subarray(skip);
        this.#offset += fresh.byteLength;
        return this.apply(this.split(this.#decoder.decode(fresh, { stream: true })));
    }

    /** Starts again from the beginning of a control file that was replaced or truncated. */
    restart(): void {
        this.#offset = 0;
        this.#pending = '';
        this.#discarding = false;
        this.#decoder = new TextDecoder();
    }

    private async apply(lines: string[]): Promise<PreviewAnnouncement[]> {
        const accepted: PreviewAnnouncement[] = [];
        for (const line of lines) {
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
}
