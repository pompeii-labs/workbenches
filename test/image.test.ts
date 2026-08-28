import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pack } from 'tar-stream';

import { loginCommand, pushCommand } from '../src/commands/image.js';
import {
    RegistryClient,
    RegistryImagePublisher,
    registryImageReference,
} from '../src/registry/index.js';

const projectDirectory = resolve(import.meta.dir, '..');
const cliPath = join(projectDirectory, 'src', 'cli.ts');
const temporaryDirectories: string[] = [];

afterEach(async () => {
    RegistryClient.configureApiUrl(undefined);
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('Workbench image references', () => {
    test('uses the production OCI registry host by default', () => {
        expect(registryImageReference('pompeii-labs', 'creator', '0.1.0')).toBe(
            'images.workbenches.dev/pompeii-labs/creator:0.1.0'
        );
    });

    test('uses the configured development registry host', () => {
        RegistryClient.configureApiUrl('https://registry.example.com');
        expect(registryImageReference('pompeii-labs', 'creator', 'latest')).toBe(
            'registry.example.com/pompeii-labs/creator:latest'
        );
    });

    test('rejects invalid image names and tags', () => {
        expect(() =>
            registryImageReference('Bad Publisher', 'creator', 'latest')
        ).toThrow('Invalid publisher slug');
        expect(() =>
            registryImageReference('pompeii-labs', 'Bad Name', 'latest')
        ).toThrow('Invalid registry image name');
        expect(() =>
            registryImageReference('pompeii-labs', 'creator', 'bad tag')
        ).toThrow('Invalid registry image tag');
    });
});

describe('Workbench image commands', () => {
    test('executes the authenticated command lifecycle', async () => {
        const fixture = await imageFixture();
        const previousHome = process.env.WORKBENCH_HOME;
        process.env.WORKBENCH_HOME = fixture.home;
        RegistryClient.configureApiUrl(fixture.apiUrl);
        const output = spyOn(console, 'log').mockImplementation(() => undefined);
        try {
            await runDefinedCommand(loginCommand, { client: fixture.client });
            await runDefinedCommand(pushCommand, {
                image: 'local-image:latest',
                publisher: 'pompeii-labs',
                as: 'creator',
                tag: '0.2.0',
                client: fixture.client,
            });
            expect(output).toHaveBeenCalledWith(
                `connected\t127.0.0.1:${fixture.server.port}\t${fixture.client}`
            );
            expect(output).toHaveBeenCalledWith(
                `pushed\t127.0.0.1:${fixture.server.port}/pompeii-labs/creator:0.2.0`
            );
            expect(await clientInvocations(fixture.log)).toHaveLength(2);
            expect(fixture.patchSizes.some((size) => size === 16 * 1024 * 1024)).toBe(
                true
            );
        } finally {
            output.mockRestore();
            if (previousHome === undefined) delete process.env.WORKBENCH_HOME;
            else process.env.WORKBENCH_HOME = previousHome;
            fixture.server.stop(true);
        }
    });

    test('rejects unavailable, absent, and ambiguous publishers', async () => {
        const fixture = await imageFixture();
        const account = testAccount(fixture.apiUrl, fixture.token);
        const image = {
            image: 'local-image:latest',
            name: 'creator',
            tag: '0.2.0',
            client: fixture.client,
        };
        try {
            await expect(
                new RegistryImagePublisher({
                    account,
                    profile: testRegistryProfile(['pompeii-labs']),
                }).push({ ...image, publisher: 'unavailable' })
            ).rejects.toThrow('Publisher is unavailable to this account: unavailable');
            await expect(
                new RegistryImagePublisher({
                    account,
                    profile: testRegistryProfile([]),
                }).push(image)
            ).rejects.toThrow('Create or join a publisher before pushing');
            await expect(
                new RegistryImagePublisher({
                    account,
                    profile: testRegistryProfile(['pompeii-labs', 'lux-db']),
                }).push(image)
            ).rejects.toThrow(
                'Choose a publisher with --publisher: pompeii-labs, lux-db'
            );
        } finally {
            fixture.server.stop(true);
        }
    });

    test('reports an OCI client that cannot be started', async () => {
        RegistryClient.configureApiUrl('http://127.0.0.1:57401');
        await expect(
            new RegistryImagePublisher({
                account: testAccount('http://127.0.0.1:57401', 'test-token'),
            }).login('/definitely/unavailable/workbench-oci-client')
        ).rejects.toThrow('could not be started');
    });

    test('logs an OCI client in without exposing the registry token', async () => {
        const fixture = await imageFixture();
        try {
            const result = await executeCli(
                [
                    '--api-url',
                    fixture.apiUrl,
                    'image',
                    'login',
                    '--client',
                    fixture.client,
                ],
                fixture.environment
            );

            expect(result.code).toBe(0);
            expect(result.stdout).toContain(
                `connected\t127.0.0.1:${fixture.server.port}\t${fixture.client}`
            );
            expect(`${result.stdout}\n${result.stderr}`).not.toContain(fixture.token);
            expect(await clientInvocations(fixture.log)).toEqual([
                {
                    args: [
                        'login',
                        `127.0.0.1:${fixture.server.port}`,
                        '--username',
                        'workbench',
                        '--password-stdin',
                    ],
                    input: `${fixture.token}\n`,
                },
            ]);
        } finally {
            fixture.server.stop(true);
        }
    });

    test('exports and publishes an image to the selected publisher', async () => {
        const fixture = await imageFixture();
        try {
            const result = await executeCli(
                [
                    '--api-url',
                    fixture.apiUrl,
                    'image',
                    'push',
                    'local-image:latest',
                    '--publisher',
                    'pompeii-labs',
                    '--as',
                    'creator',
                    '--tag',
                    '0.2.0',
                    '--client',
                    fixture.client,
                ],
                fixture.environment
            );

            const target = `127.0.0.1:${fixture.server.port}/pompeii-labs/creator:0.2.0`;
            expect(result.code).toBe(0);
            expect(result.stdout).toContain(`pushed\t${target}`);
            expect(result.stderr).toContain('Exporting local image');
            expect(result.stderr).toContain('Inspecting OCI image');
            expect(result.stderr).toContain('2 blobs to upload');
            expect(result.stderr).toContain('layer 2/2');
            expect(result.stderr).toContain('Publishing image manifest');
            expect(`${result.stdout}\n${result.stderr}`).not.toContain(fixture.token);
            expect(await clientInvocations(fixture.log)).toEqual([
                {
                    args: [
                        'image',
                        'save',
                        '--output',
                        expect.stringContaining('workbench-image-push-'),
                        'local-image:latest',
                    ],
                    input: '',
                },
            ]);
            expect(Math.max(...fixture.patchSizes)).toBeLessThanOrEqual(
                16 * 1024 * 1024
            );
            expect(fixture.manifests).toHaveLength(1);

            const patchCount = fixture.patchSizes.length;
            const second = await executeCli(
                [
                    '--api-url',
                    fixture.apiUrl,
                    'image',
                    'push',
                    'local-image:latest',
                    '--publisher',
                    'pompeii-labs',
                    '--as',
                    'creator',
                    '--tag',
                    '0.2.1',
                    '--client',
                    fixture.client,
                ],
                fixture.environment
            );
            expect(second.code).toBe(0);
            expect(second.stderr).toContain('0 blobs to upload');
            expect(second.stderr).toContain('2 already stored');
            expect(fixture.patchSizes).toHaveLength(patchCount);
            expect(fixture.manifests).toHaveLength(2);
        } finally {
            fixture.server.stop(true);
        }
    });

    test('resumes after the registry stores a chunk but loses its response', async () => {
        const fixture = await imageFixture({ losePatchResponseOnce: true });
        try {
            const result = await executeCli(
                [
                    '--api-url',
                    fixture.apiUrl,
                    'image',
                    'push',
                    'local-image:latest',
                    '--publisher',
                    'pompeii-labs',
                    '--as',
                    'creator',
                    '--tag',
                    '0.2.0',
                    '--client',
                    fixture.client,
                ],
                fixture.environment
            );

            expect(result.code).toBe(0);
            expect(fixture.manifests).toHaveLength(1);
        } finally {
            fixture.server.stop(true);
        }
    });

    test('reports OCI client failures', async () => {
        const fixture = await imageFixture();
        try {
            const result = await executeCli(
                [
                    '--api-url',
                    fixture.apiUrl,
                    'image',
                    'login',
                    '--client',
                    fixture.client,
                ],
                { ...fixture.environment, WB_IMAGE_CLIENT_EXIT: '7' }
            );

            expect(result.code).toBe(1);
            expect(result.stderr).toContain(`${fixture.client} exited with code 7`);
            expect(`${result.stdout}\n${result.stderr}`).not.toContain(fixture.token);
        } finally {
            fixture.server.stop(true);
        }
    });
});

async function imageFixture(options: { losePatchResponseOnce?: boolean } = {}) {
    const root = await temporaryDirectory('workbench-image-');
    const home = join(root, 'home');
    const client = join(root, 'oci-client');
    const log = join(root, 'client.jsonl');
    const token = 'registry-token-for-testing';
    const ociToken = 'oci-token-for-testing';
    const archive = join(root, 'fixture.tar');
    await writeOciArchive(archive);
    const uploads = new Map<string, Uint8Array[]>();
    const blobs = new Set<string>();
    const patchSizes: number[] = [];
    const manifests: Uint8Array[] = [];
    let patchResponseLost = false;
    const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
            const url = new URL(request.url);
            if (url.pathname === '/v1/profile') {
                if (request.headers.get('authorization') !== `Bearer ${token}`) {
                    return Response.json(
                        { error: { message: 'Unauthorized' } },
                        { status: 401 }
                    );
                }
                return Response.json({
                    user: { id: 'user-1', email: 'maintainer@example.com' },
                    publishers: [
                        {
                            id: 'publisher-1',
                            slug: 'pompeii-labs',
                            name: 'Pompeii Labs',
                        },
                    ],
                });
            }
            if (url.pathname === '/v2/auth') {
                if (request.headers.get('authorization') !== `Bearer ${token}`) {
                    return Response.json({ errors: [] }, { status: 401 });
                }
                return Response.json({ token: ociToken });
            }
            if (request.headers.get('authorization') !== `Bearer ${ociToken}`) {
                return Response.json({ errors: [] }, { status: 401 });
            }
            const blobMatch = /\/blobs\/(sha256:[0-9a-f]{64})$/.exec(url.pathname);
            if (request.method === 'HEAD' && blobMatch?.[1]) {
                return new Response(null, {
                    status: blobs.has(blobMatch[1]) ? 200 : 404,
                });
            }
            if (request.method === 'POST' && url.pathname.endsWith('/blobs/uploads/')) {
                const id = crypto.randomUUID();
                uploads.set(id, []);
                return new Response(null, {
                    status: 202,
                    headers: {
                        Location: `/v2/pompeii-labs/creator/blobs/uploads/${id}`,
                    },
                });
            }
            const uploadMatch = /\/blobs\/uploads\/([^/]+)$/.exec(url.pathname);
            if (uploadMatch?.[1] && request.method === 'PATCH') {
                const parts = uploads.get(uploadMatch[1]);
                if (!parts) return Response.json({ errors: [] }, { status: 404 });
                const bytes = new Uint8Array(await request.arrayBuffer());
                patchSizes.push(bytes.byteLength);
                parts.push(bytes);
                const size = parts.reduce((total, part) => total + part.byteLength, 0);
                if (options.losePatchResponseOnce && !patchResponseLost) {
                    patchResponseLost = true;
                    return Response.json({ errors: [] }, { status: 503 });
                }
                return new Response(null, {
                    status: 202,
                    headers: {
                        Location: url.pathname,
                        Range: `0-${size - 1}`,
                    },
                });
            }
            if (uploadMatch?.[1] && request.method === 'GET') {
                const parts = uploads.get(uploadMatch[1]);
                if (!parts) return Response.json({ errors: [] }, { status: 404 });
                const size = parts.reduce((total, part) => total + part.byteLength, 0);
                return new Response(null, {
                    status: 204,
                    headers: { Location: url.pathname, Range: `0-${size - 1}` },
                });
            }
            if (uploadMatch?.[1] && request.method === 'PUT') {
                const digest = url.searchParams.get('digest');
                if (!digest) return Response.json({ errors: [] }, { status: 400 });
                blobs.add(digest);
                uploads.delete(uploadMatch[1]);
                return new Response(null, {
                    status: 201,
                    headers: {
                        Location: `/v2/pompeii-labs/creator/blobs/${digest}`,
                        'Docker-Content-Digest': digest,
                    },
                });
            }
            if (uploadMatch?.[1] && request.method === 'DELETE') {
                uploads.delete(uploadMatch[1]);
                return new Response(null, { status: 204 });
            }
            if (request.method === 'PUT' && url.pathname.includes('/manifests/')) {
                manifests.push(new Uint8Array(await request.arrayBuffer()));
                return new Response(null, { status: 201 });
            }
            return Response.json({ error: { message: 'Not found' } }, { status: 404 });
        },
    });
    const apiUrl = `http://127.0.0.1:${server.port}`;
    await mkdir(home, { recursive: true });
    await writeFile(
        join(home, 'credentials.json'),
        `${JSON.stringify({
            version: 1,
            accounts: [
                {
                    url: apiUrl,
                    token,
                    tokenId: 'token-1',
                    email: 'maintainer@example.com',
                    expiresAt: '2099-01-01T00:00:00.000Z',
                },
            ],
        })}\n`,
        { mode: 0o600 }
    );
    await writeFile(
        client,
        `#!/usr/bin/env bun
import { appendFile, copyFile } from 'node:fs/promises';
const input = await Bun.stdin.text();
const args = process.argv.slice(2);
await appendFile(${JSON.stringify(log)}, JSON.stringify({ args, input }) + '\\n');
if (args[0] === 'image' && args[1] === 'save' && args[2] === '--output' && args[3]) {
    await copyFile(${JSON.stringify(archive)}, args[3]);
}
process.exit(Number(process.env.WB_IMAGE_CLIENT_EXIT ?? 0));
`
    );
    await chmod(client, 0o755);
    return {
        apiUrl,
        client,
        environment: {
            WORKBENCH_HOME: home,
            WB_IMAGE_CLIENT_LOG: log,
        },
        home,
        log,
        manifests,
        patchSizes,
        server,
        token,
    };
}

async function writeOciArchive(path: string): Promise<void> {
    const config = new TextEncoder().encode(
        JSON.stringify({
            architecture: 'arm64',
            os: 'linux',
            rootfs: { type: 'layers', diff_ids: [] },
        })
    );
    const layer = new Uint8Array(17 * 1024 * 1024 + 19);
    for (let index = 0; index < layer.byteLength; index += 1) {
        layer[index] = index % 251;
    }
    const configDescriptor = descriptor(
        'application/vnd.oci.image.config.v1+json',
        config
    );
    const layerDescriptor = descriptor('application/vnd.oci.image.layer.v1.tar', layer);
    const manifest = new TextEncoder().encode(
        JSON.stringify({
            schemaVersion: 2,
            mediaType: 'application/vnd.oci.image.manifest.v1+json',
            config: configDescriptor,
            layers: [layerDescriptor],
        })
    );
    const manifestDescriptor = descriptor(
        'application/vnd.oci.image.manifest.v1+json',
        manifest
    );
    const index = new TextEncoder().encode(
        JSON.stringify({
            schemaVersion: 2,
            mediaType: 'application/vnd.oci.image.index.v1+json',
            manifests: [manifestDescriptor],
        })
    );
    const archive = pack();
    archive.entry(
        { name: digestPath(configDescriptor.digest), size: config.byteLength },
        Buffer.from(config)
    );
    archive.entry(
        { name: digestPath(manifestDescriptor.digest), size: manifest.byteLength },
        Buffer.from(manifest)
    );
    archive.entry(
        { name: digestPath(layerDescriptor.digest), size: layer.byteLength },
        Buffer.from(layer)
    );
    archive.entry({ name: 'index.json', size: index.byteLength }, Buffer.from(index));
    archive.finalize();
    await pipeline(archive, createWriteStream(path));
}

function descriptor(mediaType: string, bytes: Uint8Array) {
    return {
        mediaType,
        digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        size: bytes.byteLength,
    };
}

function digestPath(digest: string): string {
    return `blobs/sha256/${digest.slice('sha256:'.length)}`;
}

function testAccount(url: string, token: string) {
    return {
        url,
        token,
        tokenId: 'token-1',
        email: 'maintainer@example.com',
        expiresAt: '2099-01-01T00:00:00.000Z',
    };
}

function testRegistryProfile(slugs: string[]) {
    return {
        user: { id: 'user-1', email: 'maintainer@example.com' },
        publishers: slugs.map((slug) => ({
            id: `publisher-${slug}`,
            slug,
            name: slug,
        })),
    };
}

async function runDefinedCommand(
    command: typeof loginCommand | typeof pushCommand,
    args: Record<string, unknown>
): Promise<void> {
    if (!command.run) throw new Error('Command has no run handler');
    const run = command.run as unknown as (context: {
        args: Record<string, unknown>;
    }) => Promise<void> | void;
    await run({ args });
}

async function temporaryDirectory(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

async function executeCli(
    args: string[],
    environment: Record<string, string>
): Promise<{ code: number; stdout: string; stderr: string }> {
    const child = Bun.spawn([process.execPath, cliPath, ...args], {
        cwd: projectDirectory,
        env: { ...process.env, ...environment },
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
}

async function clientInvocations(
    path: string
): Promise<Array<{ args: string[]; input: string }>> {
    return (await readFile(path, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
}
