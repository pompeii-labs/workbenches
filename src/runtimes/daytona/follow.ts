import { RuntimeError } from '../error.js';
import { DaytonaApiError, type DaytonaTransport } from './transport.js';

/** Receives new output of one stream and the offset it starts at in that stream. */
export type LogOutput = (bytes: Uint8Array, start: number) => void;

/** Where a follower delivers each stream. Standard error without a receiver is dropped. */
export interface LogStreams {
    stdout: LogOutput;
    stderr?: LogOutput;
}

/** A command whose output is followed until it is stopped. */
export interface FollowedCommand {
    /** Stops following and ends the command's session. Safe to repeat. */
    stop(): Promise<void>;
}

type Stream = 'stdout' | 'stderr';

/** How one connection ended. */
interface Connection {
    /** Bytes of output it carried, including any replayed. */
    received: number;
    /** It closed with a handshake and no error, so it carried everything the toolbox sent. */
    intact: boolean;
    /** The toolbox closed it normally, as it does once the command has exited. */
    normal: boolean;
}

/** Consecutive connections, or status reads, that fail before the follower gives up. */
const maximumFailures = 5;
const maximumReconnectDelayMs = 5_000;
const normalClosure = 1000;
/** Reported locally when a connection dropped without a closing handshake. */
const abnormalClosure = 1006;

/**
 * Follows a toolbox session command's standard output and standard error over
 * the toolbox's log WebSocket (`.../logs?follow=true`), so output arrives as
 * it is written without polling. Every connection replays the command's output
 * from its start, so each stream keeps the offset it has delivered and passes
 * on only what is past it, with that offset. A dropped connection is opened
 * again after a short delay until the command exits, the follower is stopped,
 * or several connections in a row fail.
 *
 * The command's status is read only after a connection closes. A connection
 * the toolbox closed normally once the command exited carried all of its
 * output. Any other close after the exit is followed by one more connection,
 * which replays the output whole and so fills whatever the dropped one missed.
 */
export class LogFollower implements FollowedCommand {
    readonly #done: Promise<number | undefined>;
    readonly #delivered: Record<Stream, number> = { stdout: 0, stderr: 0 };
    #exitCode: number | undefined;
    #socket: WebSocket | undefined;
    #stopped = false;

    constructor(
        private readonly transport: DaytonaTransport,
        /** The session's absolute toolbox URL. */
        private readonly session: string,
        private readonly command: string,
        private readonly streams: LogStreams,
        private readonly onFailure: (error: unknown) => void
    ) {
        this.#done = this.follow();
    }

    /**
     * Resolves with the command's exit code once all of its output has been
     * delivered. It resolves without one when the follower was stopped or gave
     * up before the command exited; giving up is reported to `onFailure`, and a
     * known exit code is kept even if the output after it could not be read.
     */
    exit(): Promise<number | undefined> {
        return this.#done;
    }

    /**
     * Whether the command has exited: known once a status read reported its
     * exit code, and otherwise asked of the toolbox once. It rejects when the
     * status cannot be read.
     */
    async hasExited(): Promise<boolean> {
        if (this.#exitCode !== undefined) return true;
        return (await this.status()) !== undefined;
    }

    async stop(): Promise<void> {
        this.#stopped = true;
        this.#socket?.close();
        await this.#done;
        await this.transport
            .request('DELETE', this.session, { absolute: true })
            .catch(() => {});
    }

    private async follow(): Promise<number | undefined> {
        let failures = 0;
        let statusFailures = 0;
        let failure: unknown;
        let exitCode: number | undefined;
        while (!this.#stopped) {
            const exitedBefore = exitCode !== undefined;
            const connection = await this.connect().catch((error: unknown) => {
                failure = error;
                return undefined;
            });
            if (this.#stopped) return undefined;
            // A connection opened after the exit replays the output whole.
            if (exitedBefore && connection?.intact) return exitCode;
            failures = connection && connection.received > 0 ? 0 : failures + 1;
            if (exitCode === undefined) {
                try {
                    exitCode = await this.status();
                    statusFailures = 0;
                } catch (error) {
                    if (error instanceof RuntimeError) {
                        this.onFailure(error);
                        return undefined;
                    }
                    failure = error;
                    statusFailures++;
                }
                if (exitCode !== undefined && connection?.intact && connection.normal)
                    return exitCode;
            }
            if (failures >= maximumFailures || statusFailures >= maximumFailures) {
                this.onFailure(
                    failure ??
                        new DaytonaApiError('The Daytona log stream kept closing')
                );
                return exitCode;
            }
            await this.transport.wait(
                Math.min(
                    this.transport.pollIntervalMs *
                        2 ** Math.max(failures, statusFailures),
                    maximumReconnectDelayMs
                )
            );
        }
        return undefined;
    }

    /** Follows one connection until it closes. */
    private connect(): Promise<Connection> {
        return new Promise((resolve, reject) => {
            const socket = this.transport.socket(
                `${this.session}/command/${this.command}/logs?follow=true`
            );
            socket.binaryType = 'arraybuffer';
            this.#socket = socket;
            const demux = new StreamDemux();
            const position: Record<Stream, number> = { stdout: 0, stderr: 0 };
            let received = 0;
            let failed: Error | undefined;
            const deliver = (parts: DemuxedOutput[]) => {
                for (const part of parts) {
                    const start = position[part.stream];
                    const end = start + part.bytes.byteLength;
                    position[part.stream] = end;
                    received += part.bytes.byteLength;
                    const delivered = this.#delivered[part.stream];
                    if (end <= delivered) continue;
                    this.#delivered[part.stream] = end;
                    const fresh = part.bytes.subarray(Math.max(0, delivered - start));
                    this.streams[part.stream]?.(fresh, end - fresh.byteLength);
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
            socket.addEventListener('close', (event) => {
                clearTimeout(opening);
                if (this.#socket === socket) this.#socket = undefined;
                deliver(demux.flush());
                if (failed && received === 0) reject(failed);
                else
                    resolve({
                        received,
                        intact: failed === undefined && event.code !== abnormalClosure,
                        normal: event.code === normalClosure,
                    });
            });
            // A stop that raced the connection closes it as soon as it exists.
            if (this.#stopped) socket.close();
        });
    }

    /**
     * The command's exit code, or undefined while it runs: the toolbox leaves
     * `exitCode` out, or reports null, until then. A reply that does not
     * identify the command, such as a proxy page, is not a status, and a
     * follower must never wait on it. An exit code, once read, is kept.
     */
    private async status(): Promise<number | undefined> {
        const status = await this.transport.json<unknown>(
            'GET',
            `${this.session}/command/${this.command}`,
            { absolute: true }
        );
        if (
            typeof status !== 'object' ||
            status === null ||
            !('id' in status) ||
            typeof status.id !== 'string'
        ) {
            throw new RuntimeError(
                'daytona',
                'launch',
                'Daytona toolbox returned an unexpected command status: expected JSON with the command id'
            );
        }
        if ('exitCode' in status && typeof status.exitCode === 'number')
            this.#exitCode ??= status.exitCode;
        return this.#exitCode;
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
