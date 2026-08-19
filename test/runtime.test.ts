import { describe, expect, test } from 'bun:test';

import {
    createRuntimeProviderRegistry,
    LocalRuntimeProvider,
    RuntimeError,
    RuntimeProviderRegistry,
    smokeWorkbenchRuntime,
} from '../src/runtime.js';
import type { ResolvedWorkbench } from '../src/types.js';
import { runtimeProviderContract } from './runtime-provider-contract.js';

const fixture = workbench();
const request = {
    workbench: fixture,
    workspaceDirectory: '/workspace',
    environment: { PATH: '/bin' },
    assets: [
        { path: '/workspace', access: 'read-write' as const },
        { path: '/repo/.workbenches/core', access: 'read-only' as const },
    ],
};

let cancellationCount = 0;

describe('local runtime provider contract', () => {
    runtimeProviderContract({
        request,
        createProvider: () =>
            new LocalRuntimeProvider({
                findExecutable: (name) => `/bin/${name}`,
                spawn: () => ({
                    exited: Promise.resolve(0),
                    kill: () => {
                        cancellationCount += 1;
                    },
                }),
            }),
    });

    test('uses host paths and records cancellation', async () => {
        const runtime = await new LocalRuntimeProvider({
            findExecutable: (name) => `/bin/${name}`,
            spawn: () => ({
                exited: Promise.resolve(0),
                kill: () => {
                    cancellationCount += 1;
                },
            }),
        }).prepare(request);
        expect(runtime.pathFor('/workspace/file.ts')).toBe('/workspace/file.ts');
        await runtime.preflight();
        const process = runtime.launch({
            command: ['opencode'],
            cwd: '/workspace',
            env: {},
        });
        const before = cancellationCount;
        runtime.cancel(process);
        expect(cancellationCount).toBe(before + 1);
        await runtime.cleanup();
    });

    test('smokes through the selected provider and rejects local images', async () => {
        const registry = createRuntimeProviderRegistry({
            findExecutable: (name) => `/bin/${name}`,
        });
        await expect(
            smokeWorkbenchRuntime({
                workbench: fixture,
                workspaceDirectory: '/target',
                environment: {},
                registry,
            })
        ).resolves.toMatchObject({
            runner: { name: 'opencode', path: '/bin/opencode' },
        });

        const withImage = workbench();
        withImage.manifest.image = 'ghcr.io/example/workbench:latest';
        await expect(
            registry.resolve('local').prepare({ ...request, workbench: withImage })
        ).rejects.toMatchObject({
            runtime: 'local',
            phase: 'prepare',
            message: 'image is not supported with the local runtime',
        });
    });

    test('rejects launch after cleanup', async () => {
        const runtime = await new LocalRuntimeProvider({
            findExecutable: (name) => `/bin/${name}`,
        }).prepare(request);
        await runtime.preflight();
        await runtime.cleanup();
        expect(() =>
            runtime.launch({ command: ['opencode'], cwd: '/workspace', env: {} })
        ).toThrow('Runtime has already been cleaned up');
    });
});

describe('runtime provider registry', () => {
    test('rejects duplicate, blank, and unsupported providers', () => {
        const local = new LocalRuntimeProvider();
        expect(() => new RuntimeProviderRegistry([local, local])).toThrow(
            'Duplicate runtime provider: local'
        );
        expect(
            () =>
                new RuntimeProviderRegistry([
                    { name: ' ', prepare: async () => Promise.reject() },
                ])
        ).toThrow('Runtime provider name must not be empty');

        const registry = new RuntimeProviderRegistry([local]);
        expect(() => registry.resolve('docker')).toThrow('Unsupported runtime: docker');
        try {
            registry.resolve('docker');
        } catch (error) {
            expect(error).toBeInstanceOf(RuntimeError);
            expect(error).toMatchObject({ runtime: 'docker', phase: 'resolve' });
        }
    });
});

function workbench(): ResolvedWorkbench {
    return {
        manifestPath: '/repo/.workbenches/core/workbench.yml',
        packageDirectory: '/repo/.workbenches/core',
        repositoryDirectory: '/repo',
        instructionsPath: '/repo/.workbenches/core/instructions.md',
        skills: [],
        manifest: {
            spec: 0,
            version: '0.1.0',
            name: 'fixture-core',
            runner: 'opencode',
            model: 'openrouter/openai/gpt-5.6-terra',
            instructions: './instructions.md',
            skills: [],
            tools: [],
            mcps: [],
            env: {},
            runtime: 'local',
        },
    };
}
