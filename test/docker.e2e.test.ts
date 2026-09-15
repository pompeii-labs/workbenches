import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InteractiveRun, RunStore, type WorkbenchEvent } from '../src/runs/index.js';
import {
    DockerManagedContainers,
    DockerRuntimeProvider,
} from '../src/runtimes/docker/index.js';
import { SessionRetention } from '../src/sessions/index.js';
import type { ResolvedWorkbench } from '../src/types.js';

const temporaryDirectories: string[] = [];
const dockerTest = process.env.WORKBENCH_DOCKER_E2E === '1' ? test : test.skip;
const dockerSessionTest =
    process.env.WORKBENCH_DOCKER_SESSION_E2E === '1' ? test : test.skip;

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(removeTemporaryDirectory));
});

async function removeTemporaryDirectory(directory: string): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
            await rm(directory, { recursive: true, force: true });
            return;
        } catch (error) {
            if (
                !(error instanceof Error) ||
                !('code' in error) ||
                error.code !== 'EACCES' ||
                attempt === 19
            ) {
                throw error;
            }
            await Bun.sleep(25);
        }
    }
}

describe('Docker runtime end-to-end', () => {
    dockerTest(
        'removes only a scoped managed container whose run no longer exists',
        async () => {
            const home = await mkdtemp(join(tmpdir(), 'workbench-docker-clean-'));
            temporaryDirectories.push(home);
            const run = { id: RunStore.createId(), scope: RunStore.scope(home) };
            const name = `workbench-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
            const launched = Bun.spawn(
                [
                    'docker',
                    'run',
                    '--detach',
                    '--name',
                    name,
                    ...DockerManagedContainers.labels(run),
                    'alpine:3.22',
                    'sleep',
                    '30',
                ],
                { stdout: 'pipe', stderr: 'pipe' }
            );
            const [code, stderr] = await Promise.all([
                launched.exited,
                new Response(launched.stderr).text(),
            ]);
            expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
            try {
                const containers = await DockerManagedContainers.connect(run.scope);
                if (!containers) throw new Error('Docker is unavailable');
                const retention = new SessionRetention(home, { containers });

                const review = await retention.review({ before: new Date() });
                expect(review.containers.map((container) => container.name)).toEqual([
                    name,
                ]);
                const result = await retention.apply({ before: new Date() });
                expect(result.removedContainers).toHaveLength(1);
                expect(await dockerContainerExists(name)).toBeFalse();
            } finally {
                await Bun.spawn(['docker', 'container', 'rm', '--force', name], {
                    stdout: 'ignore',
                    stderr: 'ignore',
                }).exited;
            }
        },
        120_000
    );

    dockerTest(
        'enforces workspace, package, root, temporary home, and host-user policy',
        async () => {
            const fixture = await createFixture();
            const api = await mkdtemp(join(tmpdir(), 'workbench-docker-api-'));
            const schemas = await mkdtemp(join(tmpdir(), 'workbench-docker-schemas-'));
            temporaryDirectories.push(api, schemas);
            await writeFile(join(schemas, 'schema.txt'), 'schema-input\n');
            const runtime = await new DockerRuntimeProvider().prepare({
                workbench: fixture.workbench,
                workspaceDirectory: fixture.root,
                environment: {},
                assets: [
                    { path: fixture.root, access: 'read-write' },
                    { path: fixture.packageDirectory, access: 'read-only' },
                    { path: api, access: 'read-write', workspace: 'api' },
                    {
                        path: schemas,
                        access: 'read-only',
                        workspace: 'schemas',
                    },
                ],
            });
            try {
                await runtime.preflight();
                const child = runtime.launch({
                    command: [
                        '/bin/sh',
                        '-c',
                        [
                            'set -eu',
                            'printf "workspace-write\\n" > /workspace/docker-e2e-output',
                            "if sh -c 'printf package-write > /workbench/must-not-write' 2>/dev/null; then exit 41; fi",
                            "if sh -c 'printf package-alias-write > /workspace/.workbenches/core/must-not-write' 2>/dev/null; then exit 44; fi",
                            "if sh -c 'printf root-write > /must-not-write' 2>/dev/null; then exit 42; fi",
                            'test "$WORKBENCH_WORKSPACE_API" = /workspaces/api',
                            'test "$WORKBENCH_WORKSPACE_SCHEMAS" = /workspaces/schemas',
                            'printf "api-write\n" > "$WORKBENCH_WORKSPACE_API/output.txt"',
                            'test "$(cat "$WORKBENCH_WORKSPACE_SCHEMAS/schema.txt")" = schema-input',
                            "if sh -c 'printf schema-write > /workspaces/schemas/must-not-write' 2>/dev/null; then exit 43; fi",
                            'mkdir -p "$HOME"',
                            'test -w "$HOME"',
                            'printf "%s:%s\\n" "$(id -u)" "$(id -g)"',
                        ].join('\n'),
                    ],
                    cwd: runtime.workspaceDirectory,
                    env: runtime.environment,
                });
                const [code, stdout, stderr] = await Promise.all([
                    child.exited,
                    child.stdout
                        ? new Response(child.stdout).text()
                        : Promise.resolve(''),
                    child.stderr
                        ? new Response(child.stderr).text()
                        : Promise.resolve(''),
                ]);

                expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
                expect(
                    await readFile(join(fixture.root, 'docker-e2e-output'), 'utf8')
                ).toBe('workspace-write\n');
                expect(await readFile(join(api, 'output.txt'), 'utf8')).toBe(
                    'api-write\n'
                );
                await expect(stat(join(schemas, 'must-not-write'))).rejects.toThrow();
                await expect(
                    stat(join(fixture.packageDirectory, 'must-not-write'))
                ).rejects.toThrow();
                if (
                    typeof process.getuid === 'function' &&
                    typeof process.getgid === 'function'
                ) {
                    expect(stdout.trim()).toBe(
                        `${process.getuid()}:${process.getgid()}`
                    );
                }
            } finally {
                await runtime.cleanup();
            }
        },
        120_000
    );

    dockerTest(
        'allows explicitly authorized nested Docker with host-visible workspace paths',
        async () => {
            const fixture = await createFixture({ hostDocker: true });
            const sibling = await mkdtemp(
                join(tmpdir(), 'workbench-docker-host-sibling-')
            );
            temporaryDirectories.push(sibling);
            await writeFile(join(fixture.root, 'primary-input'), 'primary\n');
            await writeFile(join(sibling, 'sibling-input'), 'sibling\n');
            const runtime = await new DockerRuntimeProvider().prepare({
                workbench: fixture.workbench,
                workspaceDirectory: fixture.root,
                environment: {},
                authorizations: { hostDocker: true },
                assets: [
                    { path: fixture.root, access: 'read-write' },
                    { path: fixture.packageDirectory, access: 'read-only' },
                    {
                        path: sibling,
                        access: 'read-only',
                        workspace: 'sibling',
                    },
                ],
            });
            try {
                await runtime.preflight();
                expect(runtime.workspaceDirectory).toBe(fixture.root);
                expect(runtime.workspaces).toEqual([
                    { name: 'sibling', path: sibling, access: 'read-only' },
                ]);
                const child = runtime.launch({
                    command: [
                        '/bin/sh',
                        '-c',
                        [
                            'set -eu',
                            'test "$(docker run --rm --volume "$PWD:/primary:ro" alpine:3.22 cat /primary/primary-input)" = primary',
                            'test "$(docker run --rm --volume "$WORKBENCH_WORKSPACE_SIBLING:/sibling:ro" alpine:3.22 cat /sibling/sibling-input)" = sibling',
                        ].join('\n'),
                    ],
                    cwd: runtime.workspaceDirectory,
                    env: runtime.environment,
                });
                const [code, stderr] = await Promise.all([
                    child.exited,
                    child.stderr
                        ? new Response(child.stderr).text()
                        : Promise.resolve(''),
                ]);
                expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
            } finally {
                await runtime.cleanup();
            }
        },
        120_000
    );

    dockerTest(
        'cleans up cancelled and failed session containers',
        async () => {
            const fixture = await createFixture();
            const before = await workbenchContainers();

            const cancelledRuntime = await new DockerRuntimeProvider().prepare({
                workbench: fixture.workbench,
                workspaceDirectory: fixture.root,
                environment: {},
                assets: [
                    { path: fixture.root, access: 'read-write' },
                    { path: fixture.packageDirectory, access: 'read-only' },
                ],
            });
            await cancelledRuntime.preflight();
            const cancelled = cancelledRuntime.launchSession(
                {
                    command: ['/bin/sh', '-c', 'sleep 30'],
                    cwd: cancelledRuntime.workspaceDirectory,
                    env: cancelledRuntime.environment,
                },
                { stdin: 'pipe' }
            );
            await waitForAdditionalContainer(before);
            cancelledRuntime.cancel(cancelled);
            await cancelledRuntime.cleanup();
            await expectWorkbenchContainers(before);

            const failedRuntime = await new DockerRuntimeProvider().prepare({
                workbench: fixture.workbench,
                workspaceDirectory: fixture.root,
                environment: {},
                assets: [
                    { path: fixture.root, access: 'read-write' },
                    { path: fixture.packageDirectory, access: 'read-only' },
                ],
            });
            await failedRuntime.preflight();
            const failed = failedRuntime.launchSession(
                {
                    command: ['/bin/sh', '-c', 'exit 23'],
                    cwd: failedRuntime.workspaceDirectory,
                    env: failedRuntime.environment,
                },
                { stdin: 'ignore' }
            );
            expect(await failed.exited).toBe(23);
            await failedRuntime.cleanup();
            await expectWorkbenchContainers(before);
        },
        120_000
    );
});

describe('Docker interactive sessions end-to-end', () => {
    for (const runner of ['opencode', 'pi'] as const) {
        dockerSessionTest(
            `preserves and resumes a real ${runner} session without orphaning its container`,
            async () => {
                const fixture = await createSessionFixture(runner);
                const nativeDirectory = await mkdtemp(
                    join(tmpdir(), `workbench-${runner}-session-`)
                );
                temporaryDirectories.push(nativeDirectory);
                const before = await workbenchContainers();
                const sessionContext = {
                    id: `wb_docker_${runner}_e2e`,
                    directory: nativeDirectory,
                };
                const firstEvents: WorkbenchEvent[] = [];
                const first = await InteractiveRun.start({
                    resolved: {
                        workbench: fixture.workbench,
                        workspaceDirectory: fixture.root,
                        cleanup: async () => {},
                    },
                    session: sessionContext,
                    onEvent: (event) => void firstEvents.push(event),
                });
                await first.send(
                    'Remember the codeword topaz. Reply with exactly: remembered'
                );
                await first.send(
                    'Reply with exactly the codeword I asked you to remember.'
                );
                const nativeSessionId = first.runnerSessionId;
                expect(nativeSessionId).toBeString();
                expect(outputText(firstEvents)).toContain('topaz');
                await first.close();

                const resumedEvents: WorkbenchEvent[] = [];
                const resumed = await InteractiveRun.start({
                    resolved: {
                        workbench: fixture.workbench,
                        workspaceDirectory: fixture.root,
                        cleanup: async () => {},
                    },
                    session: {
                        ...sessionContext,
                        nativeSessionId: nativeSessionId as string,
                    },
                    onEvent: (event) => void resumedEvents.push(event),
                });
                await resumed.send(
                    'Reply with exactly the codeword from the prior process.'
                );
                expect(outputText(resumedEvents)).toContain('topaz');
                await resumed.close();

                expect(await workbenchContainers()).toEqual(before);
            },
            300_000
        );
    }
});

async function createFixture(options: { hostDocker?: boolean } = {}): Promise<{
    root: string;
    packageDirectory: string;
    workbench: ResolvedWorkbench;
}> {
    const root = await mkdtemp(join(tmpdir(), 'workbench-docker-e2e-'));
    temporaryDirectories.push(root);
    const packageDirectory = join(root, '.workbenches', 'core');
    await mkdir(packageDirectory, { recursive: true });
    const instructionsPath = join(packageDirectory, 'instructions.md');
    const manifestPath = join(packageDirectory, 'workbench.yml');
    await writeFile(instructionsPath, '# Docker runtime probe\n');
    const workbench: ResolvedWorkbench = {
        manifestPath,
        packageDirectory,
        repositoryDirectory: root,
        instructionsPath,
        skills: [],
        manifest: {
            spec: 0,
            version: '0.1.0',
            name: 'docker-runtime-probe',
            runner: 'sh',
            model: { id: 'openai/gpt-5.6-terra' },
            instructions: './instructions.md',
            skills: [],
            tools: [],
            mcps: [],
            env: {},
            runtime: 'docker',
            image: options.hostDocker ? 'docker:28-cli' : 'alpine:3.22',
            ...(options.hostDocker
                ? { docker: { engine: { mode: 'host' as const } } }
                : {}),
        },
    };
    await writeFile(manifestPath, Bun.YAML.stringify(workbench.manifest));
    return { root, packageDirectory, workbench };
}

async function createSessionFixture(runner: 'opencode' | 'pi'): Promise<{
    root: string;
    packageDirectory: string;
    workbench: ResolvedWorkbench;
}> {
    const root = await mkdtemp(join(tmpdir(), `workbench-${runner}-e2e-`));
    temporaryDirectories.push(root);
    const packageDirectory = join(root, '.workbenches', runner);
    await mkdir(packageDirectory, { recursive: true });
    const instructionsPath = join(packageDirectory, 'instructions.md');
    const manifestPath = join(packageDirectory, 'workbench.yml');
    const dockerfile = join(packageDirectory, 'Dockerfile.workbench');
    await writeFile(
        instructionsPath,
        '# Session probe\n\nFollow exact response-format instructions and remember facts across turns.\n'
    );
    await writeFile(
        dockerfile,
        runner === 'opencode'
            ? [
                  'FROM oven/bun:1.3.11',
                  'RUN bun add --global opencode-ai@1.18.28 \\',
                  '    && install -m 0755 "$(readlink -f "$(command -v opencode)")" /usr/local/bin/opencode.runtime \\',
                  '    && rm /usr/local/bin/opencode \\',
                  '    && mv /usr/local/bin/opencode.runtime /usr/local/bin/opencode',
                  '',
              ].join('\n')
            : [
                  'FROM node:22-bookworm-slim',
                  'RUN npm install --global @earendil-works/pi-coding-agent@0.84.3',
                  '',
              ].join('\n')
    );
    const workbench: ResolvedWorkbench = {
        manifestPath,
        packageDirectory,
        repositoryDirectory: root,
        instructionsPath,
        skills: [],
        manifest: {
            spec: 0,
            version: '0.1.0',
            name: `docker-${runner}-session-probe`,
            runner,
            model: {
                id: 'openai/gpt-5.4-mini',
                routes: [{ provider: 'openrouter' }],
            },
            instructions: './instructions.md',
            skills: [],
            tools: [],
            mcps: [],
            env: {},
            runtime: 'docker',
            image: {
                build: './Dockerfile.workbench',
                context: '.',
            },
        },
    };
    await writeFile(manifestPath, Bun.YAML.stringify(workbench.manifest));
    return { root, packageDirectory, workbench };
}

function outputText(events: WorkbenchEvent[]): string {
    return events
        .filter((event) => event.type === 'output.text')
        .map((event) =>
            typeof event.data === 'object' && event.data
                ? String(Reflect.get(event.data, 'text') ?? '')
                : ''
        )
        .join('');
}

async function workbenchContainers(): Promise<string[]> {
    const process = Bun.spawn(
        [
            'docker',
            'ps',
            '--all',
            '--filter',
            'name=workbench-',
            '--format',
            '{{.Names}}',
        ],
        { stdout: 'pipe', stderr: 'pipe' }
    );
    const [code, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`Failed to inspect Docker containers: ${stderr}`);
    return stdout.split(/\r?\n/).filter(Boolean).toSorted();
}

async function waitForAdditionalContainer(before: string[]): Promise<void> {
    for (let attempt = 0; attempt < 80; attempt += 1) {
        if ((await workbenchContainers()).some((name) => !before.includes(name))) {
            return;
        }
        await Bun.sleep(25);
    }
    throw new Error('Docker session container did not start');
}

async function expectWorkbenchContainers(expected: string[]): Promise<void> {
    for (let attempt = 0; attempt < 80; attempt += 1) {
        const actual = await workbenchContainers();
        if (JSON.stringify(actual) === JSON.stringify(expected)) return;
        await Bun.sleep(25);
    }
    expect(await workbenchContainers()).toEqual(expected);
}

async function dockerContainerExists(name: string): Promise<boolean> {
    return (
        (await Bun.spawn(['docker', 'container', 'inspect', name], {
            stdout: 'ignore',
            stderr: 'ignore',
        }).exited) === 0
    );
}
