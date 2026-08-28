import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DockerRuntimeProvider } from '../src/runtimes/docker/index.js';
import type { ResolvedWorkbench } from '../src/types.js';

const temporaryDirectories: string[] = [];
const dockerTest = process.env.WORKBENCH_DOCKER_E2E === '1' ? test : test.skip;

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
