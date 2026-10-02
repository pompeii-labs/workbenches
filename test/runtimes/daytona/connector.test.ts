import { describe, expect, test } from 'bun:test';

import { DaytonaConnector } from '../../../src/runtimes/daytona/connector.js';

function recording() {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({
            url: String(input),
            authorization: new Headers(init?.headers).get('authorization'),
        });
        return Response.json({ items: [] });
    }) as typeof fetch;
    return { fetcher, requests };
}

describe('DaytonaConnector', () => {
    test('opens a client that sends its key through the connector fetch', async () => {
        const { fetcher, requests } = recording();
        const client = new DaytonaConnector(fetcher).open('key-one');
        await client.listSandboxes({});
        expect(requests[0]?.authorization).toBe('Bearer key-one');
        expect(requests[0]?.url).toStartWith('https://app.daytona.io/api/sandbox');
    });

    test('uses the endpoint given for a client over the connector default', async () => {
        const { fetcher, requests } = recording();
        const connector = new DaytonaConnector(fetcher, 'https://default.test/api');
        await connector.open('key').listSandboxes({});
        await connector.open('key', 'https://other.test/api').listSandboxes({});
        expect(requests.map((request) => new URL(request.url).origin)).toEqual([
            'https://default.test',
            'https://other.test',
        ]);
    });

    test('opens an independent client for each key', async () => {
        const { fetcher, requests } = recording();
        const connector = new DaytonaConnector(fetcher);
        await connector.open('first').listSandboxes({});
        await connector.open('second').listSandboxes({});
        expect(requests.map((request) => request.authorization)).toEqual([
            'Bearer first',
            'Bearer second',
        ]);
    });
});
