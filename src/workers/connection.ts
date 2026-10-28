import type { WorkerMessage } from './protocol.js';

/** The part of a WebSocket the worker uses, so tests and other runtimes can supply one. */
export interface WorkerSocket {
    readonly readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    ping?(): void;
    addEventListener(type: 'open', listener: () => void): void;
    addEventListener(
        type: 'message',
        listener: (event: { data: unknown }) => void
    ): void;
    addEventListener(
        type: 'close',
        listener: (event: { code: number; reason: string }) => void
    ): void;
    addEventListener(type: 'error', listener: () => void): void;
}

export type WorkerSocketFactory = (url: string, key: string) => WorkerSocket;

export interface WorkerChannelClose {
    code: number;
    reason: string;
}

/**
 * One open connection to the server. Frames are JSON; a ping keeps idle
 * connections and their proxies alive.
 */
export class WorkerChannel {
    readonly closed: Promise<WorkerChannelClose>;
    #onMessage: (text: string) => void = () => {};
    #keepalive: ReturnType<typeof setInterval> | undefined;

    private constructor(
        private readonly socket: WorkerSocket,
        closed: Promise<WorkerChannelClose>
    ) {
        this.closed = closed;
    }

    /** Opens a channel; rejects when the connection fails before it opens. */
    static open(
        factory: WorkerSocketFactory,
        url: string,
        key: string,
        keepaliveMilliseconds = 30_000
    ): Promise<WorkerChannel> {
        return new Promise((resolve, reject) => {
            let socket: WorkerSocket;
            try {
                socket = factory(url, key);
            } catch (error) {
                reject(error);
                return;
            }
            let opened = false;
            let settleClose: (value: WorkerChannelClose) => void = () => {};
            const channel = new WorkerChannel(
                socket,
                new Promise<WorkerChannelClose>((done) => {
                    settleClose = done;
                })
            );
            socket.addEventListener('open', () => {
                opened = true;
                channel.#keepalive = setInterval(() => {
                    try {
                        socket.ping?.();
                    } catch {
                        // A failed ping surfaces as a close.
                    }
                }, keepaliveMilliseconds);
                resolve(channel);
            });
            socket.addEventListener('message', (event) => {
                const text = frameText(event.data);
                if (opened && text !== undefined) channel.#onMessage(text);
            });
            socket.addEventListener('close', (event) => {
                if (channel.#keepalive) clearInterval(channel.#keepalive);
                if (!opened)
                    reject(new Error(`Worker connection closed (${event.code})`));
                settleClose({ code: event.code, reason: event.reason });
            });
            socket.addEventListener('error', () => {
                if (!opened) reject(new Error('Worker connection failed'));
            });
        });
    }

    onMessage(listener: (text: string) => void): void {
        this.#onMessage = listener;
    }

    get open(): boolean {
        return this.socket.readyState === 1;
    }

    /** Sends one message; false when the socket is no longer open. */
    send(message: WorkerMessage): boolean {
        if (!this.open) return false;
        try {
            this.socket.send(JSON.stringify(message));
            return true;
        } catch {
            return false;
        }
    }

    close(code = 1000, reason = ''): void {
        if (this.#keepalive) clearInterval(this.#keepalive);
        try {
            this.socket.close(code, reason);
        } catch {
            // Already closed.
        }
    }
}

/** The standard WebSocket client, authenticated with the worker key. */
export const webSocketFactory: WorkerSocketFactory = (url, key) =>
    new WebSocket(url, { headers: { Authorization: `Bearer ${key}` } });

function frameText(data: unknown): string | undefined {
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
    if (ArrayBuffer.isView(data))
        return new TextDecoder().decode(
            new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        );
    return undefined;
}
