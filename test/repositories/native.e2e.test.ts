import { describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RepositoryWorkspace } from '../../src/repositories/workspace.js';
import { DockerRuntimeProvider } from '../../src/runtimes/docker/provider.js';
import { E2BRuntimeProvider } from '../../src/runtimes/e2b/provider.js';
import type { ResolvedWorkbench } from '../../src/types.js';
import { activateModelCatalogFixture } from '../model-catalog-fixture.js';
import { checkoutFixture, fixtureIdentity } from './fixture.js';

const identityEnvironment = (
    identity: Awaited<ReturnType<typeof fixtureIdentity>>
) => ({
    PATH: process.env.PATH,
    GH_TOKEN: 'fixture-token',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '4',
    GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_1: '!gh auth git-credential',
    GIT_CONFIG_KEY_2: 'user.name',
    GIT_CONFIG_VALUE_2: identity.name,
    GIT_CONFIG_KEY_3: 'user.email',
    GIT_CONFIG_VALUE_3: identity.email,
});

describe.skipIf(process.env.WORKBENCH_REPOSITORY_NATIVE_E2E !== '1')(
    'native repository Git in E2B',
    () => {
        test('preserves the agent branch and commit across sandbox restarts', async () => {
            activateModelCatalogFixture();
            const fixture = await checkoutFixture();
            const packageDirectory = join(fixture.root, '.workbenches', 'native');
            await mkdir(packageDirectory, { recursive: true });
            await writeFile(
                join(packageDirectory, 'Dockerfile'),
                'FROM e2bdev/base:latest\nUSER root\nRUN ln -s /bin/sh /usr/local/bin/opencode\n'
            );
            await writeFile(join(packageDirectory, 'workbench.yml'), 'fixture');
            await writeFile(join(packageDirectory, 'instructions.md'), 'fixture');
            const workbench: ResolvedWorkbench = {
                packageDirectory,
                repositoryDirectory: packageDirectory,
                manifestPath: join(packageDirectory, 'workbench.yml'),
                instructionsPath: join(packageDirectory, 'instructions.md'),
                skills: [],
                manifest: {
                    spec: 0,
                    name: 'native-repository-e2e',
                    version: '0.0.1',
                    runner: 'opencode',
                    model: { id: 'openai/gpt-5.6-terra' },
                    runtime: 'e2b',
                    image: { build: './Dockerfile', context: '.' },
                    instructions: './instructions.md',
                    skills: [],
                    tools: [],
                    mcps: [],
                    env: {},
                },
            };
            const binding = fixture.binding;
            const workspace = new RepositoryWorkspace(
                fixture.home,
                binding,
                { PATH: process.env.PATH, GH_TOKEN: 'fixture-token' },
                fixture.git,
                fixtureIdentity
            );
            const provider = new E2BRuntimeProvider();
            const prepare = async () => {
                const identity = await workspace.prepare('e2b');
                if (!identity) throw new Error('Repository identity is missing');
                const runtime = await provider.prepare({
                    workbench,
                    workspaceDirectory: workspace.directory,
                    environment: {
                        ...identityEnvironment(identity),
                        E2B_API_KEY: process.env.E2B_API_KEY,
                    },
                    assets: [
                        { path: workspace.directory, access: 'read-write' },
                        {
                            path: workspace.agentGitDirectory,
                            access: 'read-write',
                            git: true,
                        },
                        { path: packageDirectory, access: 'read-only' },
                    ],
                    repository: {
                        name: 'example/project',
                        revision: binding.revision,
                        delivery: 'pr',
                    },
                });
                await runtime.preflight();
                return runtime;
            };
            const execute = async (
                runtime: Awaited<ReturnType<typeof prepare>>,
                command: string
            ) => {
                const child = runtime.launch({
                    command: ['/bin/sh', '-c', command],
                    cwd: runtime.workspaceDirectory,
                    env: runtime.environment,
                });
                const [stdout, stderr, code] = await Promise.all([
                    new Response(child.stdout).text(),
                    new Response(child.stderr).text(),
                    child.exited,
                ]);
                if (code !== 0)
                    throw new Error(
                        `Native Git smoke exited ${code}: ${stderr || stdout}`
                    );
                return stdout.trim();
            };
            const first = await prepare();
            try {
                expect(
                    await execute(
                        first,
                        "git switch -c native-smoke && git commit --allow-empty -m 'Native Git smoke' && git branch --show-current && git log -1 --format='%an <%ae>'"
                    )
                ).toContain('example <123+example@users.noreply.github.com>');
            } finally {
                await first.cleanup();
            }
            const resumed = await prepare();
            try {
                expect(await execute(resumed, 'git branch --show-current')).toBe(
                    'native-smoke'
                );
                expect(await execute(resumed, 'git log -1 --format=%s')).toBe(
                    'Native Git smoke'
                );
                expect(await execute(resumed, 'git remote get-url origin')).toBe(
                    'https://github.com/example/project.git'
                );
            } finally {
                await resumed.cleanup();
            }
        }, 240_000);
    }
);

describe.skipIf(process.env.WORKBENCH_REPOSITORY_DOCKER_E2E !== '1')(
    'native repository Git in Docker',
    () => {
        test('preserves the agent branch and commit across containers', async () => {
            activateModelCatalogFixture();
            const fixture = await checkoutFixture();
            const packageDirectory = join(
                fixture.root,
                '.workbenches',
                'docker-native'
            );
            await mkdir(packageDirectory, { recursive: true });
            await writeFile(
                join(packageDirectory, 'Dockerfile'),
                'FROM alpine:3.20\nRUN apk add --no-cache git && ln -s /bin/sh /usr/local/bin/opencode\n'
            );
            await writeFile(join(packageDirectory, 'workbench.yml'), 'fixture');
            await writeFile(join(packageDirectory, 'instructions.md'), 'fixture');
            const workbench: ResolvedWorkbench = {
                packageDirectory,
                repositoryDirectory: packageDirectory,
                manifestPath: join(packageDirectory, 'workbench.yml'),
                instructionsPath: join(packageDirectory, 'instructions.md'),
                skills: [],
                manifest: {
                    spec: 0,
                    name: 'native-repository-docker',
                    version: '0.0.1',
                    runner: 'opencode',
                    model: { id: 'openai/gpt-5.6-terra' },
                    runtime: 'docker',
                    image: { build: './Dockerfile', context: '.' },
                    instructions: './instructions.md',
                    skills: [],
                    tools: [],
                    mcps: [],
                    env: {},
                },
            };
            const binding = fixture.binding;
            const workspace = new RepositoryWorkspace(
                fixture.home,
                binding,
                { PATH: process.env.PATH, GH_TOKEN: 'fixture-token' },
                fixture.git,
                fixtureIdentity
            );
            const provider = new DockerRuntimeProvider();
            const prepare = async () => {
                const identity = await workspace.prepare('docker');
                if (!identity) throw new Error('Repository identity is missing');
                const runtime = await provider.prepare({
                    workbench,
                    workspaceDirectory: workspace.directory,
                    environment: identityEnvironment(identity),
                    assets: [
                        { path: workspace.directory, access: 'read-write' },
                        {
                            path: workspace.agentGitDirectory,
                            access: 'read-write',
                            git: true,
                        },
                        { path: packageDirectory, access: 'read-only' },
                    ],
                    repository: {
                        name: 'example/project',
                        revision: binding.revision,
                        delivery: 'pr',
                    },
                });
                await runtime.preflight();
                return runtime;
            };
            const execute = async (
                runtime: Awaited<ReturnType<typeof prepare>>,
                command: string
            ) => {
                const child = runtime.launch({
                    command: ['/bin/sh', '-c', command],
                    cwd: runtime.workspaceDirectory,
                    env: runtime.environment,
                });
                const [stdout, stderr, code] = await Promise.all([
                    new Response(child.stdout).text(),
                    new Response(child.stderr).text(),
                    child.exited,
                ]);
                if (code !== 0)
                    throw new Error(
                        `Native Git smoke exited ${code}: ${stderr || stdout}`
                    );
                return stdout.trim();
            };
            const first = await prepare();
            try {
                expect(
                    await execute(
                        first,
                        "git switch -c docker-smoke && git commit --allow-empty -m 'Docker Git smoke' && git branch --show-current && git log -1 --format='%an <%ae>'"
                    )
                ).toContain('example <123+example@users.noreply.github.com>');
            } finally {
                await first.cleanup();
            }
            const resumed = await prepare();
            try {
                expect(await execute(resumed, 'git branch --show-current')).toBe(
                    'docker-smoke'
                );
                expect(await execute(resumed, 'git log -1 --format=%s')).toBe(
                    'Docker Git smoke'
                );
                expect(await execute(resumed, 'git remote get-url origin')).toBe(
                    'https://github.com/example/project.git'
                );
            } finally {
                await resumed.cleanup();
            }
        }, 180_000);
    }
);
