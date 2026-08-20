import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
    type DockerCommandResult,
    DockerRuntimeProvider,
    stageDockerBuildContext,
} from '../src/docker.js';
import { RuntimeProviderRegistry } from '../src/runtime.js';
import type { ResolvedWorkbench, SpawnedRunner } from '../src/types.js';
import { runtimeProviderContract } from './runtime-provider-contract.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('Docker runtime provider', () => {
    test('reports unavailable host Docker dependencies before image work', async () => {
        const fixture = await createFixture({ image: 'ghcr.io/example/lux:0.1.0' });
        await expect(
            new DockerRuntimeProvider({ findExecutable: () => null }).prepare(
                request(fixture)
            )
        ).rejects.toThrow('Docker CLI is unavailable on the host');

        await expect(
            new DockerRuntimeProvider({
                findExecutable: () => '/usr/bin/docker',
                command: async () => result(1, '', 'daemon stopped'),
            }).prepare(request(fixture))
        ).rejects.toThrow('Docker daemon is unavailable: daemon stopped');
    });

    test('requires Docker Workbenches to declare an image', async () => {
        const fixture = await createFixture({});
        await expect(
            new DockerRuntimeProvider({
                findExecutable: () => '/usr/bin/docker',
                command: dockerMock([]),
            }).prepare(request(fixture))
        ).rejects.toThrow('Docker runtime requires an image or local image build');
    });

    test('pulls a published tag and runs from its immutable repository digest', async () => {
        const fixture = await createFixture({ image: 'ghcr.io/example/lux:0.1.0' });
        const commands: string[][] = [];
        const provider = new DockerRuntimeProvider({
            findExecutable: () => '/usr/bin/docker',
            command: dockerMock(commands),
        });
        const runtime = await provider.prepare(request(fixture));
        try {
            expect(runtime.preparation).toEqual({
                kind: 'image',
                reference: 'ghcr.io/example/lux:0.1.0',
                immutableReference:
                    'ghcr.io/example/lux@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                action: 'pulled',
            });
            expect(commands).toContainEqual([
                '/usr/bin/docker',
                'image',
                'pull',
                '--quiet',
                'ghcr.io/example/lux:0.1.0',
            ]);
        } finally {
            await runtime.cleanup();
        }
    });

    test('reuses a locally available digest without pulling it again', async () => {
        const reference =
            'ghcr.io/example/lux@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        const fixture = await createFixture({ image: reference });
        const commands: string[][] = [];
        const runtime = await new DockerRuntimeProvider({
            findExecutable: () => '/usr/bin/docker',
            command: dockerMock(commands),
        }).prepare(request(fixture));
        try {
            expect(runtime.preparation).toMatchObject({
                action: 'cache-hit',
                immutableReference: reference,
            });
            expect(commands.some((command) => command.includes('pull'))).toBeFalse();
        } finally {
            await runtime.cleanup();
        }
    });

    test('fails smoke on a missing in-image tool before spawning a runner', async () => {
        const fixture = await createFixture({
            image: 'ghcr.io/example/lux:0.1.0',
            tools: ['cargo', 'lux'],
        });
        let spawned = false;
        const runtime = await new RuntimeProviderRegistry([
            new DockerRuntimeProvider({
                findExecutable: () => '/usr/bin/docker',
                command: dockerMock([], { missing: 'lux' }),
                spawn: () => {
                    spawned = true;
                    return { exited: Promise.resolve(0) };
                },
            }),
        ])
            .resolve('docker')
            .prepare(request(fixture));
        try {
            await expect(runtime.preflight()).rejects.toThrow(
                'Required CLI tool is unavailable in Docker image ghcr.io/example/lux@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: lux'
            );
            expect(spawned).toBeFalse();
        } finally {
            await runtime.cleanup();
        }
    });

    test('mounts only declared assets and passes authorization by name', async () => {
        const fixture = await createFixture({
            image: 'ghcr.io/example/lux:0.1.0',
            env: { OPENROUTER_API_KEY: { required: true } },
        });
        let spawnedCommand: string[] = [];
        let spawnedEnvironment: Record<string, string | undefined> = {};
        let containerEnvironment = '';
        let environmentFileMode = 0;
        let environmentFile = '';
        const commands: string[][] = [];
        const dockerEnvironments: Array<Record<string, string | undefined>> = [];
        const mockedDocker = dockerMock(commands);
        const stdout = new Response('runner output').body as ReadableStream<Uint8Array>;
        const stderr = new Response('runner diagnostic')
            .body as ReadableStream<Uint8Array>;
        const child: SpawnedRunner = { exited: Promise.resolve(0), kill() {} };
        Object.defineProperties(child, {
            stdout: { value: stdout, enumerable: false },
            stderr: { value: stderr, enumerable: false },
        });
        const runtime = await new DockerRuntimeProvider({
            findExecutable: () => '/usr/bin/docker',
            command(command, options) {
                dockerEnvironments.push(options?.env ?? {});
                return mockedDocker(command);
            },
            spawn(command, options) {
                spawnedCommand = command;
                spawnedEnvironment = options.env ?? {};
                environmentFile = command[command.indexOf('--env-file') + 1] ?? '';
                if (environmentFile) {
                    containerEnvironment = readFileSync(environmentFile, 'utf8');
                    environmentFileMode = statSync(environmentFile).mode & 0o777;
                }
                return child;
            },
            user: () => ({ uid: 501, gid: 20 }),
        }).prepare(request(fixture, { OPENROUTER_API_KEY: 'super-secret-value' }));
        try {
            await runtime.preflight();
            const process = runtime.launch({
                command: ['opencode', 'run', '--format', 'json', 'inspect'],
                cwd: '/workspace',
                env: {
                    ...runtime.environment,
                    OPENROUTER_API_KEY: 'super-secret-value',
                    OPENCODE_CONFIG_CONTENT: '{"share":"disabled"}',
                },
            });
            expect(spawnedCommand).toContain('--network');
            expect(spawnedCommand).toContain('bridge');
            expect(spawnedCommand).toContain('--read-only');
            expect(spawnedCommand).toContain('501:20');
            expect(spawnedCommand).toContain('--env-file');
            expect(environmentFileMode).toBe(0o600);
            expect(spawnedCommand.join(' ')).not.toContain('super-secret-value');
            expect(spawnedEnvironment.OPENROUTER_API_KEY).toBeUndefined();
            expect(containerEnvironment).toContain(
                'OPENROUTER_API_KEY=super-secret-value\n'
            );
            expect(spawnedCommand).toContain(`${fixture.root}:/workspace`);
            expect(spawnedCommand).toContain(
                `${fixture.packageDirectory}:/workbench:ro`
            );
            const preflightCommands = commands.filter(
                (command) => command[1] === 'run'
            );
            expect(preflightCommands.length).toBeGreaterThan(0);
            for (const command of preflightCommands) {
                expect(command).toContain('--read-only');
                expect(command[command.indexOf('--network') + 1]).toBe('none');
                expect(command).toContain('501:20');
                expect(command).toContain(`${fixture.root}:/workspace`);
                expect(command).toContain(`${fixture.packageDirectory}:/workbench:ro`);
            }
            expect(
                dockerEnvironments.every(
                    (environment) => environment.OPENROUTER_API_KEY === undefined
                )
            ).toBeTrue();
            expect(process.stdout).toBe(stdout);
            expect(process.stderr).toBe(stderr);
            const tmpfs = spawnedCommand[spawnedCommand.indexOf('--tmpfs') + 1];
            expect(tmpfs).toContain('nosuid,nodev');
            expect(tmpfs).not.toContain('size=');
            await process.exited;
            await expect(stat(environmentFile)).rejects.toThrow();
            runtime.cancel(process);
        } finally {
            await runtime.cleanup();
        }
    });

    test('removes a cancelled container and surfaces cleanup failures', async () => {
        const fixture = await createFixture({
            image: 'ghcr.io/example/lux:0.1.0',
        });
        const commands: string[][] = [];
        const mockedDocker = dockerMock(commands);
        let killed = false;
        let environmentFile = '';
        const runtime = await new DockerRuntimeProvider({
            findExecutable: () => '/usr/bin/docker',
            command(command) {
                if (command[1] === 'container') {
                    commands.push(command);
                    return Promise.resolve(
                        result(1, '', 'daemon refused container removal')
                    );
                }
                return mockedDocker(command);
            },
            spawn(command) {
                environmentFile = command[command.indexOf('--env-file') + 1] ?? '';
                return {
                    exited: new Promise(() => {}),
                    kill() {
                        killed = true;
                    },
                };
            },
        }).prepare(request(fixture));
        await runtime.preflight();
        const process = runtime.launch({
            command: ['opencode', 'run', 'inspect'],
            cwd: runtime.workspaceDirectory,
            env: runtime.environment,
        });

        runtime.cancel(process);
        expect(killed).toBeTrue();
        await expect(runtime.cleanup()).rejects.toThrow(
            'Failed to remove container: daemon refused container removal'
        );
        expect(
            commands.some(
                (command) =>
                    command[1] === 'container' &&
                    command[2] === 'rm' &&
                    command.includes('--force')
            )
        ).toBeTrue();
        await expect(stat(dirname(environmentFile))).rejects.toThrow();
    });

    test('rejects environment values that Docker env files cannot represent', async () => {
        const fixture = await createFixture({
            image: 'ghcr.io/example/lux:0.1.0',
            env: { PROJECT_TOKEN: { required: true } },
        });
        const runtime = await new RuntimeProviderRegistry([
            new DockerRuntimeProvider({
                findExecutable: () => '/usr/bin/docker',
                command: dockerMock([]),
            }),
        ])
            .resolve('docker')
            .prepare(request(fixture, { PROJECT_TOKEN: 'line-one\nline-two' }));
        try {
            await expect(runtime.preflight()).rejects.toThrow(
                'Docker environment variable contains an unsupported newline: PROJECT_TOKEN'
            );
        } finally {
            await runtime.cleanup();
        }
    });
});

describe('Docker build preparation', () => {
    test('stages only the declared context and excludes secret-bearing paths', async () => {
        const fixture = await createFixture({ localBuild: true });
        await writeFile(join(fixture.root, 'safe.txt'), 'safe\n');
        await writeFile(join(fixture.root, '.env'), 'TOKEN=do-not-copy\n');
        await mkdir(join(fixture.root, '.git'));
        await writeFile(join(fixture.root, '.git', 'config'), 'private path\n');
        const staged = await stageDockerBuildContext(fixture.workbench);
        try {
            expect(await readFile(join(staged.context, 'safe.txt'), 'utf8')).toBe(
                'safe\n'
            );
            await expect(stat(join(staged.context, '.env'))).rejects.toThrow();
            await expect(stat(join(staged.context, '.git'))).rejects.toThrow();
            expect(staged.excludedPaths).toEqual(['.env', '.git']);
            expect(staged.digest).toMatch(/^[a-f0-9]{64}$/);
        } finally {
            await staged.cleanup();
        }
    });

    test('builds once under a content-addressed tag and then reuses it', async () => {
        const fixture = await createFixture({ localBuild: true });
        const commands: string[][] = [];
        let built = false;
        const command = dockerMock(commands, {
            inspectLocal: () => built,
            onBuild: () => {
                built = true;
            },
        });
        const provider = new DockerRuntimeProvider({
            findExecutable: () => '/usr/bin/docker',
            command,
        });
        const first = await provider.prepare(request(fixture));
        const second = await provider.prepare(request(fixture));
        try {
            expect(first.preparation).toMatchObject({ action: 'built' });
            expect(second.preparation).toMatchObject({ action: 'cache-hit' });
            expect(
                commands.filter(
                    (candidate) => candidate[1] === 'buildx' && candidate[2] === 'build'
                )
            ).toHaveLength(1);
            expect(first.preparation?.cacheKey).toBe(second.preparation?.cacheKey);
        } finally {
            await first.cleanup();
            await second.cleanup();
        }
    });

    test('removes the staged context after an interrupted image build', async () => {
        const fixture = await createFixture({ localBuild: true });
        const commands: string[][] = [];
        const mockedDocker = dockerMock(commands);
        let stagedContext = '';
        const provider = new DockerRuntimeProvider({
            findExecutable: () => '/usr/bin/docker',
            command(command) {
                if (command[1] === 'buildx') {
                    commands.push(command);
                    stagedContext = command.at(-1) ?? '';
                    return Promise.resolve(result(130, '', 'build interrupted'));
                }
                return mockedDocker(command);
            },
        });

        await expect(provider.prepare(request(fixture))).rejects.toThrow(
            'Failed to build Docker image for lux-core: build interrupted'
        );
        expect(stagedContext).not.toBe('');
        await expect(stat(dirname(stagedContext))).rejects.toThrow();
    });

    test('rejects symlinks that escape the declared build context', async () => {
        const fixture = await createFixture({ localBuild: true });
        const outside = await mkdtemp(join(tmpdir(), 'workbench-docker-outside-'));
        temporaryDirectories.push(outside);
        await writeFile(join(outside, 'private.txt'), 'do not stage\n');
        await symlink(
            join(outside, 'private.txt'),
            join(fixture.packageDirectory, 'private-link')
        );

        await expect(stageDockerBuildContext(fixture.workbench)).rejects.toThrow(
            'Absolute symlink is not allowed in Docker build context: .workbenches/core/private-link'
        );
    });

    test('rejects a declared build context that resolves outside the repository', async () => {
        const fixture = await createFixture({ localBuild: true });
        const outside = await mkdtemp(join(tmpdir(), 'workbench-docker-context-'));
        temporaryDirectories.push(outside);
        await writeFile(join(outside, 'file.txt'), 'outside\n');
        await symlink(outside, join(fixture.packageDirectory, 'outside-context'));
        if (
            !fixture.workbench.manifest.image ||
            typeof fixture.workbench.manifest.image === 'string'
        ) {
            throw new Error('Expected a local image fixture');
        }
        fixture.workbench.manifest.image.context = './outside-context';

        await expect(stageDockerBuildContext(fixture.workbench)).rejects.toThrow(
            'Docker build context resolves outside the repository: ./outside-context'
        );
    });
});

function dockerMock(
    commands: string[][],
    options: {
        missing?: string;
        inspectLocal?: () => boolean;
        onBuild?: () => void;
    } = {}
) {
    return async (command: string[]): Promise<DockerCommandResult> => {
        commands.push(command);
        if (command[1] === 'version') return result(0, '28.1.1\n');
        if (command[1] === 'buildx') {
            options.onBuild?.();
            return result(0, 'built\n');
        }
        if (command[1] === 'image' && command[2] === 'pull') {
            return result(0, 'sha256:local\n');
        }
        if (command[1] === 'image' && command[2] === 'inspect') {
            const reference = command[3] ?? '';
            if (reference.startsWith('workbench-local/') && !options.inspectLocal?.()) {
                return result(1, '', 'No such image');
            }
            return result(
                0,
                `${JSON.stringify({
                    Id: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                    RepoDigests: [
                        'ghcr.io/example/lux@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                    ],
                })}\n`
            );
        }
        if (command[1] === 'run') {
            const requested = command.at(-1);
            if (command.includes('command -v "$1" 2>/dev/null')) {
                return requested === options.missing
                    ? result(127, '', 'not found')
                    : result(0, `/usr/local/bin/${requested}\n`);
            }
            return result(0);
        }
        if (command[1] === 'container') return result(0);
        throw new Error(`Unexpected Docker command: ${command.join(' ')}`);
    };
}

function result(code: number, stdout = '', stderr = ''): DockerCommandResult {
    return { code, stdout, stderr };
}

async function createFixture(options: {
    image?: string;
    localBuild?: boolean;
    tools?: string[];
    env?: Record<string, { required: boolean }>;
}): Promise<{
    root: string;
    packageDirectory: string;
    workbench: ResolvedWorkbench;
}> {
    const root = await mkdtemp(join(tmpdir(), 'workbench-docker-test-'));
    temporaryDirectories.push(root);
    const packageDirectory = join(root, '.workbenches', 'core');
    await mkdir(packageDirectory, { recursive: true });
    const instructionsPath = join(packageDirectory, 'instructions.md');
    const manifestPath = join(packageDirectory, 'workbench.yml');
    await writeFile(instructionsPath, '# Instructions\n');
    if (options.localBuild) {
        await writeFile(
            join(packageDirectory, 'Dockerfile.workbench'),
            'FROM alpine:3.22\n'
        );
    }
    const image = options.localBuild
        ? { build: './Dockerfile.workbench', context: '../..' }
        : options.image;
    const workbench: ResolvedWorkbench = {
        manifestPath,
        packageDirectory,
        repositoryDirectory: root,
        instructionsPath,
        skills: [],
        manifest: {
            spec: 0,
            version: '0.1.0',
            name: 'lux-core',
            runner: 'opencode',
            model: 'openrouter/openai/gpt-5.6-terra',
            instructions: './instructions.md',
            skills: [],
            tools: options.tools ?? [],
            mcps: [],
            env: options.env ?? {},
            runtime: 'docker',
            ...(image ? { image } : {}),
        },
    };
    await writeFile(manifestPath, Bun.YAML.stringify(workbench.manifest));
    return { root, packageDirectory, workbench };
}

function request(
    fixture: { root: string; packageDirectory: string; workbench: ResolvedWorkbench },
    environment: Record<string, string | undefined> = {}
) {
    return {
        workbench: fixture.workbench,
        workspaceDirectory: fixture.root,
        environment,
        assets: [
            { path: fixture.root, access: 'read-write' as const },
            {
                path: fixture.packageDirectory,
                access: 'read-only' as const,
            },
        ],
    };
}

describe('Docker runtime provider contract', () => {
    runtimeProviderContract({
        request: async () => {
            const fixture = await createFixture({
                image: 'ghcr.io/example/lux:0.1.0',
            });
            return request(fixture);
        },
        createProvider: () =>
            new DockerRuntimeProvider({
                findExecutable: () => '/usr/bin/docker',
                command: dockerMock([]),
                spawn: () => ({ exited: Promise.resolve(0), kill() {} }),
                user: () => ({ uid: 501, gid: 20 }),
            }),
    });
});
