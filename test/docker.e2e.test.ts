import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DockerRuntimeProvider } from '../src/docker.js';
import type { ResolvedWorkbench } from '../src/types.js';

const temporaryDirectories: string[] = [];
const dockerTest = process.env.WORKBENCH_DOCKER_E2E === '1' ? test : test.skip;

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('Docker runtime end-to-end', () => {
    dockerTest(
        'enforces workspace, package, root, temporary home, and host-user policy',
        async () => {
            const fixture = await createFixture();
            const runtime = await new DockerRuntimeProvider().prepare({
                workbench: fixture.workbench,
                workspaceDirectory: fixture.root,
                environment: {},
                assets: [
                    { path: fixture.root, access: 'read-write' },
                    { path: fixture.packageDirectory, access: 'read-only' },
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
                            "if sh -c 'printf root-write > /must-not-write' 2>/dev/null; then exit 42; fi",
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
});

async function createFixture(): Promise<{
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
            model: 'unused',
            instructions: './instructions.md',
            skills: [],
            tools: [],
            mcps: [],
            env: {},
            runtime: 'docker',
            image: 'alpine:3.22',
        },
    };
    await writeFile(manifestPath, Bun.YAML.stringify(workbench.manifest));
    return { root, packageDirectory, workbench };
}
