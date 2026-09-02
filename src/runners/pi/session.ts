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
import { stagePiConfig } from './assets.js';
import { PiEventAdapter } from './events.js';
import { buildPiRpcInvocation } from './invocation.js';

export const PI_SESSION_DECLARATION: RunnerAdapterDeclaration = {
    native: {
        command: 'pi',
        verified: [
            { version: '0.73.1', surfaces: ['json', 'rpc'] },
            { version: '0.84.3', surfaces: ['json', 'rpc'] },
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
            status: 'unsupported',
            detail: 'Pi does not provide a native question request protocol.',
        },
        multi_turn: { status: 'supported' },
        steering: { status: 'supported' },
        image_input: { status: 'supported' },
        image_generation: {
            status: 'unsupported',
            detail: 'Workbench does not yet provide a normalized image-generation tool or image output event for Pi.',
        },
        cancellation: { status: 'supported' },
        failures: { status: 'supported' },
        unknown_events: { status: 'supported' },
    },
};

interface PiInput {
    write(value: string): unknown;
    flush?(): unknown;
    end?(): void | Promise<void>;
}

interface SpawnedPi {
    exited: Promise<number>;
    stdin: PiInput;
    stdout?: ReadableStream<Uint8Array>;
    stderr?: ReadableStream<Uint8Array>;
    kill(): void;
}

export interface PiSessionDependencies {
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

export class PiSessionAdapter implements RunnerSessionAdapter {
    readonly runner = 'pi';
    readonly declaration = PI_SESSION_DECLARATION;
    private readonly dependencies: Required<PiSessionDependencies>;

    constructor(dependencies: PiSessionDependencies = {}) {
        this.dependencies = {
            spawn: dependencies.spawn ?? defaultSpawn,
            startupTimeoutMs: dependencies.startupTimeoutMs ?? 10_000,
        };
    }

    async start(options: RunnerSessionStartOptions): Promise<RunnerSession> {
        const staged = await stagePiConfig(options.workbench, options.environment);
        const session = new PiRpcSession({
            ...options,
            ...this.dependencies,
            configDirectory: staged.directory,
            cleanup: staged.cleanup,
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
        Required<PiSessionDependencies> & {
            configuration: RunnerSessionStartOptions['configuration'];
            configDirectory: string;
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

    constructor(
        options: RunnerSessionStartOptions &
            Required<PiSessionDependencies> & {
                configuration: RunnerSessionStartOptions['configuration'];
                configDirectory: string;
                cleanup: () => Promise<void>;
            }
    ) {
        this.options = options;
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
            this.options.configDirectory
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
            if (!this.closed) this.fail(new Error(`Pi RPC exited with code ${code}`));
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
            await this.command('prompt', piPrompt(normalizeRunnerInput(input)));
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
        const active = this.active;
        if (!active) return;
        const result = active.adapter.consume(event);
        for (const draft of result.events) {
            if (draft.type !== 'turn.completed') await this.options.host.emit(draft);
        }
        if (event.type === 'extension_error') {
            this.failActive(new Error('Pi extension failed'));
            return;
        }
        if (event.type === 'agent_end') {
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

async function consumeLines(
    stream: ReadableStream<Uint8Array> | undefined,
    consume: (line: string) => Promise<void>
): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    for (;;) {
        const next = await reader.read();
        if (next.done) break;
        pending += decoder.decode(next.value, { stream: true });
        if (pending.length > 16 * 1024 * 1024) {
            throw new Error('Pi RPC emitted an oversized JSON event');
        }
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
            const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
            if (normalized.trim()) await consume(normalized);
        }
    }
    pending += decoder.decode();
    if (pending.trim()) await consume(pending);
}

async function readLimitedText(
    stream: ReadableStream<Uint8Array> | undefined,
    limit: number
): Promise<string> {
    if (!stream) return '';
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let output = '';
    for (;;) {
        const next = await reader.read();
        if (next.done) break;
        if (output.length < limit) output += decoder.decode(next.value);
    }
    return output.slice(0, limit);
}

async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string
): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
            }),
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function string(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
