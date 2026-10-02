import { describe, expect, test } from 'bun:test';

import { DaytonaApi } from '../../../src/runtimes/daytona/api.js';
import {
    DaytonaApiError,
    defaultDaytonaApiUrl,
} from '../../../src/runtimes/daytona/transport.js';
import { client, json, sandboxHandler } from './http.js';

const createOptions = {
    image: 'debian:bookworm-slim',
    labels: { 'dev.workbenches.run': 'wb_x' },
    leaseMinutes: 5,
};

describe('DaytonaApi', () => {
    test('creates a sandbox from an image and waits for it to start', async () => {
        const { api, requests } = client(sandboxHandler());
        const sandbox = await api.createSandbox({
            image: 'debian:bookworm-slim',
            labels: { 'dev.workbenches.run': 'wb_x' },
            resources: { cpu: 2, memoryGb: 4, diskGb: 10 },
            leaseMinutes: 60,
        });
        expect(sandbox.id).toBe('sandbox-1');
        const create = requests[0];
        expect(create?.method).toBe('POST');
        expect(create?.url.href).toBe(`${defaultDaytonaApiUrl}/sandbox`);
        expect(create?.headers.get('authorization')).toBe('Bearer secret-api-key');
        // Auto-stop is off and Daytona's wall-clock TTL bounds the sandbox's life.
        expect(JSON.parse(String(create?.body))).toEqual({
            buildInfo: { dockerfileContent: 'FROM debian:bookworm-slim' },
            labels: { 'dev.workbenches.run': 'wb_x' },
            cpu: 2,
            memory: 4,
            disk: 10,
            autoStopInterval: 0,
            ttlMinutes: 60,
        });
        expect(requests.at(-1)?.url.pathname).toBe('/api/sandbox/sandbox-1');
    });

    test('honors a custom API URL', async () => {
        const { api, requests } = client(() => json({ items: [] }), {
            apiUrl: 'https://daytona.internal.test/api/',
        });
        await api.listSandboxes({});
        expect(requests[0]?.url.href).toStartWith(
            'https://daytona.internal.test/api/sandbox?'
        );
    });

    test('deletes a sandbox that fails to start and reports why', async () => {
        const { api, requests } = client((request) => {
            if (request.method === 'POST') return json({ id: 'sandbox-1' });
            if (request.method === 'DELETE') return json({});
            return json({
                id: 'sandbox-1',
                state: 'build_failed',
                errorReason: 'image not found',
            });
        });
        await expect(
            api.createSandbox({ image: 'missing:1', labels: {}, leaseMinutes: 5 })
        ).rejects.toThrow('entered state build_failed: image not found');
        expect(requests.at(-1)?.method).toBe('DELETE');
    });

    test('refuses an image reference with whitespace', async () => {
        const { api, requests } = client(sandboxHandler());
        await expect(
            api.createSandbox({ ...createOptions, image: 'debian bookworm' })
        ).rejects.toMatchObject({
            name: 'RuntimeError',
            runtime: 'daytona',
            message: 'Invalid Daytona image reference: "debian bookworm"',
        });
        expect(requests).toHaveLength(0);
    });

    describe('when a create request fails without a usable reply', () => {
        function leaking(
            create: () => Response | Promise<Response>,
            options: Record<string, unknown> = {}
        ) {
            const listed: string[] = [];
            const deleted: string[] = [];
            const { api, requests } = client((request) => {
                const path = request.url.pathname;
                if (request.method === 'POST' && path === '/api/sandbox')
                    return create();
                if (request.method === 'GET' && path === '/api/sandbox') {
                    listed.push(request.url.searchParams.get('labels') ?? '');
                    return json({
                        items: [{ id: 'leaked', labels: createOptions.labels }],
                    });
                }
                if (request.method === 'DELETE') {
                    deleted.push(path);
                    return json({});
                }
                return json({}, 404);
            }, options);
            return { api, requests, listed, deleted };
        }

        test('deletes the sandbox carrying the run labels after a timeout', async () => {
            const { api, listed, deleted } = leaking(() => new Promise(() => {}), {
                requestTimeoutMs: 20,
            });
            await expect(api.createSandbox(createOptions)).rejects.toThrow();
            expect(listed.map((value) => JSON.parse(value))).toEqual([
                createOptions.labels,
            ]);
            expect(deleted).toEqual(['/api/sandbox/leaked']);
        });

        test('deletes the sandbox carrying the run labels after an unreadable reply', async () => {
            const { api, listed, deleted } = leaking(
                () => new Response('<html>gateway</html>', { status: 200 })
            );
            await expect(api.createSandbox(createOptions)).rejects.toThrow();
            expect(listed.map((value) => JSON.parse(value))).toEqual([
                createOptions.labels,
            ]);
            expect(deleted).toEqual(['/api/sandbox/leaked']);
        });

        test('deletes the sandbox after a gateway error', async () => {
            const { api, deleted } = leaking(() => json({ message: 'timeout' }, 504));
            await expect(api.createSandbox(createOptions)).rejects.toThrow(
                'failed with 504'
            );
            expect(deleted).toEqual(['/api/sandbox/leaked']);
        });

        test('looks for nothing after Daytona refuses the request', async () => {
            const { api, requests } = leaking(() =>
                json({ message: 'invalid image' }, 400)
            );
            await expect(api.createSandbox(createOptions)).rejects.toThrow(
                'failed with 400'
            );
            expect(requests).toHaveLength(1);
        });

        test('names the labels when the sandbox cannot be removed', async () => {
            const { api } = client((request) => {
                if (request.method === 'POST') {
                    return new Response('<html>gateway</html>', { status: 200 });
                }
                return json({ message: 'down' }, 500);
            });
            const error = await api.createSandbox(createOptions).catch((e) => e);
            expect(error.name).toBe('RuntimeError');
            expect(error.message).toContain('could not be removed');
            expect(error.message).toContain('{"dev.workbenches.run":"wb_x"}');
            expect(error.message).not.toContain('secret-api-key');
        });
    });

    test('lists sandboxes by label across pages', async () => {
        const { api, requests } = client((request) => {
            const cursor = request.url.searchParams.get('cursor');
            return json(
                cursor
                    ? { items: [{ id: 'b', labels: { k: 'v' }, state: 'stopped' }] }
                    : {
                          items: [{ id: 'a', labels: { k: 'v' }, state: 'started' }],
                          nextCursor: 'page-2',
                      }
            );
        });
        expect(await api.listSandboxes({ k: 'v' })).toEqual([
            { id: 'a', labels: { k: 'v' }, state: 'started' },
            { id: 'b', labels: { k: 'v' }, state: 'stopped' },
        ]);
        expect(JSON.parse(requests[0]?.url.searchParams.get('labels') ?? '')).toEqual({
            k: 'v',
        });
    });

    test('treats a missing sandbox as absent and a deleted one as gone', async () => {
        const { api } = client(() => json({ message: 'not found' }, 404));
        expect(await api.getSandbox('missing')).toBeUndefined();
        await expect(api.deleteSandbox('missing')).resolves.toBeUndefined();
    });

    test('never includes the API key in an error', async () => {
        const { api } = client(() => json({ message: 'nope' }, 500));
        const error = await api.deleteSandbox('sandbox-1').catch((value) => value);
        expect(error).toBeInstanceOf(DaytonaApiError);
        expect(error.status).toBe(500);
        expect(error.message).toContain(
            'DELETE /api/sandbox/sandbox-1 failed with 500'
        );
        expect(error.message).not.toContain('secret-api-key');
    });

    test('bounds every request with a timeout', async () => {
        const { api } = client(() => new Promise<Response>(() => {}), {
            requestTimeoutMs: 20,
        });
        const started = Date.now();
        await expect(api.listSandboxes({})).rejects.toThrow();
        expect(Date.now() - started).toBeLessThan(2_000);
    });

    test('requires an API key', () => {
        expect(() => new DaytonaApi({ apiKey: '  ', fetch })).toThrow(
            'A Daytona API key is required'
        );
    });

    test('calls the injected fetch with an undefined this', async () => {
        // Some runtimes throw "Illegal invocation" when a Web platform function
        // runs with a `this` other than undefined. Node and Bun do not, so this
        // fetch enforces it the way those runtimes do.
        const calls: string[] = [];
        const strict = function (this: unknown, input: string | URL | Request) {
            if (this !== undefined) throw new TypeError('Illegal invocation');
            calls.push(String(input));
            return Promise.resolve(json({ items: [] }));
        } as typeof fetch;
        const api = new DaytonaApi({
            apiKey: 'key',
            apiUrl: 'https://daytona.test/api',
            fetch: strict,
        });
        expect(await api.listSandboxes({})).toEqual([]);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toContain('https://daytona.test/api/sandbox');
    });
});
