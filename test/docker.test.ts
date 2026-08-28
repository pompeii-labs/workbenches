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
import { DockerBuildContext } from '../src/runtimes/docker/build-context.js';
import { DockerCredentialVolume } from '../src/runtimes/docker/credentials.js';
import {
    type DockerCommandResult,
    DockerRuntimeProvider,
} from '../src/runtimes/docker/index.js';
import { RuntimeRegistry } from '../src/runtimes/index.js';
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

    test('requires authorization and preserves host paths for a host engine binding', async () => {
        const fixture = await createFixture({
            image: 'ghcr.io/example/lux:0.1.0',
            dockerEngine: true,
        });
        let resolvedSocket = false;
        const provider = new DockerRuntimeProvider({
            findExecutable: () => '/usr/bin/docker',
            command: dockerMock([]),
            hostSocket: async () => {
                resolvedSocket = true;
                return { path: fixture.workbench.manifestPath, gid: 20 };
            },
        });

        await expect(provider.prepare(request(fixture))).rejects.toThrow(
            'Host Docker engine access requires explicit --allow-host-docker authorization'
        );
        expect(resolvedSocket).toBeFalse();

        let spawnedCommand: string[] = [];
        const runtime = await new DockerRuntimeProvider({
            findExecutable: () => '/usr/bin/docker',
            command: dockerMock([]),
            hostSocket: async () => ({
                path: fixture.workbench.manifestPath,
                gid: 20,
            }),
            spawn(command) {
                spawnedCommand = command;
                return { exited: Promise.resolve(0), kill() {} };
            },
        }).prepare({
            ...request(fixture),
            authorizations: { hostDocker: true },
        });
        try {
            expect(runtime.workspaceDirectory).toBe(fixture.root);
            expect(runtime.environment).toMatchObject({
                DOCKER_HOST: 'unix:///var/run/docker.sock',
                WORKBENCH_DOCKER_ENGINE: 'host',
            });
            await runtime.preflight();
            runtime.launch({
                command: ['opencode', 'run', 'inspect'],
                cwd: runtime.workspaceDirectory,
                env: runtime.environment,
            });
            expect(spawnedCommand).toContain(`${fixture.root}:${fixture.root}`);
            expect(spawnedCommand).toContain(
                `${fixture.workbench.manifestPath}:/var/run/docker.sock`
            );
            expect(spawnedCommand).toContain('--group-add');
            expect(spawnedCommand).toContain('20');
        } finally {
            await runtime.cleanup();
        }
    });

    test('rejects a non-Unix Docker context without falling back', async () => {
        const fixture = await createFixture({
            image: 'ghcr.io/example/lux:0.1.0',
            dockerEngine: true,
        });
        const mockedDocker = dockerMock([]);
        const provider = new DockerRuntimeProvider({
            findExecutable: () => '/usr/bin/docker',
            command(command) {
                if (command[1] === 'context') {
                    return Promise.resolve(result(0, 'tcp://docker.example:2376\n'));
                }
                return mockedDocker(command);
            },
        });

        await expect(
            provider.prepare({
                ...request(fixture),
                authorizations: { hostDocker: true },
            })
        ).rejects.toThrow(
            'Host Docker engine binding requires a Unix socket context; received tcp://docker.example:2376'
        );
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

    test('remaps packaged runner configuration into the container', async () => {
        const fixture = await createFixture({
            image: 'ghcr.io/example/lux:0.1.0',
        });
        const runnerConfigPath = join(fixture.packageDirectory, 'opencode.json');
        await writeFile(runnerConfigPath, '{"share":"disabled"}\n');
        fixture.workbench.runnerConfigPath = runnerConfigPath;
        const runtime = await new DockerRuntimeProvider({
            findExecutable: () => '/usr/bin/docker',
            command: dockerMock([]),
        }).prepare(request(fixture));
        try {
            expect(runtime.workbench.runnerConfigPath).toBe('/workbench/opencode.json');
        } finally {
            await runtime.cleanup();
        }
    });

    test('does not create or mount credential storage while preparing an image build', async () => {
        const fixture = await createFixture({
            image: 'ghcr.io/example/lux:0.1.0',
        });
        const commands: string[][] = [];
        const runtime = await new DockerRuntimeProvider({
            findExecutable: () => '/usr/bin/docker',
            command: dockerMock(commands),
        }).prepare({ ...request(fixture), purpose: 'build' });
        try {
            expect(
                commands.some(
                    (command) => command[1] === 'volume' && command[2] === 'create'
                )
            ).toBeFalse();
            expect(runtime.environment.WORKBENCH_CREDENTIALS_DIR).toBeUndefined();
        } finally {
            await runtime.cleanup();
        }
    });

    test('runs native authentication in the runner credential volume', async () => {
        const fixture = await createFixture({
            image: 'ghcr.io/example/lux:0.1.0',
        });
        const commands: string[][] = [];
        let interactiveCommand: string[] = [];
        let interactiveEnvironment = '';
        const runtime = await new DockerRuntimeProvider({
            findExecutable: () => '/usr/bin/docker',
            command: dockerMock(commands),
            interact(command) {
                interactiveCommand = command;
                const environmentFile = command[command.indexOf('--env-file') + 1];
                if (environmentFile) {
                    interactiveEnvironment = readFileSync(environmentFile, 'utf8');
                }
                return Promise.resolve(0);
            },
            user: () => ({ uid: 501, gid: 20 }),
        }).prepare({ ...request(fixture), purpose: 'connect' });
        try {
            await expect(
                runtime.interact({
                    command: ['opencode', 'auth', 'login'],
                    cwd: runtime.workspaceDirectory,
                    env: runtime.environment,
                })
            ).resolves.toBe(0);
            const volume = DockerCredentialVolume.nameFor('opencode');
            expect(
                commands.some(
                    (command) =>
                        command[1] === 'volume' &&
                        command[2] === 'create' &&
                        command[3] === volume
                )
            ).toBeTrue();
            expect(interactiveCommand).toContain(`${volume}:/workbench-credentials`);
            expect(interactiveCommand).toContain('--interactive');
            expect(interactiveEnvironment).toContain(
                'XDG_DATA_HOME=/workbench-credentials\n'
            );
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
        const runtime = await new RuntimeRegistry([
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

    test('mounts only declared assets and isolates model provider credentials', async () => {
        const fixture = await createFixture({
            image: 'ghcr.io/example/lux:0.1.0',
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
            expect(spawnedCommand).toContain(
                `${DockerCredentialVolume.nameFor('opencode')}:/workbench-credentials`
            );
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
            expect(spawnedCommand).toContain(
                `${fixture.packageDirectory}:/workspace/.workbenches/core:ro`
            );
            const preflightCommands = commands.filter(
                (command) =>
                    command[1] === 'run' &&
                    command.includes('command -v "$1" 2>/dev/null')
            );
            expect(preflightCommands.length).toBeGreaterThan(0);
            for (const command of preflightCommands) {
                expect(command).toContain('--read-only');
                expect(command[command.indexOf('--network') + 1]).toBe('none');
                expect(command).toContain('501:20');
                expect(command).toContain(`${fixture.root}:/workspace`);
                expect(command).toContain(`${fixture.packageDirectory}:/workbench:ro`);
                expect(command).toContain(
                    `${fixture.packageDirectory}:/workspace/.workbenches/core:ro`
                );
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

    test('mounts named workspaces at deterministic paths with declared access', async () => {
        const fixture = await createFixture({
            image: 'ghcr.io/example/lux:0.1.0',
        });
        const api = await mkdtemp(join(tmpdir(), 'workbench-api-test-'));
        const schemas = await mkdtemp(join(tmpdir(), 'workbench-schemas-test-'));
        temporaryDirectories.push(api, schemas);
        let spawnedCommand: string[] = [];
        let containerEnvironment = '';
        const runtime = await new DockerRuntimeProvider({
            findExecutable: () => '/usr/bin/docker',
            command: dockerMock([]),
            spawn(command) {
                spawnedCommand = command;
                const environmentFile = command[command.indexOf('--env-file') + 1];
                if (environmentFile) {
                    containerEnvironment = readFileSync(environmentFile, 'utf8');
                }
                return { exited: Promise.resolve(0), kill() {} };
            },
        }).prepare({
            ...request(fixture),
            assets: [
                ...request(fixture).assets,
                { path: api, access: 'read-write', workspace: 'api' },
                { path: schemas, access: 'read-only', workspace: 'schemas' },
            ],
        });
        try {
            expect(runtime.workspaces).toEqual([
                { name: 'api', path: '/workspaces/api', access: 'read-write' },
                {
                    name: 'schemas',
                    path: '/workspaces/schemas',
                    access: 'read-only',
                },
            ]);
            await runtime.preflight();
            runtime.launch({
                command: ['opencode', 'run', 'inspect'],
                cwd: runtime.workspaceDirectory,
                env: runtime.environment,
            });
            expect(spawnedCommand).toContain(`${api}:/workspaces/api`);
            expect(spawnedCommand).toContain(`${schemas}:/workspaces/schemas:ro`);
            expect(containerEnvironment).toContain(
                'WORKBENCH_WORKSPACE_API=/workspaces/api\n'
            );
            expect(containerEnvironment).toContain(
                'WORKBENCH_WORKSPACE_SCHEMAS=/workspaces/schemas\n'
            );
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
        const runtime = await new RuntimeRegistry([
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
        const staged = await DockerBuildContext.stage(fixture.workbench);
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

        await expect(DockerBuildContext.stage(fixture.workbench)).rejects.toThrow(
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

        await expect(DockerBuildContext.stage(fixture.workbench)).rejects.toThrow(
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
        if (command[1] === 'volume' && command[2] === 'create') {
            return result(0, `${command[3] ?? ''}\n`);
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
    dockerEngine?: boolean;
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
            model: { id: 'openai/gpt-5.6-terra' },
            instructions: './instructions.md',
            skills: [],
            tools: options.tools ?? [],
            mcps: [],
            env: options.env ?? {},
            runtime: 'docker',
            ...(image ? { image } : {}),
            ...(options.dockerEngine
                ? { docker: { engine: { mode: 'host' as const } } }
                : {}),
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
