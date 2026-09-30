import { describe, expect, test } from 'bun:test';

import {
    DaytonaApiClient,
    DaytonaApiError,
    defaultDaytonaApiUrl,
} from '../src/runtimes/daytona/api-client.js';

interface Recorded {
    method: string;
    url: URL;
    headers: Headers;
    body: unknown;
}

type Handler = (request: Recorded) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

/** A fetch that records every request and answers from `handler`. */
function fakeFetch(handler: Handler) {
    const requests: Recorded[] = [];
    const fetcher = (async (input: URL | string, init: RequestInit = {}) => {
        const recorded: Recorded = {
            method: init.method ?? 'GET',
            url: new URL(String(input)),
            headers: new Headers(init.headers),
            body: init.body,
        };
        requests.push(recorded);
        const aborted = new Promise<never>((_, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        });
        return Promise.race([Promise.resolve(handler(recorded)), aborted]);
    }) as typeof fetch;
    return { fetcher, requests };
}

const toolbox = 'https://proxy.daytona.test/toolbox/sandbox-1';

function client(handler: Handler, options: Record<string, unknown> = {}) {
    const { fetcher, requests } = fakeFetch(handler);
    return {
        requests,
        api: new DaytonaApiClient({
            apiKey: 'secret-api-key',
            fetch: fetcher,
            pollIntervalMs: 1,
            ...options,
        }),
    };
}

/** Answers a create and a start poll, then hands toolbox requests to `toolboxHandler`. */
function sandboxHandler(toolboxHandler: Handler = () => json({})): Handler {
    return (request) => {
        const path = request.url.pathname;
        if (request.method === 'POST' && path === '/api/sandbox') {
            return json({ id: 'sandbox-1', state: 'pending_build', labels: {} });
        }
        if (request.method === 'GET' && path === '/api/sandbox/sandbox-1') {
            return json({
                id: 'sandbox-1',
                state: 'started',
                cpu: 2,
                memory: 4,
                disk: 10,
                createdAt: '2026-09-30T12:00:00.000Z',
                toolboxProxyUrl: 'https://proxy.daytona.test/toolbox/',
            });
        }
        return toolboxHandler(request);
    };
}

describe('Daytona API client', () => {
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

    test('reads the toolbox URL from its endpoint when the sandbox omits it', async () => {
        const { api, requests } = client((request) => {
            const path = request.url.pathname;
            if (request.method === 'POST' && path === '/api/sandbox') {
                return json({ id: 'sandbox-1' });
            }
            if (path === '/api/sandbox/sandbox-1') {
                return json({ id: 'sandbox-1', state: 'started' });
            }
            if (path === '/api/sandbox/sandbox-1/toolbox-proxy-url') {
                return json({ url: 'https://proxy.daytona.test/toolbox' });
            }
            if (path === '/toolbox/sandbox-1/process/execute') {
                return json({ exitCode: 0, result: 'ok' });
            }
            return json({}, 404);
        });
        const sandbox = await api.createSandbox({
            image: 'debian:bookworm-slim',
            labels: {},
            leaseMinutes: 5,
        });
        await sandbox.run('true');
        expect(requests.at(-1)?.url.href).toBe(`${toolbox}/process/execute`);
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

    test('runs a command to completion with directory and environment', async () => {
        const { api, requests } = client(
            sandboxHandler(() => json({ exitCode: 7, result: 'partial' }))
        );
        const sandbox = await api.createSandbox({
            image: 'debian:bookworm-slim',
            labels: {},
            leaseMinutes: 5,
        });
        const result = await sandbox.run('echo hi', {
            cwd: '/workspace',
            env: { A: 'b' },
        });
        expect(result).toEqual({ code: 7, stdout: 'partial', stderr: '' });
        const call = requests.at(-1);
        expect(call?.url.href).toBe(`${toolbox}/process/execute`);
        const body = JSON.parse(String(call?.body));
        expect(body.command).toBe('{\necho hi\n} 2>&1');
        expect(body.cwd).toBe('/workspace');
        expect(body.envs).toEqual({ A: 'b' });
        expect(body.timeout).toBeGreaterThan(0);
    });

    test('runs as root through sudo when the sandbox user is not root', async () => {
        const { api, requests } = client(
            sandboxHandler(() => json({ exitCode: 0, result: '' }))
        );
        const sandbox = await api.createSandbox({
            image: 'debian:bookworm-slim',
            labels: {},
            leaseMinutes: 5,
        });
        await sandbox.run('mkdir -p /workspace', { user: 'root' });
        const body = JSON.parse(String(requests.at(-1)?.body));
        expect(body.command).toContain('id -u');
        expect(body.command).toContain('sudo -n');
        expect(body.command).toContain("sh -c 'mkdir -p /workspace'");
    });

    test('streams a background command by following its logs', async () => {
        let polls = 0;
        const { api, requests } = client(
            sandboxHandler((request) => {
                const path = request.url.pathname.replace('/toolbox/sandbox-1', '');
                if (path === '/process/session') return json({});
                if (path.endsWith('/exec')) return json({ cmdId: 'cmd-1' });
                if (path.endsWith('/logs')) {
                    polls++;
                    return json({
                        stdout: polls < 2 ? 'one' : 'one two',
                        stderr: polls < 2 ? '' : 'warn',
                    });
                }
                if (path.endsWith('/command/cmd-1')) {
                    return json(polls >= 2 ? { exitCode: 0 } : {});
                }
                return json({});
            })
        );
        const sandbox = await api.createSandbox({
            image: 'debian:bookworm-slim',
            labels: {},
            leaseMinutes: 5,
        });
        const out: string[] = [];
        const err: string[] = [];
        const process = await sandbox.start('opencode serve', {
            cwd: '/workspace',
            env: { TOKEN: "it's" },
            onStdout: (data) => void out.push(data),
            onStderr: (data) => void err.push(data),
        });
        expect(await process.wait()).toEqual({
            code: 0,
            stdout: 'one two',
            stderr: 'warn',
        });
        expect(out.join('')).toBe('one two');
        expect(out.length).toBeGreaterThan(1);
        expect(err.join('')).toBe('warn');
        const exec = requests.find((request) => request.url.pathname.endsWith('/exec'));
        const body = JSON.parse(String(exec?.body));
        expect(body.runAsync).toBe(true);
        expect(body.command).toBe(
            `(export TOKEN='it'"'"'s' && cd '/workspace' && opencode serve)`
        );
        // The session is removed once the command ends.
        expect(requests.at(-1)?.method).toBe('DELETE');
    });

    test('sends input to a background command and kills it by ending its session', async () => {
        const { api, requests } = client(
            sandboxHandler((request) => {
                const path = request.url.pathname.replace('/toolbox/sandbox-1', '');
                if (path.endsWith('/exec')) return json({ cmdId: 'cmd-1' });
                if (path.endsWith('/logs')) return json({ stdout: '', stderr: '' });
                return json({});
            })
        );
        const sandbox = await api.createSandbox({
            image: 'debian:bookworm-slim',
            labels: {},
            leaseMinutes: 5,
        });
        const process = await sandbox.start('cat', { stdin: true });
        await process.sendStdin('hello\n');
        const input = requests.find((request) =>
            request.url.pathname.endsWith('/input')
        );
        expect(JSON.parse(String(input?.body))).toEqual({ data: 'hello\n' });
        await process.kill();
        expect((await process.wait()).code).toBe(143);
        expect(requests.some((request) => request.method === 'DELETE')).toBeTrue();
    });

    test('uploads a file as multipart form data', async () => {
        const { api, requests } = client(sandboxHandler(() => json({})));
        const sandbox = await api.createSandbox({
            image: 'debian:bookworm-slim',
            labels: {},
            leaseMinutes: 5,
        });
        await sandbox.upload('/tmp/input.tar.gz', new TextEncoder().encode('bytes'));
        const call = requests.at(-1);
        expect(call?.url.href).toBe(`${toolbox}/files/bulk-upload`);
        const form = call?.body as FormData;
        expect(form.get('files[0].path')).toBe('/tmp/input.tar.gz');
        expect(await (form.get('files[0].file') as Blob).text()).toBe('bytes');
    });

    test('downloads a file as a stream', async () => {
        const { api, requests } = client(
            sandboxHandler((request) =>
                request.url.pathname.endsWith('/files/download')
                    ? new Response('remote bytes')
                    : json({})
            )
        );
        const sandbox = await api.createSandbox({
            image: 'debian:bookworm-slim',
            labels: {},
            leaseMinutes: 5,
        });
        const stream = await sandbox.download('/outbox/report.txt');
        expect(await new Response(stream).text()).toBe('remote bytes');
        expect(requests.at(-1)?.url.searchParams.get('path')).toBe(
            '/outbox/report.txt'
        );
    });

    test('asks for a signed preview URL for a port', async () => {
        const { api, requests } = client(
            sandboxHandler((request) =>
                request.url.pathname.endsWith('/signed-preview-url')
                    ? json({ url: 'https://4096-abc.proxy.daytona.test' })
                    : json({})
            )
        );
        const sandbox = await api.createSandbox({
            image: 'debian:bookworm-slim',
            labels: {},
            leaseMinutes: 5,
        });
        await expect(sandbox.previewUrl(4096, 3_600)).resolves.toBe(
            'https://4096-abc.proxy.daytona.test'
        );
        const call = requests.at(-1);
        expect(call?.url.pathname).toBe(
            '/api/sandbox/sandbox-1/ports/4096/signed-preview-url'
        );
        expect(call?.url.searchParams.get('expiresInSeconds')).toBe('3600');
    });

    test('reports sandbox size from its description', async () => {
        const { api } = client(sandboxHandler());
        const sandbox = await api.createSandbox({
            image: 'debian:bookworm-slim',
            labels: {},
            leaseMinutes: 5,
        });
        expect(await sandbox.info()).toEqual({
            cpuCount: 2,
            memoryMB: 4_096,
            diskGb: 10,
            createdAt: new Date('2026-09-30T12:00:00.000Z'),
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
        expect(() => new DaytonaApiClient({ apiKey: '  ' })).toThrow(
            'A Daytona API key is required'
        );
    });
});
