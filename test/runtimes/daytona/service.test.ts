import { afterEach, describe, expect, test } from 'bun:test';

import {
    cleanTemporaryDirectories,
    daytonaProvider,
    FakeClient,
    fixture,
    readFirstChunk,
    request,
} from './fixture.js';

afterEach(cleanTemporaryDirectories);

const serve = (workspace: string) => (binding: { hostname: string; port: number }) => ({
    command: ['opencode', 'serve', binding.hostname, String(binding.port)],
    cwd: workspace,
    env: {},
});

/** Prepares a runtime, stages it, and returns the request and sandbox id. */
async function staged(client: FakeClient) {
    const prepared = request(await fixture());
    const first = await daytonaProvider({ client }).prepare(prepared);
    await first.preflight();
    return { prepared, sandboxId: first.sandboxId as string };
}

describe('ServiceLauncher', () => {
    test('attaches to a runner server that is still listening', async () => {
        const client = new FakeClient();
        const { prepared, sandboxId } = await staged(client);
        client.sandbox.listening = true;
        const runtime = await daytonaProvider({ client }).adopt(prepared, sandboxId);
        try {
            await runtime.preflight();
            const started = client.sandbox.started.length;
            const service = runtime.launchService(serve(runtime.workspaceDirectory));
            expect(
                await readFirstChunk(
                    service.process.stdout as ReadableStream<Uint8Array>
                )
            ).toBe('Attached to the running server at http://0.0.0.0:4096\n');
            expect(client.sandbox.started).toHaveLength(started);
            runtime.cancel(service.process);
            await expect(service.process.exited).resolves.toBe(0);
            expect(client.sandbox.killedProcesses).toBe(0);
        } finally {
            await runtime.cleanup();
        }
    });

    test('starts the runner server when nothing is listening', async () => {
        const client = new FakeClient();
        const { prepared, sandboxId } = await staged(client);
        const runtime = await daytonaProvider({ client }).adopt(prepared, sandboxId);
        try {
            await runtime.preflight();
            const started = client.sandbox.started.length;
            const service = runtime.launchService(serve(runtime.workspaceDirectory));
            await service.process.exited;
            expect(client.sandbox.started).toHaveLength(started + 1);
        } finally {
            await runtime.cleanup();
        }
    });

    test('does not probe for a server in a sandbox it created', async () => {
        const client = new FakeClient();
        const runtime = await daytonaProvider({ client }).prepare(
            request(await fixture())
        );
        try {
            await runtime.preflight();
            const service = runtime.launchService(serve(runtime.workspaceDirectory));
            await service.process.exited;
            expect(client.sandbox.probes).toBe(0);
        } finally {
            await runtime.cleanup();
        }
    });
});
