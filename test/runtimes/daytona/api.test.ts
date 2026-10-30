import { describe, expect, test } from 'bun:test';

import { DaytonaApi } from '../../../src/runtimes/daytona/api.js';
import {
    DaytonaApiError,
    defaultDaytonaApiUrl,
} from '../../../src/runtimes/daytona/transport.js';
import { client, json, sandboxHandler } from './http.js';

const createOptions = {
    snapshot: 'wb-fixture',
    labels: { 'dev.workbenches.run': 'wb_x' },
    leaseMinutes: 5,
};

describe('DaytonaApi', () => {
    test('creates a sandbox from a snapshot and waits for it to start', async () => {
        const { api, requests } = client(sandboxHandler());
        const sandbox = await api.createSandbox({
            snapshot: 'wb-fixture',
            labels: { 'dev.workbenches.run': 'wb_x' },
            leaseMinutes: 60,
        });
        expect(sandbox.id).toBe('sandbox-1');
        const create = requests[0];
        expect(create?.method).toBe('POST');
        expect(create?.url.href).toBe(`${defaultDaytonaApiUrl}/sandbox`);
        expect(create?.headers.get('authorization')).toBe('Bearer secret-api-key');
        // Auto-stop is off and Daytona's wall-clock TTL bounds the sandbox's life.
        // Resources belong to the snapshot, and nothing is built.
        expect(JSON.parse(String(create?.body))).toEqual({
            snapshot: 'wb-fixture',
            labels: { 'dev.workbenches.run': 'wb_x' },
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
            api.createSandbox({ snapshot: 'wb-missing', labels: {}, leaseMinutes: 5 })
        ).rejects.toThrow('entered state build_failed: image not found');
        expect(requests.at(-1)?.method).toBe('DELETE');
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

    describe('sandbox lifecycle', () => {
        /** Answers lifecycle posts, and reports `states` in order on each lookup. */
        function lifecycle(states: string[]) {
            return client((request) => {
                if (request.method === 'POST') return json({});
                return json({
                    id: 'sandbox-1',
                    state: states.shift() ?? 'unknown',
                    toolboxProxyUrl: 'https://proxy.daytona.test/toolbox/',
                });
            });
        }

        test('starts a stopped sandbox and waits until it is started', async () => {
            const { api, requests } = lifecycle(['starting', 'started']);
            const sandbox = await api.startSandbox('sandbox-1');
            expect(sandbox.id).toBe('sandbox-1');
            expect(sandbox.state).toBe('started');
            expect(requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
                'POST /api/sandbox/sandbox-1/start',
                'GET /api/sandbox/sandbox-1',
                'GET /api/sandbox/sandbox-1',
            ]);
            expect(requests[0]?.headers.get('authorization')).toBe(
                'Bearer secret-api-key'
            );
        });

        test('stops a sandbox and waits until it is stopped', async () => {
            const { api, requests } = lifecycle(['stopping', 'stopped']);
            await api.stopSandbox('sandbox-1');
            expect(requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
                'POST /api/sandbox/sandbox-1/stop',
                'GET /api/sandbox/sandbox-1',
                'GET /api/sandbox/sandbox-1',
            ]);
        });

        test('fails a stop that ends in an error state', async () => {
            const { api } = lifecycle(['error']);
            await expect(api.stopSandbox('sandbox-1')).rejects.toThrow(
                'Daytona sandbox sandbox-1 entered state error'
            );
        });

        test('sets and clears the TTL and sets the auto-delete and auto-archive intervals', async () => {
            const { api, requests } = lifecycle([]);
            await api.setSandboxTtl('sandbox-1', 60);
            await api.setSandboxTtl('sandbox-1', 0);
            await api.setAutoDeleteInterval('sandbox-1', 10_080);
            await api.setAutoDeleteInterval('sandbox-1', -1);
            await api.setAutoArchiveInterval('sandbox-1', 10_081);
            expect(requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
                'POST /api/sandbox/sandbox-1/ttl/60',
                'POST /api/sandbox/sandbox-1/ttl/0',
                'POST /api/sandbox/sandbox-1/autodelete/10080',
                'POST /api/sandbox/sandbox-1/autodelete/-1',
                'POST /api/sandbox/sandbox-1/autoarchive/10081',
            ]);
            expect(requests.every((r) => r.body === undefined)).toBeTrue();
        });

        test('refuses an interval that is not a whole number of minutes', async () => {
            const { api, requests } = lifecycle([]);
            await expect(api.setSandboxTtl('sandbox-1', -1)).rejects.toThrow(
                'Invalid Daytona interval: -1 minutes'
            );
            await expect(api.setAutoDeleteInterval('sandbox-1', 1.5)).rejects.toThrow(
                'Invalid Daytona interval: 1.5 minutes'
            );
            expect(requests).toHaveLength(0);
        });
    });

    describe('snapshots', () => {
        const pinned = `ghcr.io/example/workbench@sha256:${'a'.repeat(64)}`;

        test('creates a snapshot from an image with its resources', async () => {
            const { api, requests } = client(() =>
                json({
                    id: 'snap-1',
                    name: 'wb-1',
                    state: 'pending',
                    imageName: pinned,
                })
            );
            expect(
                await api.createSnapshot({
                    name: 'wb-1',
                    image: pinned,
                    resources: { cpu: 2, memoryGb: 4, diskGb: 10 },
                })
            ).toEqual({ id: 'snap-1', name: 'wb-1', state: 'pending' });
            expect(requests[0]?.method).toBe('POST');
            expect(requests[0]?.url.href).toBe(`${defaultDaytonaApiUrl}/snapshots`);
            expect(JSON.parse(String(requests[0]?.body))).toEqual({
                name: 'wb-1',
                imageName: pinned,
                cpu: 2,
                memory: 4,
                disk: 10,
            });
        });

        test('joins the existing snapshot when the name is taken', async () => {
            const { api, requests } = client((request) =>
                request.method === 'POST'
                    ? json({ message: 'Snapshot with name wb-1 already exists' }, 409)
                    : json({ id: 'snap-0', name: 'wb-1', state: 'pulling' })
            );
            expect(
                await api.createSnapshot({ name: 'wb-1', image: pinned, resources: {} })
            ).toEqual({ id: 'snap-0', name: 'wb-1', state: 'pulling' });
            expect(requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
                'POST /api/snapshots',
                'GET /api/snapshots/wb-1',
            ]);
        });

        test('reads a snapshot by name with its error reason, and a missing one as absent', async () => {
            const { api } = client((request) =>
                request.url.pathname === '/api/snapshots/wb-1'
                    ? json({
                          id: 'snap-1',
                          name: 'wb-1',
                          state: 'build_failed',
                          errorReason: 'manifest unknown',
                      })
                    : json({ message: 'Snapshot with name wb-2 not found' }, 404)
            );
            expect(await api.getSnapshot('wb-1')).toEqual({
                id: 'snap-1',
                name: 'wb-1',
                state: 'build_failed',
                errorReason: 'manifest unknown',
            });
            expect(await api.getSnapshot('wb-2')).toBeUndefined();
        });

        test('refuses a snapshot reply without an id', async () => {
            const { api } = client(() => json({ name: 'wb-1', state: 'active' }));
            await expect(api.getSnapshot('wb-1')).rejects.toThrow(
                'Daytona returned a snapshot without an id or name'
            );
        });

        test('deletes a snapshot by its id, and a missing one is already gone', async () => {
            const { api, requests } = client((request) =>
                request.url.pathname === '/api/snapshots/wb-2'
                    ? json({ message: 'not found' }, 404)
                    : json({ id: 'snap-1', name: 'wb-1', state: 'error' })
            );
            await api.deleteSnapshot('wb-1');
            await api.deleteSnapshot('wb-2');
            expect(requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
                'GET /api/snapshots/wb-1',
                'DELETE /api/snapshots/snap-1',
                'GET /api/snapshots/wb-2',
            ]);
        });

        test('activates a snapshot by id and leaves one that is not inactive', async () => {
            const { api, requests } = client((request) =>
                request.method === 'POST'
                    ? json({ message: 'Snapshot is not in inactive state' }, 400)
                    : json({ id: 'snap-1', name: 'wb-1', state: 'inactive' })
            );
            await api.activateSnapshot('wb-1');
            expect(requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
                'GET /api/snapshots/wb-1',
                'POST /api/snapshots/snap-1/activate',
            ]);
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
