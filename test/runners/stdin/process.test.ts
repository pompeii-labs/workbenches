import { afterEach, expect, test } from 'bun:test';
import { ModelRouter } from '../../../src/models/index.js';
import { ClaudeCodeConfigStaging } from '../../../src/runners/claude-code/config.js';
import { ClaudeCodeRunner } from '../../../src/runners/claude-code/runner.js';
import { RunnerContextStaging } from '../../../src/runners/context/stage.js';
import { DiskRunnerFiles } from '../../../src/runners/files/disk.js';
import { PiConfigStaging } from '../../../src/runners/pi/config.js';
import { PiRunner } from '../../../src/runners/pi/runner.js';
import { MemoryAssetSource } from '../../../src/runtimes/staging/memory/source.js';
import type { SpawnedRunner } from '../../../src/types.js';
import { modelCatalogFixture } from '../../model-catalog-fixture.js';
import {
    cleanTemporaryDirectories,
    daytonaProvider,
    FakeClient,
    fixture,
    request,
} from '../../runtimes/daytona/fixture.js';
import { NO_OPENROUTER } from '../claude-code/fixture.js';
import { drain } from './fixture.js';

afterEach(cleanTemporaryDirectories);

class NativeProcess {
    readonly writes: Record<string, unknown>[] = [];
    readonly output: string[] = [];
    private readonly exit = Promise.withResolvers<number>();
    private controller!: ReadableStreamDefaultController<Uint8Array>;
    private ended = false;
    readonly child: SpawnedRunner = {
        handle: Promise.resolve({
            runtime: 'daytona',
            sandboxId: 'sandbox-fixture',
            sessionId: 'wb-process',
            commandId: 'cmd',
        }),
        stdout: new ReadableStream({
            start: (controller) => {
                this.controller = controller;
            },
        }),
        exited: this.exit.promise,
        stdin: {
            write: (line) => {
                const value: unknown = JSON.parse(String(line));
                if (typeof value !== 'object' || value === null || !('type' in value))
                    throw new Error('Expected stdin command');
                this.writes.push(value);
                if (value.type === 'get_state' && 'id' in value)
                    this.send({
                        type: 'response',
                        id: value.id,
                        success: true,
                        data: { sessionId: 'native' },
                    });
                if (value.type === 'prompt' && 'id' in value)
                    this.send({ type: 'response', id: value.id, success: true });
            },
        },
        kill: () => {
            if (!this.ended) {
                this.ended = true;
                this.controller.close();
                this.exit.resolve(143);
            }
        },
    };
    send(value: Record<string, unknown>): void {
        const line = `${JSON.stringify(value)}\n`;
        this.output.push(line);
        this.controller.enqueue(new TextEncoder().encode(line));
    }
    replay(lines: string[]): void {
        for (const line of lines)
            this.controller.enqueue(new TextEncoder().encode(line));
    }
}

for (const runnerName of ['claude-code', 'pi'] as const) {
    test(`${runnerName} uses native resume on an adopted runtime and attaches only with saved progress`, async () => {
        const workbench = await fixture();
        workbench.manifest.runner = runnerName;
        workbench.manifest.model = { id: 'anthropic/claude-sonnet-4-5' };
        const files = new DiskRunnerFiles();
        const context = new RunnerContextStaging(files);
        const runner =
            runnerName === 'claude-code'
                ? new ClaudeCodeRunner({
                      config: new ClaudeCodeConfigStaging(
                          files,
                          context,
                          new MemoryAssetSource()
                      ),
                      catalog: () => modelCatalogFixture,
                      openRouter: NO_OPENROUTER,
                  })
                : new PiRunner(
                      new PiConfigStaging(files, context),
                      () => modelCatalogFixture
                  );
        const ready = await runner.prepare(workbench, {});
        const client = new FakeClient();
        const provider = daytonaProvider({ client });
        const prepared = {
            ...request(workbench),
            assets: [...request(workbench).assets, ...ready.assets],
            environment: { ANTHROPIC_API_KEY: 'fixture-key' },
        };
        const first = await provider.prepare(prepared);
        await first.preflight();
        const runtime = await provider.adopt(prepared, client.sandbox.id);
        const native = new NativeProcess();
        let launches = 0;
        let attaches = 0;
        let command: string[] = [];
        runtime.launchSession = (invocation) => {
            launches++;
            command = invocation.command;
            return native.child;
        };
        const attached = new NativeProcess();
        runtime.attachSession = (handle) => {
            attaches++;
            expect(handle).toEqual({
                runtime: 'daytona',
                sandboxId: 'sandbox-fixture',
                sessionId: 'wb-process',
                commandId: 'cmd',
            });
            return attached.child;
        };
        const options = {
            configuration: new ModelRouter(modelCatalogFixture).configure({
                runner,
                model: workbench.manifest.model,
                provider: 'anthropic',
                environmentNames: ['ANTHROPIC_API_KEY'],
            }),
            host: {
                emit: async () => {},
                requestPermission: async () => 'reject' as const,
                requestQuestion: async () => ({ outcome: 'rejected' as const }),
            },
            session: { id: 'wb', directory: '/state', nativeSessionId: 'native' },
        };
        try {
            await runtime.preflight();
            const session = await ready.startSession(runtime, options);
            try {
                expect(launches).toBe(1);
                expect(attaches).toBe(0);
                expect(command).toContain(
                    runnerName === 'claude-code' ? '--resume' : '--session'
                );
                expect(command.join(' ')).toContain('native');
                const turn = session.prompt('work');
                await drain();
                const progress = session.progress?.();
                if (!progress) throw new Error('Expected progress');
                const starting = ready.startSession(runtime, { ...options, progress });
                attached.replay(native.output);
                const resumed = await starting;
                try {
                    expect(launches).toBe(1);
                    expect(attaches).toBe(1);
                    expect(attached.writes).toEqual([]);
                } finally {
                    await resumed.close();
                }
                await session.close();
                await turn;
            } finally {
                await session.close();
            }
        } finally {
            await runtime.cleanup();
            await first.cleanup();
            await ready.cleanup();
        }
    });
}
