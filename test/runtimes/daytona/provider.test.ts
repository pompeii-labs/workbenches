import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RuntimeRegistry } from '../../../src/runtimes/index.js';
import { RuntimeSmoke } from '../../../src/runtimes/smoke.js';
import {
    isRemoteRuntime,
    runtimeProviderNames,
} from '../../../src/workbench/runtimes.js';
import { runtimeProviderContract } from '../../runtime-provider-contract.js';
import {
    cleanTemporaryDirectories,
    connection,
    daytonaProvider,
    FakeClient,
    fixture,
    request,
    track,
} from './fixture.js';

afterEach(cleanTemporaryDirectories);

describe('DaytonaRuntimeProvider', () => {
    runtimeProviderContract({
        createProvider: () => daytonaProvider({ client: new FakeClient() }),
        request: async () => request(await fixture()),
        manifest: (base) => {
            const { runtime: _runtime, image: _image, ...rest } = base;
            return {
                ...rest,
                spec: 1,
                runtimes: {
                    daytona: { class: 'linux', image: 'ghcr.io/example/core:1.0.0' },
                },
            };
        },
    });

    test('runs in a sandbox, like every remote provider', () => {
        const registry = RuntimeRegistry.standard({
            daytona: connection(new FakeClient()),
        });
        for (const name of runtimeProviderNames) {
            expect(registry.resolve(name).placement === 'sandbox').toBe(
                isRemoteRuntime(name)
            );
        }
        expect(registry.resolve('daytona').placement).toBe('sandbox');
        expect(registry.resolve('local').placement).toBe('host');
        expect(registry.resolve('docker').placement).toBe('container');
    });

    test('requires an API key before contacting Daytona', async () => {
        const resolved = await fixture();
        const home = track(
            await mkdtemp(join(tmpdir(), 'workbench-daytona-empty-home-'))
        );
        await expect(
            daytonaProvider().prepare({
                ...request(resolved),
                environment: { WORKBENCH_HOME: home },
            })
        ).rejects.toThrow('DAYTONA_API_KEY is required for the Daytona runtime');
    });

    test('creates the sandbox from the manifest image and labels it for the run', async () => {
        const client = new FakeClient();
        const run = { id: `wb_${'a'.repeat(20)}`, scope: 'b'.repeat(24) };
        const runtime = await daytonaProvider({ client }).prepare({
            ...request(await fixture()),
            run,
        });
        try {
            expect(runtime.preparation).toMatchObject({
                kind: 'image',
                reference: 'ghcr.io/example/workbench:1.0.0',
            });
            await runtime.preflight();
            expect(client.createOptions).toHaveLength(1);
            expect(client.createOptions[0]).toEqual({
                image: 'ghcr.io/example/workbench:1.0.0',
                labels: {
                    'dev.workbenches.managed': 'true',
                    'dev.workbenches.run': run.id,
                    'dev.workbenches.scope': run.scope,
                },
                resources: {},
                leaseMinutes: 60,
            });
        } finally {
            await runtime.cleanup();
        }
    });

    test('names an unnamed run and scopes it to the workspace', async () => {
        const client = new FakeClient();
        const resolved = await fixture();
        const runtime = await daytonaProvider({ client }).prepare(request(resolved));
        try {
            await runtime.preflight();
            const labels = client.createOptions[0]?.labels ?? {};
            expect(labels['dev.workbenches.run']).toMatch(/^wb_[a-f0-9]{32}$/);
            expect(labels['dev.workbenches.scope']).toMatch(/^[a-f0-9]{24}$/);
        } finally {
            await runtime.cleanup();
        }
    });

    test('maps requirements to whole-unit sandbox resources', async () => {
        const client = new FakeClient();
        const runtime = await daytonaProvider({ client }).prepare(
            request(
                await fixture({
                    requirements: { cpu: 4, memory_gb: 7.5, disk_gb: 20, gpu: false },
                })
            )
        );
        try {
            await runtime.preflight();
            expect(client.createOptions[0]?.resources).toEqual({
                cpu: 4,
                memoryGb: 8,
                diskGb: 20,
            });
        } finally {
            await runtime.cleanup();
        }
    });

    test('uses the daytona image even when a docker entry declares another', async () => {
        const client = new FakeClient();
        const runtime = await daytonaProvider({ client }).prepare(
            request(
                await fixture({
                    runtimes: {
                        daytona: { class: 'linux', image: 'ghcr.io/example/own:1' },
                        docker: { image: 'ghcr.io/example/docker-only:2.0.0' },
                    },
                })
            )
        );
        try {
            await runtime.preflight();
            expect(client.createOptions[0]?.image).toBe('ghcr.io/example/own:1');
        } finally {
            await runtime.cleanup();
        }
    });

    test('fails without an image on the daytona entry, whatever else is declared', async () => {
        const provider = daytonaProvider({ client: new FakeClient() });
        for (const runtimes of [
            { daytona: { class: 'linux' as const } },
            {
                daytona: { class: 'linux' as const },
                docker: { image: 'ghcr.io/example/docker-only:2.0.0' },
            },
        ]) {
            await expect(
                provider.prepare(request(await fixture({ runtimes })))
            ).rejects.toMatchObject({
                name: 'RuntimeError',
                runtime: 'daytona',
                phase: 'prepare',
                message:
                    'The daytona runtime needs an image. Set runtimes.daytona.image.',
            });
        }
    });

    test('refuses an image that would need a local Dockerfile build', async () => {
        const provider = daytonaProvider({ client: new FakeClient() });
        await expect(
            provider.prepare(
                request(
                    await fixture({
                        runtimes: {
                            daytona: {
                                class: 'linux',
                                image: { build: './Dockerfile' },
                            },
                        },
                    })
                )
            )
        ).rejects.toThrow('cannot build a local Dockerfile');
    });

    for (const daytonaClass of ['windows', 'macos', 'gpu'] as const) {
        test(`refuses the ${daytonaClass} class for now`, async () => {
            const client = new FakeClient();
            await expect(
                daytonaProvider({ client }).prepare(
                    request(
                        await fixture({
                            runtimes: {
                                daytona: {
                                    class: daytonaClass,
                                    image: 'ghcr.io/example/workbench:1.0.0',
                                },
                            },
                        })
                    )
                )
            ).rejects.toThrow(`class ${daytonaClass} is not available yet`);
            expect(client.createOptions).toHaveLength(0);
        });
    }

    test('refuses a runner that reads from standard input', async () => {
        const client = new FakeClient();
        const resolved = await fixture();
        resolved.manifest.runner = 'pi';
        await expect(
            daytonaProvider({ client }).prepare(request(resolved))
        ).rejects.toThrow(
            'The daytona runtime does not support runners that read from standard input yet'
        );
        expect(client.createOptions).toHaveLength(0);
    });

    test('refuses a GPU requirement', async () => {
        const client = new FakeClient();
        await expect(
            daytonaProvider({ client }).prepare(
                request(await fixture({ requirements: { gpu: true } }))
            )
        ).rejects.toThrow('GPU requirements are not supported on the daytona runtime');
        expect(client.createOptions).toHaveLength(0);
    });

    test('rejects native credential storage, which has no Daytona store', async () => {
        const credentials = track(
            await mkdtemp(join(tmpdir(), 'workbench-daytona-creds-'))
        );
        await expect(
            daytonaProvider({ client: new FakeClient() }).prepare({
                ...request(await fixture()),
                credentials: {
                    runtime: 'e2b',
                    runner: 'opencode',
                    directory: credentials,
                },
            })
        ).rejects.toThrow('Daytona received credential storage for the e2b runtime');
    });

    test('requires a sandbox id to reconnect', async () => {
        await expect(
            daytonaProvider({ client: new FakeClient() }).adopt(
                request(await fixture()),
                '  '
            )
        ).rejects.toThrow('A sandbox id is required');
    });

    test('wb smoke prepares, checks, and deletes the sandbox', async () => {
        const resolved = await fixture();
        const client = new FakeClient();
        const result = await new RuntimeSmoke({
            workbench: resolved,
            workspaceDirectory: resolved.repositoryDirectory,
            environment: { OPENAI_API_KEY: 'fixture-key' },
            registry: RuntimeRegistry.standard({ daytona: connection(client) }),
        }).check();
        expect(result.runner).toEqual({ name: 'opencode', path: '/usr/bin/opencode' });
        expect(client.createOptions).toHaveLength(1);
        expect(client.deleted).toEqual(['sandbox-fixture']);
    });

    test('is registered in the standard runtime registry', async () => {
        const client = new FakeClient();
        const runtime = await RuntimeRegistry.standard({ daytona: connection(client) })
            .resolve('daytona')
            .prepare(request(await fixture()));
        try {
            expect(runtime.name).toBe('daytona');
        } finally {
            await runtime.cleanup();
        }
    });
});
