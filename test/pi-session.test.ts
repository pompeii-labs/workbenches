import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRouter } from '../src/models/index.js';
import { PiSessionAdapter } from '../src/runners/pi/session.js';
import type { ResolvedWorkbench } from '../src/types.js';
import {
    type RunnerConformanceScenario,
    runnerAdapterContract,
} from './runner-adapter-contract.js';

const root = await mkdtemp(join(tmpdir(), 'pi-session-contract-'));
const packageDirectory = join(root, '.workbenches', 'core');
await mkdir(packageDirectory, { recursive: true });
const instructionsPath = join(packageDirectory, 'instructions.md');
await writeFile(instructionsPath, '# Pi instructions\n');

afterAll(() => rm(root, { recursive: true, force: true }));

const workbench: ResolvedWorkbench = {
    manifestPath: join(packageDirectory, 'workbench.yml'),
    packageDirectory,
    repositoryDirectory: root,
    instructionsPath,
    skills: [],
    manifest: {
        spec: 0,
        version: '0.1.0',
        name: 'pi-contract',
        runner: 'pi',
        model: { id: 'openai/gpt-5.6-terra' },
        instructions: './instructions.md',
        skills: [],
        tools: [],
        mcps: [],
        env: {},
        runtime: 'local',
    },
};

runnerAdapterContract({
    name: 'Pi',
    createHarness() {
        const native = new FakePiRpc();
        return {
            adapter: new PiSessionAdapter({ spawn: () => native.process }),
            workbench,
            arrange(scenario) {
                native.scenario = scenario;
            },
        };
    },
});

describe('Pi RPC session adapter', () => {
    test('queues native steering and follow-up messages without creating a new session', async () => {
        const native = new FakePiRpc();
        native.scenario = 'cancellation';
        const session = await new PiSessionAdapter({
            spawn: () => native.process,
        }).start({
            workbench,
            workspaceDirectory: root,
            environment: {},
            configuration: new ModelRouter().resolve({ workbench }),
            host: {
                emit: async () => {},
                requestPermission: async () => 'reject',
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
        });
        try {
            const turn = session.prompt({
                text: 'wait',
                images: [
                    {
                        data: 'aW1hZ2UtYnl0ZXM=',
                        mimeType: 'image/png',
                        name: 'ignored-by-pi.png',
                    },
                ],
            });
            await native.waitFor('prompt');
            await session.steer?.('change direction');
            await session.followUp?.('then summarize');
            await session.cancelTurn();
            await expect(turn).resolves.toEqual({ reason: 'cancelled' });
            expect(native.commands.map((command) => command.type)).toEqual([
                'get_state',
                'prompt',
                'steer',
                'follow_up',
                'abort',
            ]);
            expect(native.commands[1]).toMatchObject({
                message: 'wait',
                images: [
                    {
                        type: 'image',
                        data: 'aW1hZ2UtYnl0ZXM=',
                        mimeType: 'image/png',
                    },
                ],
            });
        } finally {
            await session.close();
        }
    });

    test('settles cancellation when Pi ends the turn before acknowledging abort', async () => {
        const native = new FakePiRpc();
        native.scenario = 'cancellation';
        native.abortEndsBeforeResponse = true;
        const session = await new PiSessionAdapter({
            spawn: () => native.process,
        }).start({
            workbench,
            workspaceDirectory: root,
            environment: {},
            configuration: new ModelRouter().resolve({ workbench }),
            host: {
                emit: async () => {},
                requestPermission: async () => 'reject',
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
        });
        try {
            const turn = session.prompt('wait');
            await native.waitFor('prompt');
            await session.cancelTurn();
            await expect(turn).resolves.toEqual({ reason: 'cancelled' });
        } finally {
            await session.close();
        }
    });

    test('rejects an active turn when the native RPC stream fails', async () => {
        const native = new FakePiRpc();
        native.scenario = 'cancellation';
        const session = await new PiSessionAdapter({
            spawn: () => native.process,
        }).start({
            workbench,
            workspaceDirectory: root,
            environment: {},
            configuration: new ModelRouter().resolve({ workbench }),
            host: {
                emit: async () => {},
                requestPermission: async () => 'reject',
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
        });
        try {
            const turn = session.prompt('wait');
            await native.waitFor('prompt');
            native.failStream();
            await expect(turn).rejects.toThrow('Pi RPC stream failed');
        } finally {
            await session.close();
        }
    });

    test('rejects a later turn when the native RPC stream failed while idle', async () => {
        const native = new FakePiRpc();
        const session = await new PiSessionAdapter({
            spawn: () => native.process,
        }).start({
            workbench,
            workspaceDirectory: root,
            environment: {},
            configuration: new ModelRouter().resolve({ workbench }),
            host: {
                emit: async () => {},
                requestPermission: async () => 'reject',
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
        });
        try {
            native.failStream();
            await Bun.sleep(0);
            await expect(session.prompt('after failure')).rejects.toThrow(
                'Pi RPC stream failed'
            );
        } finally {
            await session.close();
        }
    });
});

class FakePiRpc {
    scenario: RunnerConformanceScenario = 'streaming_text';
    abortEndsBeforeResponse = false;
    readonly commands: Array<Record<string, unknown>> = [];
    readonly process: {
        exited: Promise<number>;
        stdin: {
            write: (value: string) => void;
            flush: () => void;
            end: () => void;
        };
        stdout: ReadableStream<Uint8Array>;
        stderr: ReadableStream<Uint8Array>;
        kill: () => void;
    };
    private controller!: ReadableStreamDefaultController<Uint8Array>;
    private readonly encoder = new TextEncoder();
    private readonly commandWaiters = new Map<string, Array<() => void>>();
    private finish!: (code: number) => void;
    private closed = false;

    constructor() {
        const stdout = new ReadableStream<Uint8Array>({
            start: (controller) => {
                this.controller = controller;
            },
        });
        const exited = new Promise<number>((resolve) => {
            this.finish = resolve;
        });
        this.process = {
            exited,
            stdin: {
                write: (value) => this.receive(value),
                flush: () => {},
                end: () => {},
            },
            stdout,
            stderr: new Response('').body as ReadableStream<Uint8Array>,
            kill: () => this.close(),
        };
    }

    waitFor(type: string): Promise<void> {
        if (this.commands.some((command) => command.type === type)) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            const waiters = this.commandWaiters.get(type) ?? [];
            waiters.push(resolve);
            this.commandWaiters.set(type, waiters);
        });
    }

    failStream(): void {
        if (this.closed) return;
        this.closed = true;
        this.controller.error(new Error('native stream failure'));
    }

    private receive(value: string): void {
        const command = JSON.parse(value.trim()) as Record<string, unknown>;
        this.commands.push(command);
        const type = String(command.type);
        for (const resolve of this.commandWaiters.get(type) ?? []) resolve();
        this.commandWaiters.delete(type);
        queueMicrotask(() => this.respond(command));
    }

    private respond(command: Record<string, unknown>): void {
        const type = String(command.type);
        if (type === 'abort' && this.abortEndsBeforeResponse) {
            this.emit({
                type: 'message_end',
                message: { role: 'assistant', stopReason: 'aborted' },
            });
            this.emit({ type: 'agent_end', messages: [] });
        }
        this.emit({
            id: command.id,
            type: 'response',
            command: type,
            success: true,
            ...(type === 'get_state'
                ? { data: { sessionId: 'pi_session_contract' } }
                : {}),
        });
        if (type !== 'prompt') return;
        const input = String(command.message);
        if (this.scenario === 'cancellation' || this.scenario === 'steering') return;
        if (this.scenario === 'streaming_text') {
            this.text('Hello');
            this.text(' world');
        } else if (this.scenario === 'multi_turn') {
            this.text(input === 'first' ? 'first' : 'second');
        } else if (this.scenario === 'image_input') {
            this.text('image received');
        } else if (this.scenario === 'tool_events') {
            this.emit({
                type: 'tool_execution_start',
                toolCallId: 'call_contract',
                toolName: 'write',
                args: {
                    path: '/workspace/output.txt',
                    content: 'MUST_NOT_RENDER_TOOL_OUTPUT',
                },
            });
            this.emit({
                type: 'tool_execution_end',
                toolCallId: 'call_contract',
                toolName: 'write',
                result: { content: 'MUST_NOT_RENDER_TOOL_OUTPUT' },
                isError: false,
            });
            this.emit({
                type: 'message_end',
                message: {
                    role: 'assistant',
                    usage: {
                        input: 5,
                        output: 7,
                        totalTokens: 12,
                        cost: { total: 0.001 },
                    },
                },
            });
        } else if (this.scenario === 'failures') {
            this.emit({
                type: 'message_end',
                message: { role: 'assistant', stopReason: 'error' },
            });
        } else if (this.scenario === 'unknown_events') {
            this.emit({
                type: 'future.event',
                credential: 'MUST_NOT_RENDER_CREDENTIAL',
            });
        }
        this.emit({ type: 'turn_end', message: { stopReason: 'completed' } });
        this.emit({ type: 'agent_end', messages: [] });
    }

    private text(text: string): void {
        this.emit({
            type: 'message_update',
            assistantMessageEvent: { type: 'text_delta', delta: text },
            message: { thinking: 'MUST_NOT_RENDER_REASONING' },
        });
    }

    private emit(value: unknown): void {
        if (!this.closed) {
            this.controller.enqueue(this.encoder.encode(`${JSON.stringify(value)}\n`));
        }
    }

    private close(): void {
        if (!this.closed) {
            this.closed = true;
            this.controller.close();
        }
        this.finish(0);
    }
}
