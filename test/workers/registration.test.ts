import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RegistryAccountStore } from '../../src/registry/account-store.js';
import { RegistryClient } from '../../src/registry/client.js';
import { WorkerApi } from '../../src/workers/api.js';
import { WorkerHome } from '../../src/workers/home.js';
import { WorkerRegistration } from '../../src/workers/registration.js';
import { FakeWorkerServer, WORKER_KEY } from './fixture.js';

const LOGIN_KEY = 'wbcli_placeholder_login_key';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-worker-registration-'));
    const server = new FakeWorkerServer();
    cleanups.push(async () => {
        server.stop();
        await rm(directory, { recursive: true, force: true });
    });
    server.routes.set('POST /v1/workers', () =>
        Response.json(
            {
                worker: { id: 'wrk_1', slug: 'mini', name: 'mini', shared: false },
                key: WORKER_KEY,
            },
            { status: 201 }
        )
    );
    // The CLI's own `wb login` credential, held for one organization.
    const accounts = new RegistryAccountStore({
        home: directory,
        client: new RegistryClient({ home: directory, apiUrl: server.url }),
    });
    await accounts.save({
        organizationId: 'org_1',
        slug: 'acme',
        name: 'Acme',
        personal: false,
        token: LOGIN_KEY,
        keyId: 'key_1',
        scopes: [],
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const home = new WorkerHome(directory);
    return {
        server,
        home,
        accounts,
        registration: new WorkerRegistration(home, new WorkerApi(server.url)),
    };
}

describe('worker registration', () => {
    test("registers through the CLI's login key and stores the worker key owner-only", async () => {
        const { server, home, accounts, registration } = await setup();
        const record = await registration.ensure('mini', () => accounts.require());
        expect(record).toMatchObject({
            id: 'wrk_1',
            slug: 'mini',
            name: 'mini',
            organization: 'acme',
            key: WORKER_KEY,
            api_url: server.url,
        });
        expect(server.requests).toEqual([
            {
                method: 'POST',
                path: '/v1/workers',
                authorization: `Bearer ${LOGIN_KEY}`,
                body: JSON.stringify({ name: 'mini' }),
            },
        ]);
        expect((await stat(join(home.root, 'worker.json'))).mode & 0o777).toBe(0o600);
        expect((await stat(home.root)).mode & 0o777).toBe(0o700);
    });

    test('keeps a registered machine and refuses another name for it', async () => {
        const { server, accounts, registration } = await setup();
        await registration.ensure('mini', () => accounts.require());
        expect(
            (await registration.ensure(undefined, () => accounts.require())).name
        ).toBe('mini');
        expect((await registration.ensure('mini', () => accounts.require())).name).toBe(
            'mini'
        );
        expect(
            await registration
                .ensure('studio', () => accounts.require())
                .catch((error: Error) => error.message)
        ).toBe('This machine is already the worker mini. Run wb worker remove first.');
        expect(server.requests).toHaveLength(1);
    });

    test('needs a valid name and a login before calling the API', async () => {
        const { server, accounts, registration } = await setup();
        expect(
            await registration
                .ensure(undefined, () => accounts.require())
                .catch((error: Error) => error.message)
        ).toContain('wb worker start --name');
        expect(
            await registration
                .ensure('Mini Mac', () => accounts.require())
                .catch((error: Error) => error.message)
        ).toContain('lowercase');
        expect(
            await registration
                .ensure('mini', () => accounts.require('other'))
                .catch((error: Error) => error.message)
        ).toContain('wb login --org other');
        expect(server.requests).toEqual([]);
    });

    test('remove revokes the key, then forgets it', async () => {
        const { server, accounts, registration, home } = await setup();
        server.routes.set(
            'DELETE /v1/workers/self',
            () => new Response(null, { status: 204 })
        );
        await registration.ensure('mini', () => accounts.require());
        await registration.remove();
        expect(server.requests.at(-1)).toMatchObject({
            method: 'DELETE',
            path: '/v1/workers/self',
            authorization: `Bearer ${WORKER_KEY}`,
        });
        expect(await home.readRegistration()).toBeUndefined();
    });

    test('keeps the key when the API cannot revoke it', async () => {
        const { server, accounts, registration, home } = await setup();
        server.routes.set('DELETE /v1/workers/self', () =>
            Response.json({ error: { message: 'Try again later' } }, { status: 503 })
        );
        await registration.ensure('mini', () => accounts.require());
        expect(await registration.remove().catch((error: Error) => error.message)).toBe(
            'Try again later'
        );
        expect(await home.readRegistration()).toBeDefined();
    });

    test('rejects member ids that could leave the worker home', () => {
        const home = new WorkerHome('/tmp/home');
        expect(() => home.memberDirectory('../owner')).toThrow(
            'Invalid worker identifier'
        );
        expect(home.memberDirectory('mem_1')).toBe('/tmp/home/worker/members/mem_1');
    });
});
