import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
    imageReference,
    loginCommand,
    loginImageClient,
    pushCommand,
    pushImage,
} from '../src/commands/image.js';
import { setRegistryApiUrl } from '../src/registry.js';

const projectDirectory = resolve(import.meta.dir, '..');
const cliPath = join(projectDirectory, 'src', 'cli.ts');
const temporaryDirectories: string[] = [];

afterEach(async () => {
    setRegistryApiUrl(undefined);
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('Workbench image references', () => {
    test('uses the production OCI registry host by default', () => {
        expect(imageReference('pompeii-labs', 'creator', '0.1.0')).toBe(
            'images.workbenches.dev/pompeii-labs/creator:0.1.0'
        );
    });

    test('uses the configured development registry host', () => {
        setRegistryApiUrl('https://pompeii.ngrok.app');
        expect(imageReference('pompeii-labs', 'creator', 'latest')).toBe(
            'pompeii.ngrok.app/pompeii-labs/creator:latest'
        );
    });

    test('rejects invalid image names and tags', () => {
        expect(() => imageReference('Bad Publisher', 'creator', 'latest')).toThrow(
            'Invalid publisher slug'
        );
        expect(() => imageReference('pompeii-labs', 'Bad Name', 'latest')).toThrow(
            'Invalid registry image name'
        );
        expect(() => imageReference('pompeii-labs', 'creator', 'bad tag')).toThrow(
            'Invalid registry image tag'
        );
    });
});

describe('Workbench image commands', () => {
    test('executes the authenticated command lifecycle', async () => {
        const fixture = await imageFixture();
        const previousHome = process.env.WORKBENCH_HOME;
        process.env.WORKBENCH_HOME = fixture.home;
        setRegistryApiUrl(fixture.apiUrl);
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
            expect(await clientInvocations(fixture.log)).toHaveLength(4);
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
                pushImage(
                    { ...image, publisher: 'unavailable' },
                    account,
                    testRegistryProfile(['pompeii-labs'])
                )
            ).rejects.toThrow('Publisher is unavailable to this account: unavailable');
            await expect(
                pushImage(image, account, testRegistryProfile([]))
            ).rejects.toThrow('Create or join a publisher before pushing');
            await expect(
                pushImage(
                    image,
                    account,
                    testRegistryProfile(['pompeii-labs', 'lux-db'])
                )
            ).rejects.toThrow(
                'Choose a publisher with --publisher: pompeii-labs, lux-db'
            );
        } finally {
            fixture.server.stop(true);
        }
    });

    test('reports an OCI client that cannot be started', async () => {
        setRegistryApiUrl('http://127.0.0.1:57401');
        await expect(
            loginImageClient(
                '/definitely/unavailable/workbench-oci-client',
                testAccount('http://127.0.0.1:57401', 'test-token')
            )
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

    test('logs in, tags, and pushes an image to the selected publisher', async () => {
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
                {
                    args: ['tag', 'local-image:latest', target],
                    input: '',
                },
                {
                    args: ['push', target],
                    input: '',
                },
            ]);
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

async function imageFixture() {
    const root = await temporaryDirectory('workbench-image-');
    const home = join(root, 'home');
    const client = join(root, 'oci-client');
    const log = join(root, 'client.jsonl');
    const token = 'registry-token-for-testing';
    const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch(request) {
            if (new URL(request.url).pathname !== '/v1/profile') {
                return Response.json(
                    { error: { message: 'Not found' } },
                    { status: 404 }
                );
            }
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
import { appendFile } from 'node:fs/promises';
const input = await Bun.stdin.text();
await appendFile(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), input }) + '\\n');
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
        server,
        token,
    };
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
