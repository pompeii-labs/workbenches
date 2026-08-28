import { describe, expect, test } from 'bun:test';

import { RegistryClient } from '../src/registry/index.js';

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
            versionId: '018f1e48-7fb2-7a12-a4dd-0123456789ab',
            version: '0.1.0',
            digest: `sha256:${'b'.repeat(64)}`,
            source: 'https://github.com/lux-db/lux',
            selector: 'core',
            revision: 'a'.repeat(40),
        });
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
