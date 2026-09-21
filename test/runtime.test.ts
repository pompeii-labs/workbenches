import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OutcomeStore } from '../src/outcomes/store.js';

import {
    LocalRuntimeProvider,
    RuntimeError,
    RuntimeRegistry,
    RuntimeSmoke,
} from '../src/runtimes/index.js';
import { LocalRuntime } from '../src/runtimes/local.js';
import type { ResolvedWorkbench } from '../src/types.js';
import { runtimeProviderContract } from './runtime-provider-contract.js';

const instructionDirectory = await mkdtemp(join(tmpdir(), 'runtime-instructions-'));
const instructionsPath = join(instructionDirectory, 'instructions.md');
await writeFile(instructionsPath, 'Follow the user task.\n');
afterAll(() => rm(instructionDirectory, { recursive: true, force: true }));

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
    test('registry forwards live repository snapshots and guards collection failures', async () => {
        const native = await new LocalRuntimeProvider().prepare(request);
        let calls = 0;
        let fail = false;
        native.snapshotRepository = async () => {
            calls++;
            if (fail) throw new Error('Snapshot unavailable');
            return {
                application_state: 'present',
                changesets: [],
                artifacts: [],
                links: [],
                warnings: [],
            };
        };
        const runtime = await new RuntimeRegistry([
            { name: 'local', prepare: async () => native },
        ])
            .resolve('local')
            .prepare(request);
        try {
            expect(
                await runtime.snapshotRepository?.({} as OutcomeStore)
            ).toMatchObject({ application_state: 'present' });
            fail = true;
            await expect(
                runtime.snapshotRepository?.({} as OutcomeStore)
            ).rejects.toThrow('Snapshot unavailable');
            expect(calls).toBe(2);
        } finally {
            await runtime.cleanup();
        }
    });

    test('bounds shutdown when a native process ignores graceful termination', async () => {
        const child = LocalRuntime.spawn(
            [
                process.execPath,
                '-e',
                'process.on("SIGTERM", () => console.log("ignored")); console.log("ready"); setInterval(() => {}, 1000);',
            ],
            {
                cwd: instructionDirectory,
                env: {},
                stdin: 'ignore',
                stdout: 'pipe',
                stderr: 'pipe',
            }
        );
        const reader = child.stdout?.getReader();
        try {
            if (!reader) throw new Error('Fixture process stdout is unavailable');
            expect(new TextDecoder().decode((await reader.read()).value)).toContain(
                'ready'
            );
            const started = Date.now();
            child.kill?.();
            expect(new TextDecoder().decode((await reader.read()).value)).toContain(
                'ignored'
            );
            expect(await child.exited).not.toBe(0);
            expect(Date.now() - started).toBeLessThan(4_000);
        } finally {
            child.kill?.();
            await child.exited;
            reader?.releaseLock();
        }
    }, 6_000);

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

    test('launches session processes and loopback services on the host', async () => {
        let input: string | undefined;
        const runtime = await new LocalRuntimeProvider({
            findExecutable: (name) => `/bin/${name}`,
            spawn: (_command, options) => {
                input = options.stdin;
                return {
                    exited: Promise.resolve(0),
                    stdin: { write() {} },
                };
            },
        }).prepare(request);
        await runtime.preflight();
        const process = runtime.launchSession(
            { command: ['pi'], cwd: '/workspace', env: {} },
            { stdin: 'pipe' }
        );
        expect(input).toBe('pipe');
        expect(process.stdin).toBeDefined();

        const service = runtime.launchService((binding) => ({
            command: ['opencode', 'serve', binding.hostname, String(binding.port)],
            cwd: '/workspace',
            env: {},
        }));
        await expect(service.resolveUrl('http://127.0.0.1:3123')).resolves.toBe(
            'http://127.0.0.1:3123'
        );
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
        instructionsPath,
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
