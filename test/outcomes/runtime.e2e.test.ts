import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutcomeLifecycle, OutcomeStore } from '../../src/outcomes/index.js';
import type { PreparedRuntime } from '../../src/runtimes/contracts.js';
import { DockerRuntimeProvider } from '../../src/runtimes/docker/provider.js';
import { LocalRuntimeProvider } from '../../src/runtimes/local.js';
import type { ResolvedWorkbench } from '../../src/types.js';

const directories: string[] = [];
const runtimes: PreparedRuntime[] = [];
const lifecycles: OutcomeLifecycle[] = [];
const dockerImage =
    'alpine@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce';
afterEach(async () => {
    await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.cleanup()));
    await Promise.all(lifecycles.splice(0).map((capture) => capture.cleanup()));
    await Promise.all(
        directories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});
async function directory(): Promise<string> {
    const value = await mkdtemp(join(tmpdir(), 'workbench-outcome-runtime-'));
    directories.push(value);
    return value;
}

async function git(root: string, ...args: string[]): Promise<void> {
    const child = Bun.spawn(['git', ...args], {
        cwd: root,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'pipe',
    });
    const error = new Response(child.stderr).text();
    if ((await child.exited) !== 0) throw new Error(await error);
}

async function initializeRepository(root: string): Promise<void> {
    await git(root, 'init', '-q');
    await git(root, 'add', '.');
    await git(
        root,
        '-c',
        'user.name=Workbench',
        '-c',
        'user.email=workbench@localhost',
        'commit',
        '-q',
        '-m',
        'baseline'
    );
}

async function localProbe(root: string, name: string): Promise<ResolvedWorkbench> {
    const packageDirectory = join(root, '.workbenches', 'probe');
    await mkdir(packageDirectory, { recursive: true });
    const manifestPath = join(packageDirectory, 'workbench.yml');
    const instructionsPath = join(packageDirectory, 'instructions.md');
    await writeFile(instructionsPath, '# Local outcome probe\n');
    return {
        manifestPath,
        packageDirectory,
        repositoryDirectory: root,
        instructionsPath,
        skills: [],
        manifest: {
            spec: 0,
            version: '0.1.0',
            name,
            runner: 'sh',
            model: { id: 'openai/gpt-5.6-terra' },
            instructions: './instructions.md',
            skills: [],
            tools: [],
            mcps: [],
            env: {},
            runtime: 'local',
        },
    };
}

describe('Outcome runtime process end to end', () => {
    for (const target of ['local', 'docker'] as const) {
        test.skipIf(target === 'docker' && process.env.WORKBENCH_DOCKER_E2E !== '1')(
            `collects ${target} process edits and exact artifacts before cleanup`,
            async () => {
                const root = await directory();
                const home = await directory();
                const api = await directory();
                const packageDirectory = join(root, '.workbenches', 'probe');
                await mkdir(packageDirectory, { recursive: true });
                const manifestPath = join(packageDirectory, 'workbench.yml');
                const instructionsPath = join(packageDirectory, 'instructions.md');
                await writeFile(instructionsPath, '# Runtime transport probe\n');
                const workbench: ResolvedWorkbench = {
                    manifestPath,
                    packageDirectory,
                    repositoryDirectory: root,
                    instructionsPath,
                    skills: [],
                    manifest: {
                        spec: 0,
                        version: '0.1.0',
                        name: 'outcome-runtime-probe',
                        runner: 'sh',
                        model: { id: 'openai/gpt-5.6-terra' },
                        instructions: './instructions.md',
                        skills: [],
                        tools: [],
                        mcps: [],
                        env: {},
                        runtime: target,
                        ...(target === 'docker' ? { image: dockerImage } : {}),
                    },
                };
                await writeFile(manifestPath, Bun.YAML.stringify(workbench.manifest));
                await writeFile(join(root, 'modify.txt'), 'before\n');
                await writeFile(join(root, 'delete.txt'), 'delete\n');
                await writeFile(join(api, 'api.txt'), 'before\n');
                await initializeRepository(root);
                await initializeRepository(api);
                await writeFile(join(root, 'dirty.txt'), 'preexisting dirty content\n');
                const published: string[] = [];
                const lifecycle = await OutcomeLifecycle.create({
                    home,
                    runId: 'wb_1234567890abcdefghij',
                    onAvailable: (outcome) => {
                        published.push(outcome.id);
                    },
                });
                lifecycles.push(lifecycle);
                const provider =
                    target === 'local'
                        ? new LocalRuntimeProvider()
                        : new DockerRuntimeProvider();
                const runtime = await provider.prepare({
                    workbench,
                    workspaceDirectory: root,
                    environment: process.env,
                    outcome: { directory: lifecycle.output.directory },
                    assets: [
                        { path: root, access: 'read-write' },
                        { path: packageDirectory, access: 'read-only' },
                        { path: api, workspace: 'api', access: 'read-write' },
                    ],
                });
                runtimes.push(runtime);
                const outbox =
                    target === 'local' ? lifecycle.output.directory : '/outbox';
                expect(runtime.environment.WORKBENCH_OUTPUT_DIR).toBe(outbox);
                expect(runtime.pathFor(lifecycle.output.directory)).toBe(outbox);
                await runtime.preflight();
                const child = runtime.launch({
                    command: [
                        '/bin/sh',
                        '-c',
                        [
                            'printf "process streamed\\n"',
                            'printf "after\\n" > modify.txt',
                            'printf "added\\n" > add.txt',
                            'rm delete.txt',
                            'printf "api after\\n" > "$WORKBENCH_WORKSPACE_API/api.txt"',
                            'mkdir -p "$WORKBENCH_OUTPUT_DIR/reports"',
                            'printf "<h1>Original report</h1>\\n" > "$WORKBENCH_OUTPUT_DIR/reports/report.html"',
                            'printf "\\000\\001\\377" > "$WORKBENCH_OUTPUT_DIR/original.bin"',
                            'printf \'{"version":1,"summary":"Process complete","links":[{"label":"Pull request","uri":"https://example.com/pull/1","kind":"pull_request"}]}\' > "$WORKBENCH_OUTPUT_DIR/outcome.json"',
                        ].join('; '),
                    ],
                    cwd: runtime.workspaceDirectory,
                    env: runtime.environment,
                });
                expect(await new Response(child.stdout).text()).toBe(
                    'process streamed\n'
                );
                expect(await new Response(child.stderr).text()).toBe('');
                expect(await child.exited).toBe(0);
                const outcome = await lifecycle.collect(runtime, 'complete');
                expect(outcome).toBeDefined();
                if (!outcome) throw new Error('Expected durable runtime outcome');
                expect(published).toEqual([outcome.id]);
                expect(outcome.changesets).toHaveLength(2);
                const primary = outcome.changesets.find(
                    (changeset) => changeset.workspace.kind === 'primary'
                );
                if (!primary) throw new Error('Expected primary workspace changeset');
                expect(
                    primary.entries
                        .map((entry) => `${entry.operation}:${entry.path}`)
                        .toSorted()
                ).toEqual(['add:add.txt', 'delete:delete.txt', 'modify:modify.txt']);
                expect(await readFile(join(root, 'dirty.txt'), 'utf8')).toBe(
                    'preexisting dirty content\n'
                );
                const store = new OutcomeStore(home);
                expect((await store.receipt(outcome.id)).state).toBe('present');
                expect(outcome.artifacts).toHaveLength(2);
                expect(outcome.links[0]?.kind).toBe('pull_request');
                const binary = outcome.artifacts.find(
                    (artifact) => artifact.name === 'original.bin'
                );
                if (!binary) throw new Error('Expected original binary artifact');
                const path = await store.artifactPath(outcome.id, binary.id);
                expect(await readFile(path)).toEqual(Buffer.from([0, 1, 255]));
                await runtime.cleanup();
                await lifecycle.cleanup();
                expect(await readFile(path)).toEqual(Buffer.from([0, 1, 255]));
                expect(await store.read(outcome.id)).toEqual(outcome);
            },
            180_000
        );
    }

    test('runs local non-Git workspaces without copying the workspace', async () => {
        const root = await directory();
        const home = await directory();
        const workbench = await localProbe(root, 'non-git-probe');
        const lifecycle = await OutcomeLifecycle.create({
            home,
            runId: 'wb_1234567890abcdefghij',
        });
        lifecycles.push(lifecycle);
        const runtime = await new LocalRuntimeProvider().prepare({
            workbench,
            workspaceDirectory: root,
            environment: process.env,
            outcome: { directory: lifecycle.output.directory },
            assets: [
                { path: root, access: 'read-write' },
                { path: workbench.packageDirectory, access: 'read-only' },
            ],
        });
        runtimes.push(runtime);
        await writeFile(join(root, 'created.txt'), 'not copied\n');
        await writeFile(join(lifecycle.output.directory, 'report.txt'), 'result\n');
        const outcome = await lifecycle.collect(runtime, 'complete');
        expect(outcome?.changesets).toEqual([]);
        expect(outcome?.artifacts.map((artifact) => artifact.name)).toEqual([
            'report.txt',
        ]);
        expect(outcome?.warnings).toEqual([
            {
                code: 'workspace_changes_unavailable',
                message:
                    'Primary workspace changes were not captured because it is not a Git working tree. Returned files and links are still captured.',
            },
        ]);
    });

    test('runs local oversized Git workspaces without copying the workspace', async () => {
        const root = await directory();
        const home = await directory();
        const workbench = await localProbe(root, 'oversized-git-probe');
        await initializeRepository(root);
        await writeFile(join(root, 'oversized.bin'), '');
        await truncate(join(root, 'oversized.bin'), 16 * 1_024 * 1_024 * 1_024);
        const lifecycle = await OutcomeLifecycle.create({
            home,
            runId: 'wb_abcdefghij1234567890',
        });
        lifecycles.push(lifecycle);
        const runtime = await new LocalRuntimeProvider().prepare({
            workbench,
            workspaceDirectory: root,
            environment: process.env,
            outcome: { directory: lifecycle.output.directory },
            assets: [
                { path: root, access: 'read-write' },
                { path: workbench.packageDirectory, access: 'read-only' },
            ],
        });
        runtimes.push(runtime);
        await writeFile(join(lifecycle.output.directory, 'report.txt'), 'result\n');
        const outcome = await lifecycle.collect(runtime, 'complete');
        expect(outcome?.changesets).toEqual([]);
        expect(outcome?.artifacts).toHaveLength(1);
        expect(outcome?.warnings).toEqual([
            {
                code: 'workspace_changes_unavailable',
                message:
                    'Primary workspace changes were not captured because its 16 GiB snapshot exceeds the 512 MiB safety limit. Returned files and links are still captured.',
            },
        ]);
    });

    test('preserves local artifacts when workspace growth exceeds the capture limit', async () => {
        const root = await directory();
        const home = await directory();
        const workbench = await localProbe(root, 'growing-git-probe');
        await initializeRepository(root);
        const lifecycle = await OutcomeLifecycle.create({
            home,
            runId: 'wb_abcdefghij1234567891',
        });
        lifecycles.push(lifecycle);
        const runtime = await new LocalRuntimeProvider().prepare({
            workbench,
            workspaceDirectory: root,
            environment: process.env,
            outcome: { directory: lifecycle.output.directory },
            assets: [
                { path: root, access: 'read-write' },
                { path: workbench.packageDirectory, access: 'read-only' },
            ],
        });
        runtimes.push(runtime);
        await writeFile(join(root, 'grown.bin'), '');
        await truncate(join(root, 'grown.bin'), 16 * 1_024 * 1_024 * 1_024);
        await writeFile(join(lifecycle.output.directory, 'report.txt'), 'result\n');
        const outcome = await lifecycle.collect(runtime, 'complete');
        expect(outcome?.changesets).toEqual([]);
        expect(outcome?.artifacts.map((artifact) => artifact.name)).toEqual([
            'report.txt',
        ]);
        expect(outcome?.warnings).toEqual([
            {
                code: 'workspace_changes_unavailable',
                message:
                    'Primary workspace changes were not captured because its 16 GiB snapshot exceeds the 512 MiB safety limit. Returned files and links are still captured.',
            },
        ]);
    });
});
