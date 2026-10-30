import { describe, expect, test } from 'bun:test';

import {
    parseImageReference,
    pinnedImage,
} from '../../../src/runtimes/daytona/digests.js';
import { client, json } from './http.js';

const digest = `sha256:${'b'.repeat(64)}`;
const challenge =
    'Bearer realm="https://auth.registry.test/token",service="registry.test",scope="repository:library/debian:pull"';

describe('image digests', () => {
    test('returns a pinned digest without a request', async () => {
        const { api, requests } = client(() => json({}, 500));
        expect(await api.imageDigest(`ghcr.io/example/workbench:1.0.0@${digest}`)).toBe(
            digest
        );
        expect(requests).toHaveLength(0);
    });

    test('resolves a tag through the anonymous token challenge', async () => {
        const { api, requests } = client((request) => {
            if (request.url.hostname === 'auth.registry.test') {
                return json({ token: 'anonymous-pull-token' });
            }
            if (
                request.headers.get('authorization') !== 'Bearer anonymous-pull-token'
            ) {
                return new Response(null, {
                    status: 401,
                    headers: { 'www-authenticate': challenge },
                });
            }
            return new Response(null, {
                status: 200,
                headers: { 'docker-content-digest': digest },
            });
        });
        expect(await api.imageDigest('debian:bookworm-slim')).toBe(digest);
        expect(requests.map((r) => `${r.method} ${r.url.href}`)).toEqual([
            'HEAD https://registry-1.docker.io/v2/library/debian/manifests/bookworm-slim',
            'GET https://auth.registry.test/token?service=registry.test&scope=repository%3Alibrary%2Fdebian%3Apull',
            'HEAD https://registry-1.docker.io/v2/library/debian/manifests/bookworm-slim',
        ]);
        expect(requests[0]?.headers.get('accept')).toContain(
            'application/vnd.oci.image.index.v1+json'
        );
        // The Daytona credential never goes to a registry.
        for (const request of requests) {
            expect(request.headers.get('authorization') ?? '').not.toContain(
                'secret-api-key'
            );
        }
    });

    test('hashes the manifest when a registry sends no digest header', async () => {
        const manifest = '{"schemaVersion":2}';
        const { api, requests } = client(
            (request) =>
                new Response(request.method === 'GET' ? manifest : null, {
                    status: 200,
                })
        );
        const expected = new Bun.CryptoHasher('sha256').update(manifest).digest('hex');
        expect(await api.imageDigest('images.workbenches.dev/example/core:0.4.0')).toBe(
            `sha256:${expected}`
        );
        expect(requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
            'HEAD /v2/example/core/manifests/0.4.0',
            'GET /v2/example/core/manifests/0.4.0',
        ]);
    });

    test('names the image it cannot resolve', async () => {
        const { api } = client(
            () =>
                new Response(null, {
                    status: 401,
                    headers: { 'www-authenticate': 'Basic realm="registry"' },
                })
        );
        await expect(
            api.imageDigest('ghcr.io/example/private:1')
        ).rejects.toMatchObject({
            name: 'RuntimeError',
            runtime: 'daytona',
            message:
                'Could not resolve the digest of image ghcr.io/example/private:1: the registry requires credentials',
        });
    });

    test('reports a tag the registry does not have', async () => {
        const { api } = client(() => new Response(null, { status: 404 }));
        await expect(api.imageDigest('ghcr.io/example/workbench:9')).rejects.toThrow(
            'Could not resolve the digest of image ghcr.io/example/workbench:9: the registry answered 404'
        );
    });

    test('refuses an image reference with whitespace before any request', async () => {
        const { api, requests } = client(() => json({}));
        await expect(api.imageDigest('debian bookworm')).rejects.toMatchObject({
            name: 'RuntimeError',
            runtime: 'daytona',
            message: 'Invalid Daytona image reference: "debian bookworm"',
        });
        expect(requests).toHaveLength(0);
    });
});

describe('parseImageReference', () => {
    test('applies Docker Hub defaults to short names', () => {
        expect(parseImageReference('debian')).toEqual({
            name: 'debian',
            host: 'registry-1.docker.io',
            repository: 'library/debian',
            tag: 'latest',
        });
        expect(parseImageReference('docker.io/owner/tool:2')).toMatchObject({
            host: 'registry-1.docker.io',
            repository: 'owner/tool',
            tag: '2',
        });
    });

    test('keeps a registry host with a port apart from the tag', () => {
        expect(parseImageReference('localhost:5000/team/app:1.2')).toEqual({
            name: 'localhost:5000/team/app',
            host: 'localhost:5000',
            repository: 'team/app',
            tag: '1.2',
        });
    });

    test('pins a reference to a digest without its tag', () => {
        expect(pinnedImage('ghcr.io/example/workbench:1.0.0', digest)).toBe(
            `ghcr.io/example/workbench@${digest}`
        );
        expect(pinnedImage('debian:bookworm-slim', digest)).toBe(`debian@${digest}`);
    });

    test('refuses a malformed digest', () => {
        expect(() => parseImageReference('debian@sha256:short')).toThrow(
            'Invalid Daytona image reference: "debian@sha256:short"'
        );
    });
});
