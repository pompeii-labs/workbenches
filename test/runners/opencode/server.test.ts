import { describe, expect, test } from 'bun:test';

import { OpenCodeServer } from '../../../src/runners/opencode/server.js';

/**
 * Some JavaScript runtimes throw "Illegal invocation" when a Web platform
 * function runs with a `this` other than undefined. Node and Bun do not, so this
 * fetch enforces it the way those runtimes do.
 */
function strictFetch(calls: string[]): typeof fetch {
    return function (this: unknown, input: string | URL | Request) {
        if (this !== undefined) throw new TypeError('Illegal invocation');
        calls.push(String(input));
        return Promise.resolve(new Response('[]'));
    } as typeof fetch;
}

describe('OpenCodeServer', () => {
    test('calls an injected fetch with an undefined this', async () => {
        const calls: string[] = [];
        let closeOutput = () => {};
        let exit = () => {};
        const server = new OpenCodeServer({
            workspaceDirectory: '/workspace',
            password: () => 'secret',
            startupTimeoutMs: 1000,
            fetch: strictFetch(calls),
            launch: () => ({
                process: {
                    exited: new Promise<number>((resolve) => {
                        exit = () => resolve(0);
                    }),
                    stdout: new ReadableStream<Uint8Array>({
                        start(controller) {
                            closeOutput = () => controller.close();
                            controller.enqueue(
                                new TextEncoder().encode(
                                    'listening on http://127.0.0.1:4096\n'
                                )
                            );
                        },
                    }),
                    kill: () => {
                        closeOutput();
                        exit();
                    },
                },
                resolveUrl: async (url) => url,
            }),
        });
        await server.start(
            () => ({ command: 'opencode', args: [], env: {} }) as never,
            () => {}
        );
        try {
            await server.request('/session', { method: 'GET' });
            expect(calls).toHaveLength(1);
            expect(calls[0]).toContain('http://127.0.0.1:4096/session');
        } finally {
            await server.close();
        }
    });
});
