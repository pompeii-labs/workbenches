import { createServer } from 'node:net';

/** A loopback HTTP server on a free port. Stop it after the test. */
export function listen(): Bun.Server<undefined> {
    return Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: () => new Response('preview fixture'),
    });
}

/** A loopback port that was free a moment ago and has nothing listening on it. */
export function closedPort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = typeof address === 'object' && address ? address.port : 0;
            server.close(() => resolve(port));
        });
    });
}
