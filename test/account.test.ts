import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    RegistryAccountStore,
    RegistryClient,
    RegistryLogin,
} from '../src/registry/index.js';

const API = 'https://registry.example';
const temporaryDirectories: string[] = [];

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

afterEach(async () => {
    RegistryClient.configureApiUrl(undefined);
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('CLI registry login', () => {
    test('stores the approved organization and makes the first one default', async () => {
        const { accounts, client } = await store(loginFetch('alpha'));
        const first = await login(client, accounts);
        expect(first.isDefault).toBe(true);
        expect(first.account).toMatchObject({
            slug: 'alpha',
            keyId: 'key-alpha',
            email: 'person@example.com',
            scopes: ['catalog:read', 'packages:write'],
        });

        const second = await login(client, accounts, loginFetch('beta'));
        expect(second.isDefault).toBe(false);
        const held = await accounts.list();
        expect(held.defaultSlug).toBe('alpha');
        expect(held.organizations.map((entry) => entry.slug)).toEqual([
            'alpha',
            'beta',
        ]);
    });

    test('--org makes the organization default and replaces its entry', async () => {
        const { accounts, client } = await store();
        await login(client, accounts, loginFetch('alpha'));
        await login(client, accounts, loginFetch('beta'), 'beta');
        expect((await accounts.list()).defaultSlug).toBe('beta');
        await login(client, accounts, loginFetch('alpha', 'wb_new'), 'alpha');
        const held = await accounts.list();
        expect(held.defaultSlug).toBe('alpha');
        expect(held.organizations).toHaveLength(2);
        expect((await accounts.current('alpha'))?.token).toBe('wb_new');
    });

    test('--org mismatch fails without storing anything', async () => {
        const { accounts, client } = await store();
        await expect(
            login(client, accounts, loginFetch('alpha'), 'beta')
        ).rejects.toThrow('Approved organization alpha does not match --org beta');
        expect((await accounts.list()).organizations).toEqual([]);
    });

    test('--org mismatch revokes the new key, even if revoking fails', async () => {
        for (const revokeFails of [false, true]) {
            const { accounts, client } = await store();
            const inner = loginFetch('alpha');
            const deletes: Array<{ url: string; auth: string | null }> = [];
            const fetch: Fetcher = async (input, init) => {
                if (init?.method === 'DELETE') {
                    deletes.push({
                        url: String(input),
                        auth: new Headers(init.headers).get('authorization'),
                    });
                    if (revokeFails) throw new Error('offline');
                    return Response.json({ ok: true });
                }
                return inner(input, init);
            };
            await expect(login(client, accounts, fetch, 'beta')).rejects.toThrow(
                `does not match --org beta. Nothing was saved and the new key ${revokeFails ? 'could not be revoked' : 'was revoked'}`
            );
            expect(deletes).toEqual([
                { url: `${API}/v1/keys/key-alpha`, auth: 'Bearer wb_alpha' },
            ]);
            expect((await accounts.list()).organizations).toEqual([]);
        }
    });
});

describe('CLI registry account', () => {
    test('stores several organizations privately with one default', async () => {
        const { accounts, home } = await store();
        const alpha = key('alpha', { email: 'person@example.com' });
        const beta = key('beta');

        await accounts.save(alpha);
        await accounts.save(beta);

        expect((await stat(join(home, 'credentials.json'))).mode & 0o777).toBe(0o600);
        const held = await accounts.list();
        expect(held.defaultSlug).toBe('alpha');
        expect(held.organizations.map((entry) => entry.slug)).toEqual([
            'alpha',
            'beta',
        ]);
        expect(await accounts.current()).toEqual({ ...alpha, url: API });
        expect(await accounts.current('beta')).toEqual({ ...beta, url: API });
        expect(await accounts.current('missing')).toBeUndefined();

        await accounts.setDefault('beta');
        expect((await accounts.current())?.slug).toBe('beta');
        await expect(accounts.setDefault('missing')).rejects.toThrow(
            'Not signed in to organization missing. Held: alpha, beta'
        );

        await accounts.save({ ...alpha, token: 'wb_replaced' });
        expect((await accounts.current('alpha'))?.token).toBe('wb_replaced');
        expect((await accounts.list()).organizations).toHaveLength(2);
        expect((await accounts.list()).defaultSlug).toBe('beta');

        await accounts.save(alpha, { makeDefault: true });
        expect((await accounts.list()).defaultSlug).toBe('alpha');

        await accounts.remove('alpha');
        expect((await accounts.list()).defaultSlug).toBe('beta');
        expect(await accounts.require('beta')).toMatchObject({ slug: 'beta' });
    });

    test('keeps separate organization lists per API URL', async () => {
        const { accounts, home } = await store();
        await accounts.save(key('alpha'));
        RegistryClient.configureApiUrl('https://other.example');
        const other = new RegistryAccountStore({ home, client: new RegistryClient() });
        expect((await other.list()).organizations).toEqual([]);
        await other.save(key('gamma'));
        expect((await other.list()).defaultSlug).toBe('gamma');
        expect((await accounts.list()).defaultSlug).toBe('alpha');
    });

    test('discards a version 1 file and tells the user to log in again', async () => {
        const { accounts, home } = await store();
        await writeFile(
            join(home, 'credentials.json'),
            JSON.stringify({
                version: 1,
                accounts: [
                    {
                        url: API,
                        token: `wb_${'a'.repeat(64)}`,
                        tokenId: 'token-1',
                        email: 'person@example.com',
                        expiresAt: '2099-01-01T00:00:00.000Z',
                    },
                ],
            })
        );
        expect(await accounts.current()).toBeUndefined();
        expect((await accounts.list()).organizations).toEqual([]);
        await expect(accounts.require()).rejects.toThrow('Run wb login once');

        await accounts.save(key('alpha'));
        const file = JSON.parse(await readFile(join(home, 'credentials.json'), 'utf8'));
        expect(file.version).toBe(2);
        expect(JSON.stringify(file)).not.toContain('token-1');
        expect((await accounts.require()).slug).toBe('alpha');
    });

    test('rejects expired keys and unheld organizations', async () => {
        const { accounts } = await store();
        await expect(accounts.require()).rejects.toThrow('Sign in first with wb login');
        await accounts.save(key('alpha', { expiresAt: '2000-01-01T00:00:00Z' }));
        await expect(accounts.require()).rejects.toThrow('expired');
        await expect(accounts.require('beta')).rejects.toThrow(
            'Not signed in to organization beta. Held: alpha'
        );
    });

    test('logout revokes the key, then clears the file with the last entry', async () => {
        const requests: Array<{ url: string; method: string; auth: string | null }> =
            [];
        const { accounts, home } = await store(async (input, init) => {
            requests.push({
                url: String(input),
                method: init?.method ?? 'GET',
                auth: new Headers(init?.headers).get('authorization'),
            });
            return Response.json({ ok: true });
        });
        await accounts.save(key('alpha'));
        await accounts.save(key('beta'));

        const second = await accounts.signOut('beta');
        expect(second).toMatchObject({ revoked: true, cleared: false });
        expect(requests).toEqual([
            {
                url: `${API}/v1/keys/beta-key`,
                method: 'DELETE',
                auth: 'Bearer wb_beta',
            },
        ]);
        expect(
            (await accounts.list()).organizations.map((entry) => entry.slug)
        ).toEqual(['alpha']);

        const last = await accounts.signOut();
        expect(last).toMatchObject({ revoked: true, cleared: true });
        expect(requests[1]?.url).toBe(`${API}/v1/keys/alpha-key`);
        await expect(stat(join(home, 'credentials.json'))).rejects.toThrow();
        expect(await accounts.signOut()).toBeUndefined();
    });

    test('logout still removes the entry when revocation fails', async () => {
        const { accounts } = await store(async () => {
            throw new Error('offline');
        });
        await accounts.save(key('alpha'));
        expect(await accounts.signOut()).toMatchObject({
            revoked: false,
            cleared: true,
        });
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

async function store(fetch?: Fetcher) {
    const home = await temporaryDirectory();
    RegistryClient.configureApiUrl(API);
    const client = new RegistryClient(fetch ? { fetch } : {});
    return { home, client, accounts: new RegistryAccountStore({ home, client }) };
}

function key(slug: string, extra: { email?: string; expiresAt?: string } = {}) {
    return {
        organizationId: `org-${slug}`,
        slug,
        name: slug.toUpperCase(),
        personal: false,
        token: `wb_${slug}`,
        keyId: `${slug}-key`,
        scopes: ['catalog:read', 'packages:write'],
        expiresAt: extra.expiresAt ?? '2099-01-01T00:00:00Z',
        ...(extra.email ? { email: extra.email } : {}),
    };
}

function login(
    client: RegistryClient,
    accounts: RegistryAccountStore,
    fetch?: Fetcher,
    organization?: string
) {
    const active = fetch ? new RegistryClient({ fetch }) : client;
    return new RegistryLogin({
        client: active,
        accounts: new RegistryAccountStore({ home: accounts.home, client: active }),
        ...(organization ? { organization } : {}),
        wait: async () => undefined,
    }).run();
}

function loginFetch(slug: string, token = `wb_${slug}`): Fetcher {
    let polls = 0;
    return async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === '/v1/logins') {
            return Response.json({
                id: 'login-1',
                code: 'ABCD',
                secret: 'secret',
                verification_url: `${API}/cli/login`,
                expires_at: '2099-01-01T00:00:00Z',
                interval: 0,
            });
        }
        if (path === '/v1/tokens') {
            polls += 1;
            if (polls === 1) return Response.json({ status: 'pending' });
            return Response.json({
                status: 'complete',
                token,
                key_id: `key-${slug}`,
                organization: { id: `org-${slug}`, slug, name: slug, personal: false },
                scopes: ['catalog:read', 'packages:write'],
                expires_at: '2099-01-01T00:00:00Z',
            });
        }
        if (path === '/v1/profile') {
            return Response.json({
                organization: { id: `org-${slug}`, slug, name: slug, personal: false },
                user: { id: 'user-1', email: 'person@example.com' },
                scopes: ['catalog:read', 'packages:write'],
                key: {
                    id: `key-${slug}`,
                    label: null,
                    expires_at: '2099-01-01T00:00:00Z',
                },
            });
        }
        return new Response('unexpected', { status: 500 });
    };
}

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-account-'));
    temporaryDirectories.push(directory);
    return directory;
}
