import { describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RunStore } from '../../src/runs/store.js';
import { DockerManagedContainers } from '../../src/runtimes/docker/containers.js';
import { E2BSdkClient } from '../../src/runtimes/e2b/sdk.js';
import { RuntimeRegistry } from '../../src/runtimes/registry.js';
import type { ResolvedWorkbench } from '../../src/types.js';
import { activateModelCatalogFixture } from '../model-catalog-fixture.js';
import { temporary } from './fixture.js';

const enabled = process.env.WORKBENCH_RUNTIME_ENV_E2E === '1';
const selected = (
    process.env.WORKBENCH_RUNTIME_ENV_RUNTIMES ?? 'local,docker,e2b'
).split(',');

/** Exercises declared environment transport without model requests or GitHub writes. */
describe.skipIf(!enabled)('Runtime environment transport', () => {
    for (const name of ['local', 'docker', 'e2b'])
        test.skipIf(!selected.includes(name))(
            `${name} provides declared environment to normal shell commands`,
            async () => {
                activateModelCatalogFixture();
                const root = await temporary();
                const directory = join(root, 'package');
                await mkdir(directory);
                const instructionsPath = join(directory, 'instructions.md');
                await writeFile(instructionsPath, 'Transport fixture.');
                const workbench: ResolvedWorkbench = {
                    manifestPath: join(directory, 'workbench.yml'),
                    packageDirectory: directory,
                    repositoryDirectory: root,
                    instructionsPath,
                    skills: [],
                    manifest: {
                        spec: 0,
                        version: '0.0.1',
                        name: 'environment-transport',
                        runner: 'sh',
                        model: { id: 'openai/gpt-5.4-mini' },
                        instructions: './instructions.md',
                        skills: [],
                        tools: [],
                        mcps: [],
                        env: { GH_TOKEN: { required: true } },
                        runtime: name,
                        ...(name === 'local'
                            ? {}
                            : {
                                  image:
                                      name === 'e2b'
                                          ? 'e2bdev/base:latest'
                                          : 'alpine:3.22',
                              }),
                    },
                };
                await writeFile(workbench.manifestPath, 'fixture');
                const run = { id: RunStore.createId(), scope: RunStore.scope(root) };
                const runtime = await RuntimeRegistry.standard()
                    .resolve(name)
                    .prepare({
                        workbench,
                        workspaceDirectory: root,
                        environment: {
                            PATH: process.env.PATH,
                            GH_TOKEN: 'fixture-secret',
                            ...(name === 'e2b'
                                ? { E2B_API_KEY: process.env.E2B_API_KEY }
                                : {}),
                        },
                        assets: [
                            { path: root, access: 'read-write' },
                            { path: directory, access: 'read-only' },
                        ],
                        purpose: 'build',
                        run,
                    });
                try {
                    await runtime.preflight();
                    const result = await runtime.execute({
                        command: [
                            'sh',
                            '-c',
                            'test "$GH_TOKEN" = fixture-secret && printf transported',
                        ],
                        cwd: runtime.workspaceDirectory,
                        env: runtime.environment,
                    });
                    expect(result.code, result.stderr).toBe(0);
                    expect(result.stdout).toBe('transported');
                } finally {
                    await runtime.cleanup();
                }
                if (name === 'e2b')
                    expect(
                        (
                            await new E2BSdkClient(
                                process.env.E2B_API_KEY as string
                            ).listManaged(run.scope)
                        ).filter((sandbox) => sandbox.runId === run.id)
                    ).toEqual([]);
                if (name === 'docker')
                    expect(
                        (
                            (await (
                                await DockerManagedContainers.connect(run.scope)
                            )?.list()) ?? []
                        ).filter((container) => container.runId === run.id)
                    ).toEqual([]);
            },
            300_000
        );
});
