import { DaytonaApi } from '../../../src/runtimes/daytona/api.js';

export interface Recorded {
    method: string;
    url: URL;
    headers: Headers;
    body: unknown;
}

export type Handler = (request: Recorded) => Response | Promise<Response>;

export function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

/** A fetch that records every request and answers from `handler`. */
export function fakeFetch(handler: Handler) {
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

export const toolbox = 'https://proxy.daytona.test/toolbox/sandbox-1';

export function client(handler: Handler, options: Record<string, unknown> = {}) {
    const { fetcher, requests } = fakeFetch(handler);
    return {
        requests,
        api: new DaytonaApi({
            apiKey: 'secret-api-key',
            fetch: fetcher,
            pollIntervalMs: 1,
            ...options,
        }),
    };
}

/** Answers a create and a start poll, then hands toolbox requests to `toolboxHandler`. */
export function sandboxHandler(toolboxHandler: Handler = () => json({})): Handler {
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

/** A started sandbox from an API that answers toolbox requests with `toolboxHandler`. */
export async function startedSandbox(
    toolboxHandler: Handler = () => json({}),
    options: Record<string, unknown> = {}
) {
    const { api, requests } = client(sandboxHandler(toolboxHandler), options);
    const sandbox = await api.createSandbox({
        image: 'debian:bookworm-slim',
        labels: {},
        leaseMinutes: 5,
    });
    return { sandbox, requests };
}
