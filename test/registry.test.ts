import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    RegistryAccountStore,
    RegistryClient,
    type RegistryPackage,
} from '../src/registry/index.js';

const API = 'https://registry.example';
const homes: string[] = [];

afterEach(async () => {
    await Promise.all(
        homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))
    );
});

describe('Workbench registry provider', () => {
    test('permits an HTTP registry only on loopback', () => {
        RegistryClient.configureApiUrl('http://localhost:57401');
        expect(RegistryClient.configuredApiUrl()).toBe('http://localhost:57401');
        RegistryClient.configureApiUrl(undefined);

        expect(() => RegistryClient.configureApiUrl('http://registry.example')).toThrow(
            'must use HTTPS except on localhost'
        );
    });

    test('recognizes canonical registry identifiers without confusing source URLs', () => {
        expect(RegistryClient.parseReference('pompeii-labs/lux-core')).toEqual({
            publisher: 'pompeii-labs',
            workbench: 'lux-core',
        });
        expect(
            RegistryClient.parseReference('https://github.com/lux-db/lux')
        ).toBeUndefined();
        expect(RegistryClient.parseReference('lux-db/lux#core')).toBeUndefined();
        expect(RegistryClient.parseReference('../local')).toBeUndefined();
    });

    test('resolves an immutable public package record', async () => {
        const requests: string[] = [];
        const requestsInit: RequestInit[] = [];
        const client = new RegistryClient({
            apiUrl: 'https://registry.example',
            fetch: async (input, init) => {
                requests.push(String(input));
                requestsInit.push(init ?? {});
                return Response.json(registryResponse());
            },
        });
        const resolved = await client.resolve({
            publisher: 'pompeii-labs',
            workbench: 'lux-core',
        });

        expect(requests).toEqual(['https://registry.example/v1/resolutions']);
        expect(requestsInit[0]?.method).toBe('POST');
        expect(requestsInit[0]?.body).toBe(
            JSON.stringify({
                publisher: 'pompeii-labs',
                workbench: 'lux-core',
            })
        );
        expect(resolved).toEqual({
            reference: { publisher: 'pompeii-labs', workbench: 'lux-core' },
            registryUrl: 'https://registry.example',
            visibility: 'public',
            versionId: '018f1e48-7fb2-7a12-a4dd-0123456789ab',
            version: '0.1.0',
            digest: `sha256:${'b'.repeat(64)}`,
            source: 'https://github.com/lux-db/lux',
            selector: 'core',
            revision: 'a'.repeat(40),
        });
    });

    test('searches published Workbenches with curation metadata', async () => {
        const requests: Array<{ input: string; init?: RequestInit }> = [];
        const client = new RegistryClient({
            apiUrl: 'https://registry.example',
            fetch: async (input, init) => {
                requests.push({ input: String(input), ...(init ? { init } : {}) });
                return Response.json({ workbenches: [searchResult()] });
            },
        });

        const results = await client.search('lux auth');

        expect(requests[0]?.input).toBe('https://registry.example/v1/searches');
        expect(requests[0]?.init?.method).toBe('POST');
        expect(requests[0]?.init?.body).toBe(JSON.stringify({ query: 'lux auth' }));
        expect(results).toEqual([
            {
                reference: { publisher: 'lux', workbench: 'auth' },
                name: 'lux-auth',
                summary: 'Build Lux authentication.',
                runner: 'opencode',
                runtime: 'local',
                model: 'openai/gpt-5.6-terra',
                version: '0.1.0',
                sourceReference: 'lux-db/lux#auth',
                sourceUrl: 'https://workbenches.dev/p/lux/auth',
                publisherName: 'Lux',
                verifiedPublisher: true,
                saves: 12,
                runs: 34,
                visibility: 'public',
            },
        ]);
    });

    test('combines direct matches with a reusable discovery index', async () => {
        const bodies: string[] = [];
        const client = new RegistryClient({
            apiUrl: 'https://registry.example',
            fetch: async (_input, init) => {
                const body = String(init?.body ?? '');
                bodies.push(body);
                return Response.json({
                    workbenches: body === '{}' ? [searchResult()] : [],
                });
            },
        });

        expect(await client.discover('lxu')).toHaveLength(1);
        expect(await client.discover('authentication')).toHaveLength(1);
        expect(bodies.filter((body) => body === '{}')).toHaveLength(1);
        expect(bodies).toContain(JSON.stringify({ query: 'lxu' }));
        expect(bodies).toContain(JSON.stringify({ query: 'authentication' }));
    });

    test('rejects malformed registry search results', async () => {
        const client = new RegistryClient({
            apiUrl: 'https://registry.example',
            fetch: async () => Response.json({ workbenches: [{ slug: 'broken' }] }),
        });

        await expect(client.search('broken')).rejects.toThrow(
            'malformed search results'
        );
        await expect(client.search('x'.repeat(121))).rejects.toThrow(
            'may not exceed 120 characters'
        );
    });

    test('returns no package for a registry miss and rejects unsafe or malformed responses', async () => {
        const missing = new RegistryClient({
            apiUrl: 'https://registry.example',
            fetch: async () => new Response(null, { status: 404 }),
        });
        expect(
            await missing.resolve({
                publisher: 'pompeii-labs',
                workbench: 'missing',
            })
        ).toBeUndefined();
        const malformed = new RegistryClient({
            apiUrl: 'https://registry.example',
            fetch: async () => Response.json({ nope: true }),
        });
        await expect(
            malformed.resolve({
                publisher: 'pompeii-labs',
                workbench: 'lux-core',
            })
        ).rejects.toThrow('malformed package record');
        expect(() => new RegistryClient({ apiUrl: 'http://registry.example' })).toThrow(
            'must use HTTPS'
        );
    });

    test('downloads a registry-owned package without reaching GitHub', async () => {
        const client = new RegistryClient({
            apiUrl: 'https://registry.example',
            fetch: async (input) =>
                String(input).endsWith('/v1/resolutions')
                    ? Response.json({
                          ...registryResponse(),
                          source_path: 'workbench.yml',
                          repository: null,
                          latest_version: {
                              ...registryResponse().latest_version,
                              source_commit: 'c'.repeat(64),
                              artifact_url:
                                  'https://registry.example/v1/artifacts/018f1e48-7fb2-7a12-a4dd-0123456789ab',
                          },
                      })
                    : Response.json({
                          format: 1,
                          files: [
                              artifactFile(
                                  'workbench.yml',
                                  [
                                      'spec: 0',
                                      'version: 0.1.0',
                                      'name: Creator',
                                      'runner: opencode',
                                      'model:',
                                      '  id: openai/gpt-5.6-terra',
                                      'instructions: instructions.md',
                                      'runtime: local',
                                      '',
                                  ].join('\n')
                              ),
                              artifactFile('instructions.md', '# Creator\n'),
                          ],
                      }),
        });
        const registry = await client.resolve({
            publisher: 'pompeii-labs',
            workbench: 'creator',
        });
        expect(registry?.artifactUrl).toContain('/v1/artifacts/');
        if (!registry) throw new Error('Expected registry package');

        const workbench = await client.fetchWorkbench(registry);

        expect(workbench.source).toBe('pompeii-labs/creator');
        expect(workbench.selector).toBe('creator');
        expect(workbench.manifest.name).toBe('Creator');
        expect(workbench.files.map((file) => file.path)).toEqual([
            'workbench.yml',
            'instructions.md',
        ]);
    });

    test('accepts same-origin artifacts from a loopback registry', async () => {
        const client = new RegistryClient({
            apiUrl: 'http://localhost:57401',
            fetch: async () =>
                Response.json({
                    ...registryResponse(),
                    source_path: 'workbench.yml',
                    repository: null,
                    latest_version: {
                        ...registryResponse().latest_version,
                        source_commit: 'c'.repeat(64),
                        artifact_url:
                            'http://localhost:57401/v1/artifacts/018f1e48-7fb2-7a12-a4dd-0123456789ab',
                    },
                }),
        });
        const resolved = await client.resolve({
            publisher: 'pompeii-labs',
            workbench: 'creator',
        });

        expect(resolved?.artifactUrl).toBe(
            'http://localhost:57401/v1/artifacts/018f1e48-7fb2-7a12-a4dd-0123456789ab'
        );
    });
});

describe('Workbench registry keys', () => {
    test('uses the key of the organization matching the publisher', async () => {
        const { client, authorizations } = await keyed(['alpha', 'beta']);
        await client.resolve({ publisher: 'beta', workbench: 'tool' });
        await client.resolve({ publisher: 'alpha', workbench: 'tool' });
        expect(authorizations).toEqual(['Bearer wb_beta', 'Bearer wb_alpha']);
    });

    test('falls back to the default key for other publishers and for search', async () => {
        const { client, authorizations } = await keyed(['alpha', 'beta']);
        await client.resolve({ publisher: 'public-org', workbench: 'tool' });
        await client.search('anything');
        expect(authorizations).toEqual(['Bearer wb_alpha', 'Bearer wb_alpha']);
    });

    test('stays anonymous when no key is held or the held key is expired', async () => {
        const none = await keyed([]);
        await none.client.resolve({ publisher: 'alpha', workbench: 'tool' });
        await none.client.search('');
        expect(none.authorizations).toEqual([null, null]);

        const expired = await keyed(['alpha'], '2001-01-01T00:00:00Z');
        await expired.client.resolve({ publisher: 'alpha', workbench: 'tool' });
        expect(expired.authorizations).toEqual([null]);
    });

    test('sends the key on registry artifact fetches and never to another origin', async () => {
        const { client, authorizations, requests } = await keyed(['alpha']);
        const registry = (artifactUrl: string): RegistryPackage => ({
            reference: { publisher: 'alpha', workbench: 'tool' },
            registryUrl: API,
            visibility: 'private',
            versionId: 'v',
            version: '0.1.0',
            digest: `sha256:${'b'.repeat(64)}`,
            source: 'alpha/tool',
            selector: 'tool',
            revision: 'a'.repeat(40),
            artifactUrl,
        });
        await client.fetchWorkbench(registry(`${API}/v1/artifacts/v`)).catch(() => {});
        await client
            .fetchWorkbench(registry('https://elsewhere.example/artifact'))
            .catch(() => {});
        expect(requests).toEqual([
            `${API}/v1/artifacts/v`,
            'https://elsewhere.example/artifact',
        ]);
        expect(authorizations).toEqual(['Bearer wb_alpha', null]);
    });

    test('reads visibility and defaults to public when the registry omits it', async () => {
        const client = new RegistryClient({
            apiUrl: API,
            fetch: async () =>
                Response.json({ ...registryResponse(), visibility: 'private' }),
        });
        expect(
            (await client.resolve({ publisher: 'lux', workbench: 'core' }))?.visibility
        ).toBe('private');
        const bad = new RegistryClient({
            apiUrl: API,
            fetch: async () =>
                Response.json({ ...registryResponse(), visibility: 'secret' }),
        });
        await expect(
            bad.resolve({ publisher: 'lux', workbench: 'core' })
        ).rejects.toThrow('malformed package record');
    });

    test('exposes the workbench id when the registry reports one', async () => {
        const client = new RegistryClient({
            apiUrl: API,
            fetch: async () =>
                Response.json({ ...registryResponse(), workbench_id: 'wb-id' }),
        });
        expect(
            (await client.resolve({ publisher: 'lux', workbench: 'core' }))?.workbenchId
        ).toBe('wb-id');
        const bad = new RegistryClient({
            apiUrl: API,
            fetch: async () =>
                Response.json({ ...registryResponse(), workbench_id: 7 }),
        });
        await expect(
            bad.resolve({ publisher: 'lux', workbench: 'core' })
        ).rejects.toThrow('malformed package record');
    });

    test('explains a miss for a publisher with no held key', async () => {
        const none = await keyed([]);
        expect(
            (await none.client.missing({ publisher: 'acme', workbench: 'x' })).message
        ).toBe(
            'Registry Workbench does not exist: acme/x. Internal workbenches need a key for their organization: wb login --org acme'
        );
        const held = await keyed(['acme']);
        expect(
            (await held.client.missing({ publisher: 'acme', workbench: 'x' })).message
        ).toBe('Registry Workbench does not exist: acme/x');
    });
});

async function keyed(slugs: string[], expiresAt = '2099-01-01T00:00:00Z') {
    const home = await mkdtemp(join(tmpdir(), 'registry-keys-'));
    homes.push(home);
    const authorizations: Array<string | null> = [];
    const requests: string[] = [];
    const client = new RegistryClient({
        apiUrl: API,
        home,
        fetch: async (input, init) => {
            requests.push(String(input));
            authorizations.push(new Headers(init?.headers).get('authorization'));
            return String(input).endsWith('/v1/searches')
                ? Response.json({ workbenches: [] })
                : Response.json(registryResponse());
        },
    });
    const accounts = new RegistryAccountStore({ home, client });
    for (const slug of slugs) {
        await accounts.save({
            organizationId: `${slug}-id`,
            slug,
            name: slug,
            personal: false,
            token: `wb_${slug}`,
            keyId: `${slug}-key`,
            scopes: ['catalog:read'],
            expiresAt,
        });
    }
    return { client, authorizations, requests };
}

function artifactFile(path: string, source: string) {
    return {
        path,
        content: Buffer.from(source).toString('base64'),
        executable: false,
    };
}

function registryResponse() {
    return {
        source_path: '.workbenches/core/workbench.yml',
        repository: { url: 'https://github.com/lux-db/lux' },
        latest_version: {
            id: '018f1e48-7fb2-7a12-a4dd-0123456789ab',
            version: '0.1.0',
            digest: 'b'.repeat(64),
            source_commit: 'a'.repeat(40),
        },
    };
}

function searchResult() {
    return {
        slug: 'auth',
        name: 'lux-auth',
        summary: 'Build Lux authentication.',
        runner: 'opencode',
        runtime: 'local',
        model: 'openai/gpt-5.6-terra',
        source_reference: 'lux-db/lux#auth',
        source_url: 'https://workbenches.dev/p/lux/auth',
        publisher: {
            slug: 'lux',
            name: 'Lux',
            verified: true,
        },
        latest_version: { version: '0.1.0' },
        metrics: { saves: 12, runs: 34 },
    };
}
