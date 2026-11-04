import type { RunnerContext } from '../context/files.js';
import { runtimeContext } from '../context/runtime.js';
import { RunnerProcessExit } from '../exit.js';
import type {
    RunnerAdapterDeclaration,
    RunnerInput,
    RunnerInputDelivery,
    RunnerSession,
    RunnerSessionAdapter,
    RunnerSessionStartOptions,
    RunnerTurnResult,
} from '../session.js';
import { normalizeRunnerInput } from '../session.js';
import type { PiConfigStaging } from './config.js';
import { PiEventAdapter } from './events.js';
import { buildPiRpcInvocation } from './invocation.js';
import { PI_PACKAGE_VERSION } from './providers.js';
import { PiInputRequests } from './requests.js';
import {
    asError,
    consumeLines,
    readLimitedText,
    record,
    string,
    withTimeout,
} from './rpc.js';

export const PI_SESSION_DECLARATION: RunnerAdapterDeclaration = {
    native: {
        command: 'pi',
        verified: [
            { version: PI_PACKAGE_VERSION, surfaces: ['json', 'rpc'] },
            { version: '1.5.0', surfaces: ['rpc'] },
        ],
    },
    capabilities: {
        streaming_text: { status: 'supported' },
        tool_events: { status: 'supported' },
        file_events: { status: 'supported' },
        usage: { status: 'supported' },
        permissions: {
            status: 'unsupported',
            detail: 'Pi does not provide a native permission request protocol.',
        },
        questions: {
            status: 'supported',
            detail: 'Questions come from Pi extensions through native RPC dialogs.',
        },
        multi_turn: { status: 'supported' },
        steering: { status: 'supported' },
        image_input: { status: 'supported' },
        image_generation: {
            status: 'unsupported',
            detail: 'Workbench does not yet provide a normalized image-generation tool or image output event for Pi.',
        },
        session_resume: { status: 'supported' },
        cancellation: { status: 'supported' },
        failures: { status: 'supported' },
        unknown_events: { status: 'supported' },
    },
};

export interface PiInput {
    write(value: string): unknown;
    flush?(): unknown;
    end?(): void | Promise<void>;
}

export interface SpawnedPi {
    exited: Promise<number>;
    stdin: PiInput;
    stdout?: ReadableStream<Uint8Array>;
    stderr?: ReadableStream<Uint8Array>;
    kill(): void;
}

export interface PiSessionDependencies {
    /**
     * Stages config and context for a session the adapter starts itself with
     * `start`.
     */
    config: PiConfigStaging;
    spawn?: (
        command: string[],
        options: {
            cwd: string;
            env: Record<string, string | undefined>;
            stdin: 'pipe';
            stdout: 'pipe';
            stderr: 'pipe';
        }
    ) => SpawnedPi;
    startupTimeoutMs?: number;
}

export interface PreparedPiSession {
    context?: RunnerContext;
    configDirectory: string;
    spawn: NonNullable<PiSessionDependencies['spawn']>;
}

export class PiSessionAdapter implements RunnerSessionAdapter {
    readonly runner = 'pi';
    readonly declaration = PI_SESSION_DECLARATION;
    private readonly dependencies: Required<Omit<PiSessionDependencies, 'config'>>;
    private readonly config: PiConfigStaging;

    constructor(dependencies: PiSessionDependencies) {
        this.config = dependencies.config;
        this.dependencies = {
            spawn: dependencies.spawn ?? defaultSpawn,
            startupTimeoutMs: dependencies.startupTimeoutMs ?? 10_000,
        };
    }

    async start(options: RunnerSessionStartOptions): Promise<RunnerSession> {
        const staged = await this.config.stage(
            options.workbench,
            options.environment,
            {}
        );
        return this.startConfigured(
            options,
            {
                context: staged.context,
                configDirectory: staged.directory,
                spawn: this.dependencies.spawn,
            },
            () => staged.cleanup()
        );
    }

    startPrepared(
        options: RunnerSessionStartOptions,
        prepared: PreparedPiSession
    ): Promise<RunnerSession> {
        return this.startConfigured(options, prepared, async () => {});
    }

    private async startConfigured(
        options: RunnerSessionStartOptions,
        prepared: PreparedPiSession,
        cleanup: () => Promise<void>
    ): Promise<RunnerSession> {
        const session = new PiRpcSession({
            ...options,
            ...this.dependencies,
            ...prepared,
            cleanup,
        });
        try {
            await session.start();
            return session;
        } catch (error) {
            await session.close().catch(() => {});
            throw error;
        }
    }
}

interface ActiveTurn {
    adapter: PiEventAdapter;
    promise: Promise<RunnerTurnResult>;
    resolve: (result: RunnerTurnResult) => void;
    reject: (error: Error) => void;
    cancellationRequested: boolean;
    settled: boolean;
}

interface PendingResponse {
    command: string;
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
}

class PiRpcSession implements RunnerSession {
    private readonly options: RunnerSessionStartOptions &
        Required<Omit<PiSessionDependencies, 'config'>> & {
            configuration: RunnerSessionStartOptions['configuration'];
            configDirectory: string;
            context?: RunnerContext;
            cleanup: () => Promise<void>;
        };
    private readonly responses = new Map<string, PendingResponse>();
    private child: SpawnedPi | undefined;
    private stdoutLoop: Promise<void> | undefined;
    private stderrLoop: Promise<string> | undefined;
    private nativeSessionId: string | undefined;
    private active: ActiveTurn | undefined;
    private sequence = 0;
    private closed = false;
    private failure: Error | undefined;
    private runtimeReminder: string;
    private readonly requests: PiInputRequests;

    constructor(
        options: RunnerSessionStartOptions &
            Required<Omit<PiSessionDependencies, 'config'>> & {
                configuration: RunnerSessionStartOptions['configuration'];
                configDirectory: string;
                context?: RunnerContext;
                cleanup: () => Promise<void>;
            }
    ) {
        this.options = options;
        this.requests = new PiInputRequests(options.host, async (response) => {
            const child = this.child;
            if (!child || this.closed) return;
            await child.stdin.write(`${JSON.stringify(response)}\n`);
            await child.stdin.flush?.();
        });
        // RPC has no per-prompt system field. Refresh attempt facts alongside
        // the first resumed input, without changing the stored user task.
        this.runtimeReminder =
            options.context && options.session?.nativeSessionId
                ? runtimeContext(
                      options.workbench,
                      options.workspaceDirectory,
                      options.environment
                  )
                : '';
    }

    get id(): string | undefined {
        return this.nativeSessionId;
    }

    async start(): Promise<void> {
        const invocation = buildPiRpcInvocation(
            this.options.workbench,
            this.options.environment,
            this.options.workspaceDirectory,
            this.options.configuration.model,
            this.options.configDirectory,
            this.options.session,
            this.options.context
        );
        const child = this.options.spawn(invocation.command, {
            cwd: invocation.cwd,
            env: invocation.env,
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'pipe',
        });
        this.child = child;
        this.stderrLoop = readLimitedText(child.stderr, 64 * 1024);
        this.stdoutLoop = consumeLines(child.stdout, (line) =>
            this.consumeLine(line)
        ).catch((error) => {
            if (!this.closed) {
                this.fail(new Error('Pi RPC stream failed', { cause: asError(error) }));
            }
        });
        void child.exited.then((code) => {
            if (!this.closed) {
                this.fail(new Error(new RunnerProcessExit('Pi RPC').message(code)));
            }
        });

        const state = await withTimeout(
            this.command('get_state'),
            this.options.startupTimeoutMs,
            'Pi RPC did not become ready in time'
        );
        const data = record(state.data);
        this.nativeSessionId = string(data?.sessionId) ?? string(data?.sessionFile);
    }

    async prompt(input: RunnerInput): Promise<RunnerTurnResult> {
        if (this.closed) throw new Error('runner session is closed');
        if (this.failure) throw this.failure;
        if (this.active) throw new Error('runner session is already processing a turn');
        const turn = createActiveTurn();
        this.active = turn;
        try {
            const normalized = normalizeRunnerInput(input);
            await this.command(
                'prompt',
                piPrompt({
                    ...normalized,
                    text: [this.runtimeReminder, normalized.text]
                        .filter(Boolean)
                        .join('\n\n'),
                })
            );
            this.runtimeReminder = '';
        } catch (error) {
            this.failActive(asError(error));
        }
        return turn.promise.finally(() => {
            if (this.active === turn) this.active = undefined;
        });
    }

    async steer(input: RunnerInput): Promise<RunnerInputDelivery> {
        if (this.failure) throw this.failure;
        if (!this.active || this.closed) {
            throw new Error('runner session is not processing a turn');
        }
        await this.command('steer', piPrompt(normalizeRunnerInput(input)));
        return { delivered: Promise.resolve() };
    }

    async followUp(input: RunnerInput): Promise<void> {
        if (this.closed) throw new Error('runner session is closed');
        if (this.failure) throw this.failure;
        await this.command('follow_up', piPrompt(normalizeRunnerInput(input)));
    }

    async cancelTurn(): Promise<void> {
        if (!this.active || this.closed) return;
        const active = this.active;
        active.cancellationRequested = true;
        await this.requests.withdrawAll();
        try {
            await this.command('abort');
            this.finishActive('cancelled');
        } catch (error) {
            active.cancellationRequested = false;
            throw error;
        }
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        await this.requests.close();
        this.finishActive('cancelled');
        this.rejectResponses(new Error('runner session is closed'));
        await this.child?.stdin.end?.();
        this.child?.kill();
        await Promise.allSettled([
            this.stdoutLoop,
            this.stderrLoop,
            this.child?.exited,
        ]);
        await this.options.cleanup();
    }

    private async command(
        command: string,
        data: Record<string, unknown> = {}
    ): Promise<Record<string, unknown>> {
        const child = this.child;
        if (!child || this.closed) throw new Error('Pi RPC is not ready');
        if (this.failure) throw this.failure;
        this.sequence += 1;
        const id = `wb_${this.sequence}`;
        const response = new Promise<Record<string, unknown>>((resolve, reject) => {
            this.responses.set(id, { command, resolve, reject });
        });
        try {
            await child.stdin.write(
                `${JSON.stringify({ id, type: command, ...data })}\n`
            );
            await child.stdin.flush?.();
        } catch (error) {
            this.responses.delete(id);
            const failure = asError(error);
            this.fail(failure);
            throw failure;
        }
        return response;
    }

    private async consumeLine(line: string): Promise<void> {
        let value: unknown;
        try {
            value = JSON.parse(line);
        } catch {
            await this.options.host.emit({
                type: 'runner.event',
                data: { native_type: 'malformed' },
            });
            return;
        }
        const event = record(value);
        if (!event) return;
        if (event.type === 'response') {
            this.consumeResponse(event);
            return;
        }
        if (event.type === 'extension_ui_request') {
            void this.requests
                .handle(event)
                .catch((error) => this.fail(asError(error)));
            return;
        }
        const active = this.active;
        if (!active) return;
        const result = active.adapter.consume(event);
        for (const draft of result.events) {
            if (draft.type !== 'turn.completed') await this.options.host.emit(draft);
        }
        if (event.type === 'extension_error') {
            await this.requests.withdrawAll();
            this.failActive(new Error('Pi extension failed'));
            return;
        }
        // `agent_end` closes one low-level run that a retry, compaction
        // recovery, or queued input can follow; only `agent_settled` ends Pi's
        // automatic work for the prompt.
        if (event.type === 'agent_settled') {
            await this.requests.withdrawAll();
            if (active.cancellationRequested) {
                this.finishActive('cancelled');
                return;
            }
            const summary = active.adapter.summary();
            if (summary.failureMessage) {
                this.failActive(new Error(summary.failureMessage));
            } else {
                this.finishActive(summary.completionReason ?? 'completed');
            }
        }
    }

    private consumeResponse(event: Record<string, unknown>): void {
        const id = string(event.id);
        if (!id) return;
        const pending = this.responses.get(id);
        if (!pending) return;
        this.responses.delete(id);
        if (event.success === true) pending.resolve(event);
        else pending.reject(new Error(`Pi command failed: ${pending.command}`));
    }

    private finishActive(reason: string): void {
        const active = this.active;
        if (!active || active.settled) return;
        active.settled = true;
        active.resolve({ reason });
    }

    private failActive(error: Error): void {
        const active = this.active;
        if (!active || active.settled) return;
        active.settled = true;
        active.reject(error);
    }

    private fail(error: Error): void {
        this.failure ??= error;
        void this.requests.close().catch(() => {});
        this.failActive(this.failure);
        this.rejectResponses(this.failure);
    }

    private rejectResponses(error: Error): void {
        for (const response of this.responses.values()) response.reject(error);
        this.responses.clear();
    }
}

function createActiveTurn(): ActiveTurn {
    let resolve!: (result: RunnerTurnResult) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<RunnerTurnResult>((accepted, rejected) => {
        resolve = accepted;
        reject = rejected;
    });
    return {
        adapter: new PiEventAdapter(),
        promise,
        resolve,
        reject,
        cancellationRequested: false,
        settled: false,
    };
}

function piPrompt(input: ReturnType<typeof normalizeRunnerInput>) {
    return {
        message: input.text,
        ...(input.images.length > 0
            ? {
                  images: input.images.map((image) => ({
                      type: 'image',
                      data: image.data,
                      mimeType: image.mimeType,
                  })),
              }
            : {}),
    };
}

function defaultSpawn(
    command: string[],
    options: {
        cwd: string;
        env: Record<string, string | undefined>;
        stdin: 'pipe';
        stdout: 'pipe';
        stderr: 'pipe';
    }
): SpawnedPi {
    return Bun.spawn(command, options) as unknown as SpawnedPi;
}
