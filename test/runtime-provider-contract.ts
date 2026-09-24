import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunDispatcher } from '../src/runs/dispatcher.js';
import {
    type RuntimePrepareRequest,
    type RuntimeProvider,
    RuntimeRegistry,
} from '../src/runtimes/index.js';
import { SessionResolver, SessionStore } from '../src/sessions/index.js';
import { Workbench } from '../src/workbench/index.js';

export function runtimeProviderContract(options: {
    createProvider: () => RuntimeProvider;
    request:
        | RuntimePrepareRequest
        | (() => RuntimePrepareRequest | Promise<RuntimePrepareRequest>);
}) {
    test('reconstructs a session-owned package after source deletion with a fake transport', async () => {
        const root = await mkdtemp(join(tmpdir(), 'runtime-pin-'));
        const source = join(root, 'source', '.workbenches', 'core');
        const workspace = join(root, 'workspace');
        const home = join(root, 'home');
        const template = await resolveRequest(options.request);
        const candidate = options.createProvider();
        try {
            await mkdir(source, { recursive: true });
            await mkdir(workspace);
            await writeFile(
                join(source, 'instructions.md'),
                'Pinned runtime instructions'
            );
            await writeFile(
                join(source, 'workbench.yml'),
                Bun.YAML.stringify({
                    spec: 0,
                    version: '0.1.0',
                    name: 'pinned-core',
                    runner: 'opencode',
                    model: { id: 'openai/gpt-5.6-terra' },
                    instructions: './instructions.md',
                    skills: [],
                    tools: [],
                    mcps: [],
                    env: {},
                    runtime: candidate.name,
                    ...(candidate.name === 'local'
                        ? {}
                        : { image: 'ghcr.io/example/core:1.0.0' }),
                })
            );
            const run = await new RunDispatcher(home).prepare({
                resolved: {
                    workbench: await Workbench.load(source),
                    workspaceDirectory: workspace,
                    source: 'local',
                    cleanup: async () => {},
                },
                mode: 'interactive',
            });
            await new SessionStore(home).update(run.id, {
                native_session_id: 'native-fixture',
            });
            await rm(source, { recursive: true });
            const { resolved } = await new SessionResolver(home).resolve(run.id);
            const pinned = resolved.workbench;
            expect(await readFile(pinned.instructionsPath, 'utf8')).toBe(
                'Pinned runtime instructions'
            );
            const runtime = await new RuntimeRegistry([candidate])
                .resolve(candidate.name)
                .prepare({
                    ...template,
                    workbench: pinned,
                    workspaceDirectory: workspace,
                    assets: [
                        { path: workspace, access: 'read-write' },
                        { path: pinned.packageDirectory, access: 'read-only' },
                    ],
                });
            try {
                expect(runtime.pathFor(pinned.packageDirectory)).toBe(
                    runtime.workbench.packageDirectory
                );
                expect(runtime.pathFor(pinned.instructionsPath)).toBe(
                    runtime.workbench.instructionsPath
                );
                expect(runtime.workbench.manifest.name).toBe('pinned-core');
                expect(runtime.workbench.manifest.runtime).toBe(candidate.name);
                await runtime.preflight();
            } finally {
                await runtime.cleanup();
            }
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test('prepares repeatedly without changing its runtime-visible layout', async () => {
        const request = await resolveRequest(options.request);
        const candidate = options.createProvider();
        const provider = new RuntimeRegistry([candidate]).resolve(candidate.name);
        const first = await provider.prepare(request);
        const second = await provider.prepare(request);
        try {
            expect(first.name).toBe(provider.name);
            expect(second.name).toBe(provider.name);
            expect(first.workspaceDirectory).toBe(second.workspaceDirectory);
            for (const asset of request.assets) {
                expect(first.pathFor(asset.path)).toBe(second.pathFor(asset.path));
            }
        } finally {
            await first.cleanup();
            await first.cleanup();
            await second.cleanup();
            await second.cleanup();
        }
    });

    test('requires successful preflight before launch', async () => {
        const request = await resolveRequest(options.request);
        const candidate = options.createProvider();
        const runtime = await new RuntimeRegistry([candidate])
            .resolve(candidate.name)
            .prepare(request);
        try {
            expect(() =>
                runtime.launch({
                    command: ['runner'],
                    cwd: runtime.workspaceDirectory,
                    env: runtime.environment,
                })
            ).toThrow('Runtime preflight must succeed before launch');
            await runtime.preflight();
            expect(
                runtime.launch({
                    command: ['runner'],
                    cwd: runtime.workspaceDirectory,
                    env: runtime.environment,
                })
            ).toBeDefined();
        } finally {
            await runtime.cleanup();
        }
    });

    test('cancels a launched process and makes cleanup idempotent', async () => {
        const request = await resolveRequest(options.request);
        const candidate = options.createProvider();
        const runtime = await new RuntimeRegistry([candidate])
            .resolve(candidate.name)
            .prepare(request);
        await runtime.preflight();
        const process = runtime.launch({
            command: ['runner'],
            cwd: runtime.workspaceDirectory,
            env: runtime.environment,
        });
        runtime.cancel(process);
        await runtime.cleanup();
        await runtime.cleanup();
        await expect(runtime.preflight()).rejects.toThrow(
            'Runtime has already been cleaned up'
        );
    });
}

function resolveRequest(
    request:
        | RuntimePrepareRequest
        | (() => RuntimePrepareRequest | Promise<RuntimePrepareRequest>)
): RuntimePrepareRequest | Promise<RuntimePrepareRequest> {
    return typeof request === 'function' ? request() : request;
}
