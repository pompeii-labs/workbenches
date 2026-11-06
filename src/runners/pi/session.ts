import type { RunnerContext } from '../context/files.js';
import { runtimeContext } from '../context/runtime.js';
import { RunnerProcessExit } from '../exit.js';
import type {
    RunnerInput,
    RunnerInputDelivery,
    RunnerSession,
    RunnerSessionStartOptions,
    RunnerTurnResult,
} from '../session.js';
import { normalizeRunnerInput } from '../session.js';
import { StdinReplay } from '../stdin/progress.js';
import type { PiSessionDependencies, SpawnedPi } from './adapter.js';
import { PiEventAdapter } from './events.js';
import { buildPiRpcInvocation } from './invocation.js';
import type { PiProgress } from './progress.js';
import { PiInputRequests } from './requests.js';
import { PiResponses } from './responses.js';
import {
    asError,
    consumeLines,
    readLimitedText,
    record,
    string,
    withTimeout,
} from './rpc.js';

interface ActiveTurn {
    command: string;
    adapter: PiEventAdapter;
    promise: Promise<RunnerTurnResult>;
    resolve: (result: RunnerTurnResult) => void;
    reject: (error: Error) => void;
    cancellationRequested: boolean;
    settled: boolean;
}

export class PiRpcSession implements RunnerSession {
    private readonly replay: StdinReplay;
    private readonly saved: PiProgress | undefined;
    private readonly options: RunnerSessionStartOptions &
        Required<Omit<PiSessionDependencies, 'config'>> & {
            configuration: RunnerSessionStartOptions['configuration'];
            configDirectory: string;
            context?: RunnerContext;
            cleanup: () => Promise<void>;
        };
    private readonly responses = new PiResponses();
    private child: SpawnedPi | undefined;
    private stdoutLoop: Promise<void> | undefined;
    private stderrLoop: Promise<string> | undefined;
    private nativeSessionId: string | undefined;
    private active: ActiveTurn | undefined;
    private resumable: ActiveTurn | undefined;
    private sequence = 0;
    private closed = false;
    private failure: Error | undefined;
    private runtimeReminder: string;
    private readonly requests: PiInputRequests;
    private failedRequests: ReturnType<PiInputRequests['progress']> | undefined;

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
        const saved = options.progress;
        if (saved && saved.runner !== 'pi') throw new Error('Expected Pi progress');
        const progress = saved as PiProgress | undefined;
        this.saved = progress;
        this.replay = new StdinReplay(options.host, progress, (command) => {
            this.active = createActiveTurn(command);
        });
        this.nativeSessionId = progress?.sessionId;
        this.sequence = progress?.sequence ?? 0;
        if (progress) this.responses.restore(progress.pendingCommands);
        if (
            progress?.sessionId &&
            options.session?.nativeSessionId &&
            progress.sessionId !== options.session.nativeSessionId
        )
            throw new Error('Pi progress belongs to another session');
        this.requests = new PiInputRequests(
            this.replay.host,
            async (response) => {
                if (this.replay.silent) return;
                const child = this.child;
                if (!child || this.closed) return;
                await child.stdin.write(`${JSON.stringify(response)}\n`);
                await child.stdin.flush?.();
                if (typeof response.id === 'string')
                    this.replay.answeredRequest(response.id);
            },
            (id) => this.replay.expire(id)
        );
        if (progress) this.requests.restore(progress);
        // RPC has no per-prompt system field. Refresh attempt facts alongside
        // the first resumed input, without changing the stored user task.
        this.runtimeReminder =
            options.context &&
            (progress
                ? progress.runtimeReminderPending
                : options.session?.nativeSessionId)
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
        this.replay.start();
        this.replay.afterReplay(() => {
            if (this.saved) {
                if (this.saved.activeTurn) this.resumable = this.active;
                else this.active = undefined;
                if (this.active)
                    this.active.cancellationRequested = this.saved.cancelling;
            }
        });
        this.stderrLoop = readLimitedText(child.stderr, 64 * 1024);
        this.stdoutLoop = consumeLines(child.stdout, (line, bytes) =>
            this.replay.line(line, bytes, (value) => this.consumeLine(value))
        )
            .then(() => this.replay.end())
            .catch((error) => {
                this.replay.fail(asError(error));
                if (!this.closed) {
                    this.fail(
                        new Error('Pi RPC stream failed', { cause: asError(error) })
                    );
                }
            });

        void child.exited
            .then(async (code) => {
                // A runtime command's output closes when it exits, so the exit
                // waits for all of it; a host child's descendants can hold it open.
                if (child.handle) await this.stdoutLoop;
                if (!this.closed) {
                    this.fail(new Error(new RunnerProcessExit('Pi RPC').message(code)));
                }
            })
            .catch((error) => {
                this.replay.fail(asError(error));
                this.fail(asError(error));
            });
        if (child.handle)
            this.replay.handle = (await child.handle) ?? this.replay.handle;

        if (this.saved) {
            await this.replay.caughtUp();
            return;
        }

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
        // The turn is named by the id of the prompt command that starts it.
        const turn = createActiveTurn(this.nextCommandId());
        this.replay.startTurn(turn.command);
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
                }),
                turn.command
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

    progress(): PiProgress {
        if (this.replay.silent && this.saved) return structuredClone(this.saved);
        return {
            runner: 'pi',
            ...(this.id ? { sessionId: this.id } : {}),
            ...this.replay.progress(),
            sequence: this.sequence,
            cancelling: Boolean(
                this.active?.cancellationRequested ||
                    this.responses
                        .progress()
                        .some((pending) => pending.command === 'abort')
            ),
            pendingCommands: this.responses.progress(),
            runtimeReminderPending: Boolean(this.runtimeReminder),
            ...(this.failedRequests ?? this.requests.progress()),
        };
    }

    async resumeTurn(): Promise<RunnerTurnResult> {
        await this.replay.caughtUp();
        const turn = this.resumable ?? (this.active?.settled ? undefined : this.active);
        if (!turn) throw new Error('Pi has no turn to resume');
        return turn.promise.finally(() => {
            if (this.active === turn) this.active = undefined;
            if (this.resumable === turn) this.resumable = undefined;
        });
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
        this.responses.rejectAll(new Error('runner session is closed'));
        await this.child?.stdin.end?.();
        this.child?.kill();
        await Promise.allSettled([
            this.stdoutLoop,
            this.stderrLoop,
            this.child?.exited,
        ]);
        await this.options.cleanup();
    }

    private nextCommandId(): string {
        this.sequence += 1;
        return `wb_${this.sequence}`;
    }

    private async command(
        command: string,
        data: Record<string, unknown> = {},
        id?: string
    ): Promise<Record<string, unknown>> {
        const child = this.child;
        if (!child || this.closed) throw new Error('Pi RPC is not ready');
        if (this.failure) throw this.failure;
        id ??= this.nextCommandId();
        const response = this.responses.start(id, command);
        try {
            await child.stdin.write(
                `${JSON.stringify({ id, type: command, ...data })}\n`
            );
            await child.stdin.flush?.();
        } catch (error) {
            this.responses.forget(id);
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
            await this.replay.host.emit({
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
            if (
                this.replay.silent &&
                typeof event.id === 'string' &&
                this.replay.hasAnswer(event.id)
            )
                return;
            void this.requests
                .handle(event)
                .catch((error) => this.fail(asError(error)));
            return;
        }
        const active = this.active;
        if (!active || active.settled) return;
        const result = active.adapter.consume(event);
        for (const draft of result.events) {
            if (draft.type !== 'turn.completed') await this.replay.host.emit(draft);
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
        const response = this.responses.consume(event, (action) =>
            this.replay.commit(action)
        );
        if (response && !response.recovered) return;
        const command =
            response?.command ??
            (event.id === this.active?.command ? 'prompt' : undefined);
        if (command === 'prompt') {
            if (event.success === true) this.runtimeReminder = '';
            else this.failActive(new Error('Pi command failed: prompt'));
        } else if (command === 'abort') {
            if (event.success === true) this.finishActive('cancelled');
            else if (this.active) this.active.cancellationRequested = false;
        }
    }

    private finishActive(reason: string): void {
        const active = this.active;
        if (!active || active.settled) return;
        active.settled = true;
        this.replay.endTurn(active.command);
        active.resolve({ reason });
    }

    private failActive(error: Error, completed = true): void {
        const active = this.active;
        if (!active || active.settled) return;
        active.settled = true;
        if (completed) this.replay.endTurn(active.command);
        active.reject(error);
    }

    private fail(error: Error): void {
        this.failedRequests ??= this.requests.progress();
        this.failure ??= error;
        void this.requests.close().catch(() => {});
        this.failActive(this.failure, false);
        this.responses.rejectAll(this.failure, true);
    }
}

function createActiveTurn(command: string): ActiveTurn {
    let resolve!: (result: RunnerTurnResult) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<RunnerTurnResult>((accepted, rejected) => {
        resolve = accepted;
        reject = rejected;
    });
    void promise.catch(() => {});
    return {
        command,
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
