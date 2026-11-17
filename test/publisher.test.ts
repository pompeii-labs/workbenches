import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    RegistryAccountStore,
    RegistryClient,
    RegistryPublisher,
} from '../src/registry/index.js';

const homes: string[] = [];
afterEach(async () => {
    await Promise.all(
        homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))
    );
});

function stored(
    version: string,
    options: { prerelease?: boolean; withdrawn?: boolean } = {}
) {
    return {
        id: `id-${version}`,
        version,
        prerelease: false,
        withdrawn: false,
        published_at: null,
        provenance: null,
        images: [],
        ...options,
    };
}

async function fixture(
    versions: unknown = [stored('1.2.0')],
    options: {
        workbenchId?: boolean;
        wrongDigest?: boolean;
        wrongResolution?: boolean;
    } = {}
) {
    const home = await mkdtemp(join(tmpdir(), 'wb-publisher-'));
    homes.push(home);
    const requests: Array<{
        path: string;
        body: unknown;
        authorization: string | null;
    }> = [];
    const client = new RegistryClient({
        home,
        apiUrl: 'https://registry.example',
        fetch: async (input, init) => {
            const path = new URL(String(input)).pathname;
            const body: unknown =
                typeof init?.body === 'string' ? JSON.parse(init.body) : null;
            requests.push({
                path,
                body,
                authorization: new Headers(init?.headers).get('authorization'),
            });
            if (path === '/v1/workbenches/wb-id/versions')
                return Response.json({ versions });
            if (path === '/v1/resolutions') {
                const version =
                    !options.wrongResolution &&
                    typeof body === 'object' &&
                    body !== null &&
                    'version' in body
                        ? body.version
                        : '1.0.0';
                return Response.json({
                    ...(options.workbenchId === false ? {} : { workbench_id: 'wb-id' }),
                    visibility: 'public',
                    source_path: 'workbench.yml',
                    repository: null,
                    latest_version: {
                        id: `id-${version}`,
                        version,
                        digest: 'a'.repeat(64),
                        source_commit: 'b'.repeat(40),
                        artifact_url: null,
                    },
                });
            }
            if (path === '/v1/submissions')
                return Response.json({
                    submissions: [
                        {
                            id: 'submission-id',
                            status: 'pending',
                            publisher_slug: 'example',
                            slug: 'expert',
                            version: '1.2.0',
                            digest: (options.wrongDigest ? 'b' : 'a').repeat(64),
                            dashboard_url: 'https://registry.example/submissions/id',
                            latest_approved_version: '1.0.0',
                        },
                    ],
                });
            throw new Error(`Unexpected request: ${path}`);
        },
    });
    const accounts = new RegistryAccountStore({ home, client });
    await accounts.save({
        organizationId: 'org-id',
        slug: 'example',
        name: 'Example',
        token: 'wb_test_placeholder',
        keyId: 'key-id',
        expiresAt: '2099-01-01T00:00:00Z',
        personal: false,
        scopes: ['packages:write'],
    });
    const publisher = new RegistryPublisher(accounts);
    const resolve = (version?: string) =>
        publisher.resolveRelease(
            { publisher: 'example', workbench: 'expert' },
            { ...(version === undefined ? {} : { version }) }
        );
    return { publisher, requests, resolve };
}

test('publishing selects the newest stored release instead of the older approved resolution', async () => {
    const { publisher, requests, resolve } = await fixture();
    const { account, registry } = await resolve();
    expect(registry.version).toBe('1.2.0');
    await publisher.submit(account, {
        id: registry.versionId,
        digest: registry.digest,
    });
    expect(requests.map((request) => request.path)).toEqual([
        '/v1/resolutions',
        '/v1/workbenches/wb-id/versions',
        '/v1/resolutions',
        '/v1/submissions',
    ]);
    expect(requests[2]?.body).toEqual({
        publisher: 'example',
        workbench: 'expert',
        version: '1.2.0',
    });
    expect(requests[3]?.body).toEqual({ version_id: 'id-1.2.0' });
    expect(
        requests.every(
            (request) => request.authorization === 'Bearer wb_test_placeholder'
        )
    ).toBe(true);
});

test('semver order beats list order and skips prereleases and withdrawn releases', async () => {
    const { resolve } = await fixture([
        stored('2.0.0-rc.1', { prerelease: true }),
        stored('3.0.0', { withdrawn: true }),
        stored('1.9.0'),
        stored('1.10.0'),
    ]);
    expect((await resolve()).registry.version).toBe('1.10.0');
});

test('an explicit stored release is accepted even when a newer release exists', async () => {
    const { resolve } = await fixture([stored('1.3.0'), stored('1.2.0')]);
    expect((await resolve('1.2.0')).registry.version).toBe('1.2.0');
});

for (const [version, versions, message] of [
    ['2.0.0-rc.1', [stored('2.0.0-rc.1', { prerelease: true })], 'prerelease'],
    ['1.2.0', [stored('1.2.0', { withdrawn: true })], 'withdrawn'],
    ['1.2.0', [], 'not stored'],
] as const) {
    test(`explicit version is refused when ${message}`, async () => {
        const { resolve, requests } = await fixture(versions);
        await expect(resolve(version)).rejects.toThrow(message);
        expect(requests).toHaveLength(2);
    });
}

test('no stored release reports a clear error', async () => {
    const { resolve } = await fixture([
        stored('2.0.0-rc.1', { prerelease: true }),
        stored('1.2.0', { withdrawn: true }),
    ]);
    await expect(resolve()).rejects.toThrow('No stored release');
});

test('a missing Workbench id fails before listing versions', async () => {
    const { resolve, requests } = await fixture([], { workbenchId: false });
    await expect(resolve()).rejects.toThrow('Workbench id');
    expect(requests).toHaveLength(1);
});

for (const versions of [
    null,
    [{}],
    [stored('not-semver')],
    [{ ...stored('1.2.0'), withdrawn: 'false' }],
    [stored('1.2.0'), { ...stored('2.0.0'), id: 'id-1.2.0' }],
    [stored('1.2.0'), stored('1.2.0')],
]) {
    test('malformed version listings are refused', async () => {
        const { resolve } = await fixture(versions);
        await expect(resolve()).rejects.toThrow('malformed version');
    });
}

test('exact resolution must match the selected version', async () => {
    const { resolve } = await fixture(undefined, { wrongResolution: true });
    await expect(resolve()).rejects.toThrow('when 1.2.0 was asked for');
});

test('submission still checks the returned digest', async () => {
    const { resolve, publisher } = await fixture(undefined, { wrongDigest: true });
    const { account, registry } = await resolve();
    await expect(
        publisher.submit(account, { id: registry.versionId, digest: registry.digest })
    ).rejects.toThrow('different package digest');
});
