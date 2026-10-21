import { DaytonaApiError, type DaytonaTransport } from './transport.js';

/** Receives a command's standard output and the offset it starts at in that output. */
export type LogOutput = (bytes: Uint8Array, start: number) => void;

/** A command whose output is followed until it is stopped. */
export interface FollowedCommand {
    /** Stops following and ends the command's session. Safe to repeat. */
    stop(): Promise<void>;
}

/** Consecutive connections that deliver nothing before the follower gives up. */
const maximumFailures = 5;
const maximumReconnectDelayMs = 5_000;

/**
 * Follows a toolbox session command's output over the toolbox's log WebSocket
 * (`.../logs?follow=true`), so output arrives as it is written without
 * polling. Every connection replays the command's output from its start, so
 * each chunk is reported with its offset in that output and the receiver
 * keeps only what it has not seen. A dropped connection is opened again after
 * a short delay until the command exits, the follower is stopped, or several
 * connections in a row fail.
 */
export class LogFollower implements FollowedCommand {
    readonly #done: Promise<void>;
    #socket: WebSocket | undefined;
    #stopped = false;

    constructor(
        private readonly transport: DaytonaTransport,
        /** The session's absolute toolbox URL. */
        private readonly session: string,
        private readonly command: string,
        private readonly onStdout: LogOutput,
        private readonly onFailure: (error: unknown) => void
    ) {
        this.#done = this.follow();
    }

    async stop(): Promise<void> {
        this.#stopped = true;
        this.#socket?.close();
        await this.#done;
        await this.transport
            .request('DELETE', this.session, { absolute: true })
            .catch(() => {});
    }

    private async follow(): Promise<void> {
        let failures = 0;
        let failure: unknown;
        while (!this.#stopped) {
            const received = await this.connect().catch((error: unknown) => {
                failure = error;
                return 0;
            });
            if (this.#stopped) return;
            failures = received > 0 ? 0 : failures + 1;
            if (await this.exited()) return;
            if (failures >= maximumFailures) {
                this.onFailure(
                    failure ??
                        new DaytonaApiError('The Daytona log stream kept closing')
                );
                return;
            }
            await this.transport.wait(
                Math.min(
                    this.transport.pollIntervalMs * 2 ** failures,
                    maximumReconnectDelayMs
                )
            );
        }
    }

    /** Follows one connection until it closes and resolves with the bytes of output it carried. */
    private connect(): Promise<number> {
        return new Promise((resolve, reject) => {
            const socket = this.transport.socket(
                `${this.session}/command/${this.command}/logs?follow=true`
            );
            socket.binaryType = 'arraybuffer';
            this.#socket = socket;
            const demux = new StreamDemux();
            let received = 0;
            let failed: Error | undefined;
            const deliver = (parts: DemuxedOutput[]) => {
                for (const part of parts) {
                    if (part.stream !== 'stdout') continue;
                    this.onStdout(part.bytes, received);
                    received += part.bytes.byteLength;
                }
            };
            const opening = setTimeout(() => {
                if (socket.readyState !== WebSocket.CONNECTING) return;
                failed = new DaytonaApiError(
                    `The Daytona log stream did not open within ${Math.round(this.transport.requestTimeoutMs / 1000)} seconds`
                );
                socket.close();
            }, this.transport.requestTimeoutMs);
            socket.addEventListener('message', (event) => {
                const bytes = messageBytes(event.data);
                if (bytes) deliver(demux.feed(bytes));
            });
            socket.addEventListener('error', () => {
                failed ??= new DaytonaApiError('The Daytona log stream failed');
            });
            socket.addEventListener('close', () => {
                clearTimeout(opening);
                if (this.#socket === socket) this.#socket = undefined;
                deliver(demux.flush());
                if (failed && received === 0) reject(failed);
                else resolve(received);
            });
            // A stop that raced the connection closes it as soon as it exists.
            if (this.#stopped) socket.close();
        });
    }

    /** True once the command reports an exit code. An unreadable status counts as running. */
    private async exited(): Promise<boolean> {
        const status = await this.transport
            .json<unknown>('GET', `${this.session}/command/${this.command}`, {
                absolute: true,
            })
            .catch(() => undefined);
        return (
            typeof status === 'object' &&
            status !== null &&
            'exitCode' in status &&
            typeof status.exitCode === 'number'
        );
    }
}

function messageBytes(data: unknown): Uint8Array | undefined {
    if (typeof data === 'string') return new TextEncoder().encode(data);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data))
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return undefined;
}

interface DemuxedOutput {
    stream: 'stdout' | 'stderr';
    bytes: Uint8Array;
}

const markerLength = 3;
const markers = { 1: 'stdout', 2: 'stderr' } as const;

/**
 * Splits the toolbox's multiplexed log stream. A run of three `0x01` bytes
 * starts standard output and three `0x02` bytes start standard error. A marker
 * can be split across messages, so a possible marker at the end of a message
 * is held until the next one. Output before any marker counts as standard
 * output, as an unlabeled stream is.
 */
class StreamDemux {
    #pending = new Uint8Array(0);
    #stream: DemuxedOutput['stream'] = 'stdout';

    feed(bytes: Uint8Array): DemuxedOutput[] {
        const buffer = new Uint8Array(this.#pending.byteLength + bytes.byteLength);
        buffer.set(this.#pending);
        buffer.set(bytes, this.#pending.byteLength);
        this.#pending = new Uint8Array(0);
        const parts: DemuxedOutput[] = [];
        let start = 0;
        for (let index = 0; index < buffer.byteLength; index++) {
            const value = buffer[index];
            if (value !== 1 && value !== 2) continue;
            const run = buffer.subarray(index, index + markerLength);
            if (!run.every((byte) => byte === value)) continue;
            if (run.byteLength < markerLength) {
                this.emit(parts, buffer.subarray(start, index));
                this.#pending = buffer.slice(index);
                return parts;
            }
            this.emit(parts, buffer.subarray(start, index));
            this.#stream = markers[value];
            index += markerLength - 1;
            start = index + 1;
        }
        this.emit(parts, buffer.subarray(start));
        return parts;
    }

    /** What is held at the end of the stream, which can no longer be a marker. */
    flush(): DemuxedOutput[] {
        const parts: DemuxedOutput[] = [];
        this.emit(parts, this.#pending);
        this.#pending = new Uint8Array(0);
        return parts;
    }

    private emit(parts: DemuxedOutput[], bytes: Uint8Array): void {
        if (bytes.byteLength > 0)
            parts.push({ stream: this.#stream, bytes: bytes.slice() });
    }
}
