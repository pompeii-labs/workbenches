import { afterEach, expect, spyOn, test } from 'bun:test';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { runCommand } from 'citty';
import { pack } from 'tar-stream';
import { pushCommand } from '../src/commands/image.js';
import { RegistryClient, RegistryImagePublisher } from '../src/registry/index.js';

afterEach(() => {
    RegistryClient.configureApiUrl(undefined);
});

test('image push resolves the exact version with the organization key before exporting', async () => {
    const requests: string[] = [];
    const registry = new RegistryClient({
        fetch: async (input, init) => {
            requests.push(new URL(String(input)).pathname);
            expect(JSON.parse(String(init?.body))).toEqual({
                publisher: 'example',
                workbench: 'expert',
                version: '1.0.0+build.7',
            });
            expect(new Headers(init?.headers).get('authorization')).toBe(
                'Bearer placeholder'
            );
            return Response.json({ error: { message: 'Not found' } }, { status: 404 });
        },
    });
    let exports = 0;
    const publisher = new RegistryImagePublisher({
        account: {
            url: registry.apiUrl,
            organizationId: 'org',
            slug: 'example',
            name: 'Example',
            personal: false,
            token: 'placeholder',
            keyId: 'key',
            scopes: [],
            expiresAt: '2099-01-01',
        },
        registry,
        run: async () => {
            exports += 1;
            throw new Error('Unexpected export');
        },
        fetch: Object.assign(
            async () => {
                throw new Error('Unexpected upload');
            },
            { preconnect: fetch.preconnect }
        ),
    });
    await expect(
        publisher.push({
            image: 'local',
            reference: {
                publisher: 'example',
                workbench: 'expert',
                version: '1.0.0+build.7',
            },
            client: 'docker',
        })
    ).rejects.toThrow('wb push first');
    expect(requests).toEqual(['/v1/resolutions']);
    expect(exports).toBe(0);
});

test('image push rejects removed flags and mismatched organizations before requests', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wb-image-flags-'));
    const previousHome = process.env.WORKBENCH_HOME;
    process.env.WORKBENCH_HOME = home;
    const fetcher = spyOn(globalThis, 'fetch').mockImplementation(
        Object.assign(
            async () => {
                throw new Error('Unexpected request');
            },
            { preconnect: fetch.preconnect }
        )
    );
    try {
        for (const flag of ['--as', '--tag']) {
            await expect(
                runCommand(pushCommand, {
                    rawArgs: [
                        'local',
                        flag,
                        'old',
                        '--client',
                        '/unavailable/fake-client',
                    ],
                })
            ).rejects.toThrow('wb image push <local image> <org/name@version>');
        }
        await expect(
            runCommand(pushCommand, {
                rawArgs: [
                    'local',
                    'example/expert@1.0.0',
                    '--org',
                    'other',
                    '--client',
                    '/unavailable/fake-client',
                ],
            })
        ).rejects.toThrow('--org other does not match example/expert');
        expect(fetcher).not.toHaveBeenCalled();
    } finally {
        fetcher.mockRestore();
        if (previousHome === undefined) delete process.env.WORKBENCH_HOME;
        else process.env.WORKBENCH_HOME = previousHome;
        await rm(home, { recursive: true, force: true });
    }
});

test('image push targets the version tag, reuses blobs, and preserves OCI refusals', async () => {
    for (const refusal of [undefined, 'This version tag already has an image']) {
        const events: string[] = [];
        const fetcher = Object.assign(
            async (input: string | URL | Request, init?: RequestInit) => {
                const path = new URL(String(input)).pathname;
                events.push(`${init?.method ?? 'GET'} ${path}`);
                if (path === '/v1/resolutions')
                    return Response.json({
                        source_path: 'workbench.yml',
                        repository: null,
                        visibility: 'private',
                        latest_version: {
                            id: 'version-id',
                            version: '1.0.0+build.7',
                            digest: 'a'.repeat(64),
                            source_commit: 'b'.repeat(40),
                        },
                    });
                if (path === '/v2/auth')
                    return Response.json({ token: 'placeholder-oci' });
                if (init?.method === 'HEAD') return new Response(null, { status: 200 });
                if (path === '/v2/example/expert/manifests/1.0.0_build.7')
                    return refusal
                        ? Response.json(
                              { errors: [{ code: 'DENIED', message: refusal }] },
                              { status: 409 }
                          )
                        : new Response(null, { status: 201 });
                throw new Error(`Unexpected request ${path}`);
            },
            { preconnect: fetch.preconnect }
        );
        const registry = new RegistryClient({ fetch: fetcher });
        const publisher = new RegistryImagePublisher({
            registry,
            fetch: fetcher,
            account: {
                url: registry.apiUrl,
                organizationId: 'org',
                slug: 'example',
                name: 'Example',
                personal: false,
                token: 'placeholder',
                keyId: 'key',
                scopes: [],
                expiresAt: '2099-01-01',
            },
            run: async (_client, args) => {
                events.push('export');
                const path = args[3];
                if (!path) throw new Error('Missing fake archive path');
                await fakeArchive(path);
            },
        });
        const result = publisher.push({
            image: 'local',
            reference: {
                publisher: 'example',
                workbench: 'expert',
                version: '1.0.0+build.7',
            },
            client: 'fake-client',
        });
        if (refusal) await expect(result).rejects.toThrow(new Error(refusal));
        else
            expect(await result).toBe(
                'images.workbenches.dev/example/expert:1.0.0_build.7'
            );
        expect(events.slice(0, 2)).toEqual(['POST /v1/resolutions', 'export']);
        expect(events.at(-1)).toBe('PUT /v2/example/expert/manifests/1.0.0_build.7');
        expect(events.some((event) => event.includes('/uploads'))).toBe(false);
    }
});

async function fakeArchive(path: string) {
    const archive = pack();
    const digest = `sha256:${'a'.repeat(64)}`;
    const manifest = JSON.stringify({
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        config: {
            digest,
            size: 2,
            mediaType: 'application/vnd.oci.image.config.v1+json',
        },
        layers: [],
    });
    archive.entry(
        { name: 'index.json' },
        JSON.stringify({
            schemaVersion: 2,
            manifests: [
                {
                    digest: `sha256:${'b'.repeat(64)}`,
                    size: manifest.length,
                    mediaType: 'application/vnd.oci.image.manifest.v1+json',
                },
            ],
        })
    );
    archive.entry({ name: `blobs/sha256/${'b'.repeat(64)}` }, manifest);
    archive.entry({ name: `blobs/sha256/${'a'.repeat(64)}` }, '{}');
    archive.finalize();
    await pipeline(archive, createWriteStream(path));
}
