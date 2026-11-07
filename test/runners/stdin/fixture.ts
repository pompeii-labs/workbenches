import { ModelRouter } from '../../../src/models/index.js';
import { ClaudeCodeSessionAdapter } from '../../../src/runners/claude-code/adapter.js';
import type { OpenRouterAccess } from '../../../src/runners/claude-code/openrouter.js';
import type { ClaudeCodeProgress } from '../../../src/runners/claude-code/progress.js';
import { RunnerContextStaging } from '../../../src/runners/context/stage.js';
import { MemoryRunnerFiles } from '../../../src/runners/files/memory.js';
import { PiSessionAdapter } from '../../../src/runners/pi/adapter.js';
import { PiConfigStaging } from '../../../src/runners/pi/config.js';
import type {
    RunnerSession,
    RunnerSessionHost,
    RunnerSessionProgress,
    RunnerSessionStartOptions,
} from '../../../src/runners/session.js';
import type { WorkbenchEventDraft } from '../../../src/runs/events.js';
import { modelCatalogFixture } from '../../model-catalog-fixture.js';
import {
    claudeCodeWorkbench,
    NO_OPENROUTER,
    PREPARED,
} from '../claude-code/fixture.js';

/** The session's progress, which must be Claude Code's. */
export function claudeCodeProgress(session: RunnerSession): ClaudeCodeProgress {
    const progress = session.progress?.();
    if (progress?.runner !== 'claude-code')
        throw new Error('Expected Claude Code progress');
    return progress as ClaudeCodeProgress;
}

const handle = {
    runtime: 'daytona' as const,
    sandboxId: 'sandbox',
    sessionId: 'process',
    commandId: 'command',
};

export class Transcript {
    command: string[] = [];
    acknowledgePrompt = true;
    readonly output: string[] = [];
    private controller!: ReadableStreamDefaultController<Uint8Array>;
    private readonly exit = Promise.withResolvers<number>();
    readonly writes: Record<string, unknown>[] = [];
    readonly child = {
        handle: Promise.resolve(handle),
        stdout: new ReadableStream<Uint8Array>({
            start: (controller) => {
                this.controller = controller;
            },
        }),
        exited: this.exit.promise,
        stdin: {
            write: (line: string) => {
                const value: unknown = JSON.parse(line);
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
                if (value.type === 'prompt' && this.acknowledgePrompt && 'id' in value)
                    this.send({ type: 'response', id: value.id, success: true });
            },
        },
        kill: () => this.end(143),
    };
    send(value: Record<string, unknown>): string {
        const line = `${JSON.stringify(value)}\n`;
        this.output.push(line);
        this.controller.enqueue(new TextEncoder().encode(line));
        return line;
    }
    replay(lines: string[]): void {
        for (const line of lines)
            this.controller.enqueue(new TextEncoder().encode(line));
    }
    private ended = false;
    end(code = 0): void {
        if (this.ended) return;
        this.ended = true;
        this.controller.close();
        this.exit.resolve(code);
    }
}

export async function start(
    runner: 'claude-code' | 'pi',
    native: Transcript,
    events: WorkbenchEventDraft[],
    progress?: RunnerSessionProgress,
    extra: {
        host?: Partial<RunnerSessionHost>;
        openRouter?: OpenRouterAccess;
        session?: RunnerSessionStartOptions['session'];
        stopTimeoutMs?: number;
    } = {}
) {
    const workbench = claudeCodeWorkbench('/workspace');
    workbench.manifest.runner = runner;
    const options: RunnerSessionStartOptions = {
        workbench,
        workspaceDirectory: '/workspace',
        environment: {},
        configuration: new ModelRouter(modelCatalogFixture).resolve({ workbench }),
        host: {
            emit: async (event) => {
                events.push(event);
            },
            requestPermission: async () => 'reject',
            requestQuestion: async () => ({ outcome: 'rejected' }),
            ...extra.host,
        },
        ...(extra.session ? { session: extra.session } : {}),
        ...(progress ? { progress } : {}),
    };
    if (runner === 'claude-code')
        return new ClaudeCodeSessionAdapter({
            ...(extra.stopTimeoutMs === undefined
                ? {}
                : { stopTimeoutMs: extra.stopTimeoutMs }),
            openRouter: extra.openRouter ?? NO_OPENROUTER,
            prepare: async () => ({ session: PREPARED, cleanup: async () => {} }),
        }).startPrepared(options, {
            ...PREPARED,
            ...(extra.openRouter ? { openRouterKey: 'fixture-key' } : {}),
            spawn: (command) => {
                native.command = command;
                return native.child;
            },
        });
    const files = new MemoryRunnerFiles();
    return new PiSessionAdapter({
        config: new PiConfigStaging(files, new RunnerContextStaging(files)),
    }).startPrepared(options, {
        configDirectory: '/config',
        spawn: (command) => {
            native.command = command;
            return native.child;
        },
    });
}

/** Sends the native lines that start and finish the latest prompted turn with `text`. */
export function finishTurn(
    runner: 'claude-code' | 'pi',
    process: Transcript,
    text: string
): void {
    if (runner === 'claude-code') {
        process.send({
            type: 'command_lifecycle',
            state: 'started',
            command_uuid: process.writes.filter((value) => value.type === 'user').at(-1)
                ?.uuid,
        });
        process.send({
            type: 'assistant',
            message: {
                id: text,
                role: 'assistant',
                content: [{ type: 'text', text }],
            },
        });
        process.send({ type: 'result', subtype: 'success', stop_reason: 'end_turn' });
    } else {
        process.send({
            type: 'message_update',
            assistantMessageEvent: { type: 'text_delta', delta: text },
        });
        process.send({ type: 'agent_settled' });
    }
}

/**
 * Lets queued stream reads and the promise chains they start run, by yielding
 * to the event loop a fixed number of turns. It never waits on the clock, so a
 * loaded machine runs the same work before it returns.
 */
export async function drain(): Promise<void> {
    for (let turn = 0; turn < 50; turn++)
        await new Promise((resolve) => setImmediate(resolve));
}
