import { describe, expect, test } from 'bun:test';

import { DaytonaTransport } from '../../../src/runtimes/daytona/transport.js';
import { fakeFetch, json } from './http.js';

/** A transport whose fetch answers with `statuses` in order, then 200. */
function transport(statuses: Array<number | 'reset'>) {
    let call = 0;
    const { fetcher, requests } = fakeFetch(() => {
        const status = statuses[call++];
        if (status === 'reset') throw new TypeError('fetch failed');
        return status === undefined
            ? json({ ok: true })
            : new Response(`error code: ${status}`, { status });
    });
    return {
        requests,
        transport: new DaytonaTransport({
            apiKey: 'secret-api-key',
            fetch: fetcher,
            pollIntervalMs: 1,
        }),
    };
}

describe('DaytonaTransport', () => {
    test('resends any request the edge never delivered', async () => {
        for (const status of [521, 522, 523, 525]) {
            const { transport: client, requests } = transport([status, status]);
            const response = await client.request('POST', '/sandbox/s/stop');
            expect(response.status).toBe(200);
            expect(requests).toHaveLength(3);
        }
    });

    test('resends a repeatable request whose outcome is unknown', async () => {
        for (const status of [502, 503, 504, 520, 524, 'reset'] as const) {
            const { transport: client, requests } = transport([status]);
            await client.request('GET', '/sandbox/s');
            expect(requests).toHaveLength(2);
        }
        const { transport: client, requests } = transport([520]);
        await client.request('POST', '/toolbox/s/files/bulk-upload', {
            repeatable: true,
        });
        expect(requests).toHaveLength(2);
    });

    test('never resends a request that may have taken effect', async () => {
        for (const status of [520, 'reset'] as const) {
            const { transport: client, requests } = transport([status]);
            await expect(client.request('POST', '/sandbox')).rejects.toThrow();
            expect(requests).toHaveLength(1);
        }
    });

    test('never resends a refusal', async () => {
        const { transport: client, requests } = transport([400]);
        await expect(client.request('GET', '/sandbox/s')).rejects.toThrow();
        expect(requests).toHaveLength(1);
    });

    test('gives up after five attempts and says so', async () => {
        const { transport: client, requests } = transport([522, 522, 522, 522, 522]);
        await expect(client.request('GET', '/sandbox/s')).rejects.toThrow(
            'after 5 attempts'
        );
        expect(requests).toHaveLength(5);
    });

    test('never resends a request that ran out of time', async () => {
        const { fetcher, requests } = fakeFetch(() => new Promise<Response>(() => {}));
        const client = new DaytonaTransport({
            apiKey: 'secret-api-key',
            fetch: fetcher,
            pollIntervalMs: 1,
        });
        await expect(
            client.request('GET', '/sandbox/s', { timeoutMs: 5 })
        ).rejects.toMatchObject({ name: 'TimeoutError' });
        expect(requests).toHaveLength(1);
    });
});
