import type { WorkerApi } from './api.js';
import { isRecord, type TerminalSize } from './protocol.js';

/** The person's terminal, as a sign-in on a worker uses it. */
export interface WorkerConnectTerminal {
    size(): TerminalSize;
    /**
     * Passes the person's keystrokes, raw, and tells of each new size, until
     * the returned function is called.
     */
    attach(input: (data: Uint8Array) => void, resized: () => void): () => void;
    write(data: Uint8Array): void;
    /** Asks for a secret without echoing it. Undefined when the person cancels. */
    secret(message: string): Promise<string | undefined>;
}

export interface WorkerConnectOptions {
    api: Pick<WorkerApi, 'connect' | 'terminal'>;
    /** The CLI login key of the person signing in. It never reaches the worker. */
    login: string;
    worker: string;
    runner: string;
    /** The provider the person chose, as `wb connect` lists it. */
    provider: string;
    /** The id of the method the person chose for it. */
    method: string;
    terminal: WorkerConnectTerminal;
}

/**
 * Connects a runner on a worker from any machine where the person is logged
 * in. The site asks the worker to run the runner's own sign-in for the chosen
 * provider and method, or to take a key. The sign-in's terminal is this
 * terminal: what it draws arrives here as it is and the person's keystrokes
 * go back, as if it ran here. A secret the worker asks for is read without
 * echo. Credentials stay on the worker.
 */
export class WorkerConnect {
    constructor(private readonly options: WorkerConnectOptions) {}

    async run(): Promise<{ message: string }> {
        const { api, login, worker, runner, provider, method, terminal } = this.options;
        const { id, owner } = await api.connect(login, worker, {
            runner,
            provider,
            method,
        });
        // What the person signs in with stays on the worker, where anyone who runs there can read it.
        if (owner)
            terminal.write(
                new TextEncoder().encode(
                    `${worker} is ${owner}'s machine. Anyone who runs there can read what you sign in with.\r\n`
                )
            );
        const socket = api.terminal(login, worker, id, terminal.size());
        const send = (message: Record<string, unknown>) => {
            if (socket.readyState === WebSocket.OPEN)
                socket.send(JSON.stringify(message));
        };
        let detach: (() => void) | undefined;
        const attach = () => {
            detach = terminal.attach(
                (data) =>
                    send({ type: 'input', data: Buffer.from(data).toString('base64') }),
                () => send({ type: 'resize', ...terminal.size() })
            );
        };
        const release = () => {
            detach?.();
            detach = undefined;
        };
        try {
            return await new Promise<{ message: string }>((resolve, reject) => {
                let ended = false;
                socket.addEventListener('open', attach);
                socket.addEventListener('message', (event) => {
                    const message = serverMessage(event.data);
                    if (!message) return;
                    if (message.type === 'output') {
                        terminal.write(Buffer.from(message.data, 'base64'));
                    } else if (message.type === 'secret') {
                        // The secret prompt needs the terminal back from raw input.
                        release();
                        void terminal.secret(message.message).then((text) => {
                            if (text === undefined) {
                                reject(new Error('Connection setup cancelled'));
                                return;
                            }
                            send({ type: 'secret', text });
                            attach();
                        }, reject);
                    } else {
                        ended = true;
                        if (message.state === 'done')
                            resolve({ message: message.message });
                        else reject(new Error(message.message));
                    }
                });
                socket.addEventListener('close', () => {
                    if (!ended)
                        reject(
                            new Error(
                                `The connection to ${worker} closed before the sign-in ended`
                            )
                        );
                });
                socket.addEventListener('error', () => {
                    if (!ended)
                        reject(
                            new Error(
                                `Could not reach ${worker} through workbenches.dev`
                            )
                        );
                });
            });
        } finally {
            release();
            // Closing before the worker finished cancels the sign-in there.
            socket.close();
        }
    }
}

type ServerMessage =
    | { type: 'output'; data: string }
    | { type: 'secret'; message: string }
    | { type: 'end'; state: 'done' | 'failed'; message: string };

/** One frame from the site, or undefined for a frame this release does not know. */
function serverMessage(data: unknown): ServerMessage | undefined {
    if (typeof data !== 'string') return undefined;
    let value: unknown;
    try {
        value = JSON.parse(data);
    } catch {
        return undefined;
    }
    if (!isRecord(value)) return undefined;
    if (value.type === 'output' && typeof value.data === 'string')
        return { type: 'output', data: value.data };
    if (value.type === 'secret' && typeof value.message === 'string')
        return { type: 'secret', message: value.message };
    if (
        value.type === 'end' &&
        (value.state === 'done' || value.state === 'failed') &&
        typeof value.message === 'string'
    )
        return { type: 'end', state: value.state, message: value.message };
    return undefined;
}
