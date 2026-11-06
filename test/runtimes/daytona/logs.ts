import { client, json, type Recorded } from './http.js';

/** The toolbox log stream's markers for standard output and standard error. */
export const stdoutMarker = new Uint8Array([1, 1, 1]);
export const stderrMarker = new Uint8Array([2, 2, 2]);

export const encode = (text: string) => new TextEncoder().encode(text);

export const join = (...parts: Uint8Array[]) => {
    const joined = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        joined.set(part, offset);
        offset += part.length;
    }
    return joined;
};

/** One stream's chunk as the toolbox frames it. */
export const framed = (stream: 'stdout' | 'stderr', data: string | Uint8Array) =>
    join(
        stream === 'stdout' ? stdoutMarker : stderrMarker,
        typeof data === 'string' ? encode(data) : data
    );

export interface LogSocket {
    send(data: Uint8Array | string): void;
    /** Closes with a handshake, normally with code 1000. */
    close(code?: number): void;
    /** Drops the connection without a closing handshake. */
    terminate(): void;
}

const servers: Bun.Server<undefined>[] = [];

/** Stops every fake toolbox a test started. */
export function stopLogServers(): void {
    for (const server of servers.splice(0)) server.stop(true);
}

/**
 * A toolbox whose log stream is a real local WebSocket. `connected` runs for
 * each connection with its index. `refuse` answers the upgrade with an error.
 * `status` answers the command status endpoint; by default the command runs.
 * `execute` answers one-shot commands; by default they succeed with no output.
 * `input` answers writes to the command's standard input; by default they succeed.
 * `client` adds options to the client the toolbox is reached through.
 */
export function logToolbox(
    connected: (index: number, socket: LogSocket) => void,
    options: {
        refuse?: boolean;
        exited?: () => boolean;
        status?: () => Response;
        execute?: (request: Recorded) => Response;
        input?: (request: Recorded) => Response;
        client?: Record<string, unknown>;
    } = {}
) {
    const upgrades: Array<{ path: string; authorization: string | null }> = [];
    let connections = 0;
    const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch(request, server) {
            const url = new URL(request.url);
            upgrades.push({
                path: `${url.pathname}${url.search}`,
                authorization: request.headers.get('authorization'),
            });
            if (options.refuse) return new Response('bad gateway', { status: 502 });
            if (server.upgrade(request)) return undefined;
            return new Response('expected a WebSocket', { status: 400 });
        },
        websocket: {
            open(socket) {
                connected(connections++, socket);
            },
            message() {},
        },
    });
    servers.push(server);
    const handler = (request: Recorded) => {
        const path = request.url.pathname;
        if (request.method === 'POST' && path === '/api/sandbox')
            return json({ id: 'sandbox-1', state: 'started', labels: {} });
        if (request.method === 'GET' && path === '/api/sandbox/sandbox-1')
            return json({
                id: 'sandbox-1',
                state: 'started',
                toolboxProxyUrl: `http://127.0.0.1:${server.port}/toolbox/`,
            });
        if (path.endsWith('/exec')) return json({ cmdId: 'cmd-1' });
        if (path.endsWith('/process/execute'))
            return options.execute?.(request) ?? json({ exitCode: 0, result: '' });
        if (path.endsWith('/command/cmd-1/input'))
            return options.input?.(request) ?? json({});
        if (request.method === 'GET' && path.endsWith('/command/cmd-1'))
            return (
                options.status?.() ??
                json({ id: 'cmd-1', exitCode: options.exited?.() ? 0 : null })
            );
        return json({});
    };
    const { api, requests } = client(handler, options.client);
    return {
        upgrades,
        requests,
        connections: () => connections,
        sandbox: () =>
            api.createSandbox({
                snapshot: 'wb-fixture',
                labels: {},
                leaseMinutes: 5,
            }),
    };
}

/** The id of the session the toolbox was asked to create. */
export function sessionOf(requests: Recorded[]): string {
    const created = requests.find(
        (request) =>
            request.method === 'POST' &&
            request.url.pathname.endsWith('/process/session')
    );
    const body: unknown = JSON.parse(String(created?.body));
    if (typeof body !== 'object' || body === null || !('sessionId' in body))
        throw new Error('No session was created');
    return String(body.sessionId);
}
