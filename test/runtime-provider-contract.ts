import { expect, test } from 'bun:test';

import {
    type RuntimePrepareRequest,
    type RuntimeProvider,
    RuntimeProviderRegistry,
} from '../src/runtime.js';

export function runtimeProviderContract(options: {
    createProvider: () => RuntimeProvider;
    request: RuntimePrepareRequest;
}) {
    test('prepares repeatedly without changing its runtime-visible layout', async () => {
        const candidate = options.createProvider();
        const provider = new RuntimeProviderRegistry([candidate]).resolve(
            candidate.name
        );
        const first = await provider.prepare(options.request);
        const second = await provider.prepare(options.request);
        try {
            expect(first.name).toBe(provider.name);
            expect(second.name).toBe(provider.name);
            expect(first.workspaceDirectory).toBe(second.workspaceDirectory);
            for (const asset of options.request.assets) {
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
        const candidate = options.createProvider();
        const runtime = await new RuntimeProviderRegistry([candidate])
            .resolve(candidate.name)
            .prepare(options.request);
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
        const candidate = options.createProvider();
        const runtime = await new RuntimeProviderRegistry([candidate])
            .resolve(candidate.name)
            .prepare(options.request);
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
