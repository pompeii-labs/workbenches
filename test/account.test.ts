import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RegistryAccountStore, RegistryClient } from '../src/registry/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    RegistryClient.configureApiUrl(undefined);
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('CLI registry account', () => {
    test('stores credentials privately without printing or exposing the token', async () => {
        const home = await temporaryDirectory();
        const account = {
            url: 'https://registry.example',
            token: `wb_${'a'.repeat(64)}`,
            tokenId: '018f1e48-7fb2-7a12-a4dd-0123456789ab',
            email: 'person@example.com',
            expiresAt: '2027-08-21T00:00:00.000Z',
        };
        RegistryClient.configureApiUrl(account.url);
        const accounts = new RegistryAccountStore({
            home,
            client: new RegistryClient(),
        });

        await accounts.save(account);

        expect(await accounts.current()).toEqual(account);
        expect((await stat(join(home, 'credentials.json'))).mode & 0o777).toBe(0o600);
        await accounts.remove();
        expect(await accounts.current()).toBeUndefined();
    });

    test('sends bearer credentials and surfaces safe API errors', async () => {
        RegistryClient.configureApiUrl('https://registry.example');
        const requests: RequestInit[] = [];
        const client = new RegistryClient({
            fetch: async (_input, init) => {
                requests.push(init ?? {});
                return Response.json({ ok: true });
            },
        });
        const value = await client.request<{ ok: boolean }>('/v1/profile', {
            token: `wb_${'a'.repeat(64)}`,
        });
        expect(value).toEqual({ ok: true });
        expect(new Headers(requests[0]?.headers).get('authorization')).toBe(
            `Bearer wb_${'a'.repeat(64)}`
        );

        const unauthorized = new RegistryClient({
            fetch: async () =>
                Response.json({ error: { message: 'Sign in again' } }, { status: 401 }),
        });
        await expect(unauthorized.request('/v1/profile')).rejects.toThrow(
            'Sign in again'
        );
    });
});

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-account-'));
    temporaryDirectories.push(directory);
    return directory;
}
