import { describe, expect, test } from 'bun:test';

import {
    LocalRuntimeProvider,
    RuntimeError,
    RuntimeRegistry,
    RuntimeSmoke,
} from '../src/runtimes/index.js';
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

    test('executes captured commands and hands interactive commands to the terminal', async () => {
        let interactiveCommand: string[] = [];
        let interactiveOptions: Record<string, unknown> = {};
        const provider = new LocalRuntimeProvider({
            findExecutable: (name) => `/bin/${name}`,
            spawn: () => ({
                exited: Promise.resolve(7),
                stdout: new Blob(['runner output']).stream(),
                stderr: new Blob(['runner warning']).stream(),
            }),
            interact: async (command, options) => {
                interactiveCommand = command;
                interactiveOptions = options;
                return 4;
            },
        });
        const runtime = await new RuntimeRegistry([provider])
            .resolve('local')
            .prepare(request);
        const invocation = {
            command: ['opencode', 'auth', 'login'],
            cwd: '/workspace',
            env: { PATH: '/bin' },
        };

        await expect(runtime.execute(invocation)).resolves.toEqual({
            code: 7,
            stdout: 'runner output',
            stderr: 'runner warning',
        });
        await expect(runtime.interact(invocation)).resolves.toBe(4);
        expect(interactiveCommand).toEqual(invocation.command);
        expect(interactiveOptions).toMatchObject({
            cwd: '/workspace',
            stdin: 'inherit',
            stdout: 'inherit',
            stderr: 'inherit',
        });

        await runtime.cleanup();
        await expect(runtime.execute(invocation)).rejects.toThrow(
            'Runtime has already been cleaned up'
        );
    });

    test('smokes through the selected provider and rejects local images', async () => {
        const registry = RuntimeRegistry.standard({
            findExecutable: (name) => `/bin/${name}`,
        });
        await expect(
            new RuntimeSmoke({
                workbench: fixture,
                workspaceDirectory: '/target',
                environment: { OPENROUTER_API_KEY: 'fixture-openrouter-key' },
                registry,
            }).check()
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
        expect(() => new RuntimeRegistry([local, local])).toThrow(
            'Duplicate runtime provider: local'
        );
        expect(
            () =>
                new RuntimeRegistry([
                    { name: ' ', prepare: async () => Promise.reject() },
                ])
        ).toThrow('Runtime provider name must not be empty');

        const registry = new RuntimeRegistry([local]);
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
