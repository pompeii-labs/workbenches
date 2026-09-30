import { describe, expect, test } from 'bun:test';

import { ModelCatalog } from '../src/models/catalog.js';
import { OpenCodeServer } from '../src/runners/opencode/server.js';
import { DaytonaApiClient } from '../src/runtimes/daytona/api-client.js';

/**
 * Some JavaScript runtimes (Cloudflare workerd) throw "Illegal invocation" when
 * a Web platform function runs with a `this` other than undefined. Node and Bun
 * do not, so this fetch enforces it the way those runtimes do.
 */
function strictFetch(calls: string[]): typeof fetch {
    return function (this: unknown, input: string | URL | Request) {
        if (this !== undefined) throw new TypeError('Illegal invocation');
        calls.push(String(input));
        return Promise.resolve(
            new Response(JSON.stringify([]), {
                headers: { 'content-type': 'application/json' },
            })
        );
    } as typeof fetch;
}

describe('portability across JavaScript runtimes', () => {
    test('the Daytona client calls an injected fetch with an undefined this', async () => {
        const calls: string[] = [];
        const api = new DaytonaApiClient({
            apiKey: 'key',
            apiUrl: 'https://daytona.test/api',
            fetch: strictFetch(calls),
        });
        expect(await api.listSandboxes({})).toEqual([]);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toContain('https://daytona.test/api/sandbox');
    });

    test('the OpenCode server calls an injected fetch with an undefined this', async () => {
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

    test('the model catalog calls an injected fetch with an undefined this', async () => {
        const calls: string[] = [];
        const catalog = new ModelCatalog({
            home: '/nonexistent',
            fetch: strictFetch(calls),
        });
        // The stub answers with an invalid manifest, so refresh rejects. It
        // must reject because of that, not because of the call itself.
        const error = await catalog.refresh().catch((caught: Error) => caught);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).not.toContain('Illegal invocation');
        expect(calls).toHaveLength(1);
    });
});
