import { describe, expect, test } from 'bun:test';
import { getEventListeners } from 'node:events';

import {
    type OpenCodeFetch,
    OpenCodeServer,
} from '../../../src/runners/opencode/server.js';

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
            expect(calls).toHaveLength(2);
            expect(calls[0]).toContain('http://127.0.0.1:4096/api/info');
            expect(calls[1]).toContain('http://127.0.0.1:4096/session');
        } finally {
            await server.close();
        }
    });
});

describe('OpenCodeServer exit', () => {
    async function failureAfterExit(code: number): Promise<string> {
        let exit = (_code: number) => {};
        let closeOutput = () => {};
        const failures: string[] = [];
        const server = new OpenCodeServer({
            workspaceDirectory: '/workspace',
            password: () => 'secret',
            startupTimeoutMs: 1000,
            fetch: strictFetch([]),
            launch: () => ({
                process: {
                    exited: new Promise<number>((resolve) => {
                        exit = resolve;
                    }),
                    stdout: new ReadableStream<Uint8Array>({
                        start(controller) {
                            closeOutput = () => {
                                try {
                                    controller.close();
                                } catch {}
                            };
                            controller.enqueue(
                                new TextEncoder().encode(
                                    'listening on http://127.0.0.1:4096\n'
                                )
                            );
                        },
                    }),
                    kill: () => {
                        closeOutput();
                        exit(0);
                    },
                },
                resolveUrl: async (url) => url,
            }),
        });
        await server.start(
            () => ({ command: 'opencode', args: [], env: {} }) as never,
            (error) => failures.push(error.message)
        );
        exit(code);
        closeOutput();
        await Bun.sleep(5);
        await server.close();
        return failures[0] ?? '';
    }

    test('says a killed server most likely ran out of memory', async () => {
        expect(await failureAfterExit(137)).toBe(
            'OpenCode server was killed (exit 137), most likely out of memory.'
        );
    });

    test('keeps the plain message for another exit code', async () => {
        expect(await failureAfterExit(2)).toBe('OpenCode server exited with code 2');
    });
});

/** An event stream that stays open until its request is aborted. */
function openStream(signal: AbortSignal | null | undefined): Response {
    return new Response(
        new ReadableStream<Uint8Array>({
            start(controller) {
                signal?.addEventListener('abort', () => controller.close());
            },
        })
    );
}

async function startedServer(
    fetch: OpenCodeFetch,
    abort = new AbortController()
): Promise<OpenCodeServer> {
    let closeOutput = () => {};
    let exit = () => {};
    const server = new OpenCodeServer({
        abort,
        workspaceDirectory: '/workspace',
        password: () => 'secret',
        startupTimeoutMs: 1000,
        fetch: async (input, init) =>
            new URL(String(input)).pathname === '/api/info'
                ? new Response(null, { status: 404 })
                : fetch(input, init),
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
    return server;
}

describe('OpenCodeServer event subscription', () => {
    test('resubscribing drops the replaced subscription close listener', async () => {
        const abort = new AbortController();
        const server = await startedServer(
            async (_input, init) => openStream(init?.signal),
            abort
        );
        // The signal the test owns is what each subscription listens to for close.
        const signal = abort.signal;
        const baseline = getEventListeners(signal, 'abort').length;
        try {
            for (let subscriptions = 1; subscriptions <= 5; subscriptions += 1) {
                await server.subscribe(
                    async () => {},
                    () => {}
                );
                expect(getEventListeners(signal, 'abort').length).toBe(baseline + 1);
            }
        } finally {
            await server.close();
        }
    });

    test('a replaced subscription ending is not reported as a failure', async () => {
        const server = await startedServer(async (_input, init) =>
            openStream(init?.signal)
        );
        const failures: Error[] = [];
        try {
            await server.subscribe(
                async () => {},
                (error) => failures.push(error)
            );
            await server.subscribe(
                async () => {},
                (error) => failures.push(error)
            );
            await Bun.sleep(5);
            expect(failures).toEqual([]);
        } finally {
            await server.close();
        }
    });

    test('refuses to subscribe once the server is closed', async () => {
        const abort = new AbortController();
        const server = await startedServer(
            async (_input, init) => openStream(init?.signal),
            abort
        );
        await server.close();
        await expect(
            server.subscribe(
                async () => {},
                () => {}
            )
        ).rejects.toThrow('OpenCode server is closed');
        // A server whose signal was aborted from outside refuses as well.
        const other = new AbortController();
        const aborted = await startedServer(
            async (_input, init) => openStream(init?.signal),
            other
        );
        other.abort();
        await expect(
            aborted.subscribe(
                async () => {},
                () => {}
            )
        ).rejects.toThrow('OpenCode server is closed');
        await aborted.close();
    });

    test('closing waits for every event loop, not only the newest', async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let streams = 0;
        const server = await startedServer(async (_input, init) => {
            streams += 1;
            const first = streams === 1;
            return new Response(
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        if (first) {
                            controller.enqueue(
                                new TextEncoder().encode('data: {}\n\n')
                            );
                        }
                        init?.signal?.addEventListener('abort', () =>
                            controller.close()
                        );
                    },
                })
            );
        });
        await server.subscribe(
            () => gate,
            () => {}
        );
        await Bun.sleep(5);
        await server.subscribe(
            async () => {},
            () => {}
        );
        let closed = false;
        const closing = server.close().then(() => {
            closed = true;
        });
        await Bun.sleep(10);
        // The replaced stream's loop is still delivering an event.
        expect(closed).toBe(false);
        release();
        await closing;
        expect(closed).toBe(true);
    });
});

describe('OpenCodeServer requests through a sandbox edge', () => {
    test('resends a request the edge never delivered', async () => {
        const statuses = [522];
        let calls = 0;
        const server = await startedServer(async () => {
            calls += 1;
            const status = statuses.shift();
            return status
                ? new Response('error code: 522', { status })
                : new Response('{}');
        });
        try {
            const response = await server.request('/session', {
                method: 'POST',
                body: '{}',
            });
            expect(response.ok).toBe(true);
            expect(calls).toBe(2);
        } finally {
            await server.close();
        }
    });

    test('never resends a request that may have arrived', async () => {
        let calls = 0;
        const server = await startedServer(async () => {
            calls += 1;
            return new Response('error code: 520', { status: 520 });
        });
        try {
            await expect(
                server.request('/session', { method: 'POST', body: '{}' })
            ).rejects.toThrow();
            expect(calls).toBe(1);
        } finally {
            await server.close();
        }
    });

    test('stops waiting to resend once the server closes', async () => {
        let calls = 0;
        let answered = () => {};
        const first = new Promise<void>((resolve) => {
            answered = resolve;
        });
        const server = await startedServer(async () => {
            calls += 1;
            answered();
            return new Response('error code: 522', { status: 522 });
        });
        const pending = server.request('/session', { method: 'GET' });
        await first;
        await server.close();
        await expect(pending).rejects.toThrow();
        expect(calls).toBe(1);
    });
});
