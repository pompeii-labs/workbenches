import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
                await writeFile(join(root, 'dirty.txt'), 'preexisting dirty content\n');
                await writeFile(join(root, 'modify.txt'), 'before\n');
                await writeFile(join(root, 'delete.txt'), 'delete\n');
                await writeFile(join(api, 'api.txt'), 'before\n');
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
});
