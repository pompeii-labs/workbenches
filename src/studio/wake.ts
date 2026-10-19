import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { RunChangeListener } from '../runs/store.js';

const RUN_ID = /^wb_[a-z0-9]{20,64}$/;

/** The socket the Studio API server listens on, owned by one Workbench home. */
function socketPath(home: string): string {
    return join(home, 'studio.sock');
}

/**
 * Tells a running Studio API server that a run changed. The wake carries only
 * the run ID and is best effort: with no server listening it does nothing.
 */
export class StudioWake implements RunChangeListener {
    readonly #path: string;

    constructor(home: string) {
        this.#path = socketPath(home);
    }

    notify(runId: string): void {
        void Bun.connect({
            unix: this.#path,
            socket: {
                open(socket) {
                    socket.end(`${runId}\n`);
                },
                data() {},
                close() {},
                error() {},
            },
        }).catch(() => {});
    }
}

/** The Studio API server's end of the wake socket. */
export class StudioWakeSocket {
    readonly path: string;
    #listener: Bun.UnixSocketListener<undefined> | undefined;

    constructor(home: string) {
        this.path = socketPath(home);
    }

    async start(onWake: (runId: string) => void): Promise<void> {
        await rm(this.path, { force: true });
        this.#listener = Bun.listen({
            unix: this.path,
            socket: {
                data: (_socket, data) => {
                    for (const id of data.toString().split('\n')) {
                        if (RUN_ID.test(id)) onWake(id);
                    }
                },
                open() {},
                close() {},
                error() {},
            },
        });
    }

    async stop(): Promise<void> {
        this.#listener?.stop(true);
        this.#listener = undefined;
        await rm(this.path, { force: true });
    }

    /** Removes a socket file a stopped server left behind. */
    async remove(): Promise<void> {
        await rm(this.path, { force: true });
    }
}
