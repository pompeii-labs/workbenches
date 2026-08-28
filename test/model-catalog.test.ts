import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ModelCatalog } from '../src/models/catalog.js';
import { modelCatalogFixture } from './model-catalog-fixture.js';

const homes: string[] = [];

afterEach(async () => {
    await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true })));
});

describe('model metadata cache', () => {
    test('downloads a verified immutable snapshot and reuses a fresh cache', async () => {
        const home = await temporaryHome();
        const source = catalogSource('remote-fixture');
        const digest = createHash('sha256').update(source).digest('hex');
        const requests: string[] = [];
        const fetcher = async (input: string | URL | Request) => {
            const url = input.toString();
            requests.push(url);
            return url.endsWith('/models/v1/latest.json')
                ? Response.json(manifest(digest, source.byteLength, 'remote-fixture'))
                : new Response(source);
        };
        const catalog = new ModelCatalog({ home, fetch: fetcher });

        const first = await catalog.refresh(1_000);
        const second = await catalog.refresh(2_000);
        const loaded = await new ModelCatalog({ home }).loadCached();
        const stale = await catalog.refresh(7 * 60 * 60 * 1_000);

        expect(first.source).toBe('remote');
        expect(first.catalog.version).toBe('remote-fixture');
        expect(second.source).toBe('cache');
        expect(loaded.source).toBe('cache');
        expect(stale.source).toBe('cache');
        expect(stale.refreshed).toBe(true);
        expect(requests).toHaveLength(3);
        expect(
            await Bun.file(
                join(home, 'metadata', 'models', 'v1', `${digest}.json`)
            ).exists()
        ).toBe(true);
    });

    test('fails clearly when neither the service nor a cache is available', async () => {
        const home = await temporaryHome();
        const catalog = new ModelCatalog({
            home,
            fetch: async () => new Response('unavailable', { status: 503 }),
        });

        await expect(catalog.refresh(1_000)).rejects.toThrow(
            'Model metadata could not be loaded: Model metadata returned HTTP 503'
        );
        await expect(catalog.loadCached()).rejects.toThrow(
            'Model metadata is not cached'
        );
    });

    test('keeps a verified cache when a later refresh fails verification', async () => {
        const home = await temporaryHome();
        const trusted = catalogSource('trusted-fixture');
        const digest = createHash('sha256').update(trusted).digest('hex');
        let trustedResponse = true;
        const fetcher = async (input: string | URL | Request) => {
            if (input.toString().endsWith('/models/v1/latest.json')) {
                return Response.json(
                    manifest(
                        trustedResponse ? digest : '0'.repeat(64),
                        trusted.byteLength,
                        'trusted-fixture'
                    )
                );
            }
            return new Response(trusted);
        };
        const catalog = new ModelCatalog({ home, fetch: fetcher });
        await catalog.refresh(1_000);
        trustedResponse = false;

        const result = await catalog.refresh(7 * 60 * 60 * 1_000);

        expect(result.source).toBe('cache');
        expect(result.refreshed).toBe(false);
        expect(result.catalog.version).toBe('trusted-fixture');
    });

    test('rejects a snapshot whose version differs from its manifest', async () => {
        const home = await temporaryHome();
        const source = catalogSource('artifact-version');
        const digest = createHash('sha256').update(source).digest('hex');
        const catalog = new ModelCatalog({
            home,
            fetch: async (input) =>
                input.toString().endsWith('/models/v1/latest.json')
                    ? Response.json(
                          manifest(digest, source.byteLength, 'manifest-version')
                      )
                    : new Response(source),
        });

        await expect(catalog.refresh(3_000)).rejects.toThrow(
            'Model metadata version does not match its manifest'
        );
    });

    test('rejects a modified cached artifact', async () => {
        const home = await temporaryHome();
        const source = catalogSource('cache-fixture');
        const digest = createHash('sha256').update(source).digest('hex');
        const catalog = new ModelCatalog({
            home,
            fetch: async (input) =>
                input.toString().endsWith('/models/v1/latest.json')
                    ? Response.json(
                          manifest(digest, source.byteLength, 'cache-fixture')
                      )
                    : new Response(source),
        });
        await catalog.refresh(1_000);
        await Bun.write(join(home, 'metadata', 'models', 'v1', `${digest}.json`), '{}');

        await expect(new ModelCatalog({ home }).loadCached()).rejects.toThrow(
            'Model metadata is not cached'
        );
    });
});

function catalogSource(version: string): Uint8Array {
    return new TextEncoder().encode(
        `${JSON.stringify({ ...modelCatalogFixture, version }, null, 4)}\n`
    );
}

function manifest(digest: string, size: number, version: string) {
    return {
        schema: 1,
        catalog: 'models',
        version,
        artifact: `models/v1/${digest}.json`,
        sha256: digest,
        size,
    };
}

async function temporaryHome(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'workbench-model-metadata-'));
    homes.push(home);
    return home;
}
