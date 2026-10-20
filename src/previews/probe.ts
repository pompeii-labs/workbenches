import { createConnection } from 'node:net';

/** Checks whether a server accepts connections on a loopback port of this host. */
export class LoopbackPorts {
    static readonly host = '127.0.0.1';
    static readonly timeoutMs = 1_000;

    listening(port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const socket = createConnection({ host: LoopbackPorts.host, port });
            const finish = (open: boolean) => {
                socket.destroy();
                resolve(open);
            };
            socket.setTimeout(LoopbackPorts.timeoutMs, () => finish(false));
            socket.once('connect', () => finish(true));
            socket.once('error', () => finish(false));
        });
    }
}
