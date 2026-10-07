import type { WorkbenchEventDraft } from '../../runs/events.js';
import type { RunnerInvocation, SpawnedRunner } from '../../types.js';
import type {
    NormalizedRunnerInput,
    RunnerInput,
    RunnerInputDelivery,
    RunnerSessionHost,
    RunnerTurnResult,
} from '../session.js';
import { normalizeRunnerInput } from '../session.js';
import { ClaudeCodeEventAdapter } from './events.js';
import { claudeCodeInput } from './invocation.js';
import {
    asError,
    consumeLines,
    ignoredNativeMessage,
    record,
    settlesWithin,
    signal,
    string,
    strings,
    within,
} from './process-support.js';
import { ClaudeCodeInputRequests } from './requests.js';
import { ClaudeCodeSteering } from './steering.js';

interface ActiveTurn {
    uuid: string;
    promise: Promise<RunnerTurnResult>;
    resolve: (result: RunnerTurnResult) => void;
    reject: (error: Error) => void;
    settled: boolean;
    started: boolean;
    lifecycle: 'completed' | 'cancelled' | undefined;
    summary: NativeTurnSummary | undefined;
    cancellationRequested: boolean;
}

interface NativeTurn {
    adapter: ClaudeCodeEventAdapter;
    commands: Set<string>;
}

interface NativeTurnSummary {
    sessionId?: string;
    completionReason?: string;
    failureMessage?: string;
}

export interface ClaudeCodeProcessOptions {
    invocation: RunnerInvocation;
    spawn: (invocation: RunnerInvocation) => SpawnedRunner;
    emit(event: WorkbenchEventDraft): Promise<void>;
    sessionId(id: string): void;
    host: RunnerSessionHost;
    answerRequests: boolean;
    redact(value: string): string;
    reportNativeCost: boolean;
}

export class ClaudeCodeProcess {
    private child: SpawnedRunner | undefined;
    private active: ActiveTurn | undefined;
    private stdoutLoop: Promise<void> | undefined;
    private stderrLoop: Promise<void> | undefined;
    private stderrTail = '';
    private closed = false;
    private exited = false;
    private childExited = false;
    private stopping: Promise<void> | undefined;
    private requests: ClaudeCodeInputRequests | undefined;
    private nativeTurn: NativeTurn | undefined;
    private previousTotalCost = 0;
    private readonly pendingStarts = new Set<string>();
    private readonly steering: ClaudeCodeSteering;
    private readonly controls = new Map<
        string,
        { resolve: (response: Record<string, unknown> | undefined) => void }
    >();

    constructor(private readonly options: ClaudeCodeProcessOptions) {
        this.steering = new ClaudeCodeSteering((value) => this.writeLine(value));
    }

    start(): void {
        const child = this.options.spawn(this.options.invocation);
        if (!child.stdin) {
            child.kill?.();
            throw new Error('Runtime did not expose Claude Code session input');
        }
        this.child = child;
        this.requests = new ClaudeCodeInputRequests(
            this.options.host,
            (value) => this.write(value),
            this.options.emit,
            this.options.answerRequests
        );
        this.stdoutLoop = consumeLines(child.stdout, (line) =>
            this.consumeLine(line)
        ).catch((error) => this.fail(asError(error)));
        this.stderrLoop = this.consumeStderr(child.stderr).catch((error) =>
            this.fail(asError(error))
        );
        void child.exited
            .then((code) => {
                this.childExited = true;
                return this.handleExit(code);
            })
            .catch((error) => this.fail(asError(error), false));
    }

    get running(): boolean {
        return !this.closed && !this.exited;
    }

    prompt(input: NormalizedRunnerInput): Promise<RunnerTurnResult> {
        if (!this.running || !this.child?.stdin) {
            return Promise.reject(new Error('Claude Code process is not running'));
        }
        if (this.active) {
            return Promise.reject(
                new Error('runner session is already processing a turn')
            );
        }
        const active = createActiveTurn(crypto.randomUUID());
        this.active = active;
        let write: unknown;
        try {
            write = this.child.stdin.write(claudeCodeInput(input, active.uuid));
        } catch (error) {
            this.fail(asError(error));
            return active.promise;
        }
        Promise.resolve(write)
            .then(() => this.child?.stdin?.flush?.())
            .catch((error) => this.fail(asError(error)));
        return active.promise.finally(() => {
            if (this.active === active) this.active = undefined;
        });
    }

    async steer(input: RunnerInput): Promise<RunnerInputDelivery> {
        if (!this.active || this.active.settled || !this.running) {
            throw new Error('runner session is not processing a turn');
        }
        const normalized = normalizeRunnerInput(input);
        const uuid = crypto.randomUUID();
        try {
            return await this.steering.add(uuid, claudeCodeInput(normalized, uuid));
        } catch (error) {
            this.fail(asError(error));
            throw error;
        }
    }

    async cancel(): Promise<void> {
        const active = this.active;
        if (!active || active.settled) return;
        // Claude Code 2.1.292 acknowledges this correlated interrupt before
        // emitting the cancelled command lifecycle.
        active.cancellationRequested = true;
        const acknowledged = await this.control(
            { subtype: 'interrupt', cancel_queued: true },
            5_000
        );
        this.rejectCancelledSteers(acknowledged);
        if (
            acknowledged !== undefined &&
            (await settlesWithin(
                active.promise.then(
                    () => undefined,
                    () => undefined
                ),
                5_000
            ))
        ) {
            return;
        }
        this.exited = true;
        active.settled = true;
        active.resolve({ reason: 'cancelled' });
        await this.stop();
    }

    async close(): Promise<void> {
        if (this.closed) return;
        try {
            await this.requests?.close(true);
        } finally {
            this.closed = true;
            this.finishActive(new Error('runner session is closed'));
            this.steering.rejectAll('runner session is closed');
            await this.stop();
        }
    }

    private async consumeLine(line: string): Promise<void> {
        let value: unknown;
        try {
            value = JSON.parse(line);
        } catch {
            await this.options.emit({
                type: 'runner.event',
                data: { native_type: 'malformed' },
            });
            return;
        }
        const message = record(value);
        if (!message) return;
        const sessionId = string(message.session_id);
        if (sessionId) this.options.sessionId(sessionId);
        if (message.type === 'control_response') {
            this.consumeControlResponse(message);
            return;
        }
        if (message.type === 'control_cancel_request') {
            const requestId = string(message.request_id);
            if (requestId) this.requests?.cancel(requestId);
            return;
        }
        if (message.type === 'control_request') {
            this.requests?.handle(message);
            return;
        }
        if (message.type === 'keep_alive') return;
        if (message.type === 'command_lifecycle') {
            this.consumeCommandLifecycle(message);
            return;
        }
        if (ignoredNativeMessage(message)) return;
        if (message.type === 'system' && message.subtype === 'init') {
            this.steering.beginNativeTurn();
            this.nativeTurn = {
                adapter: new ClaudeCodeEventAdapter(
                    this.previousTotalCost,
                    this.options.reportNativeCost
                ),
                commands: new Set(this.pendingStarts),
            };
            this.pendingStarts.clear();
        }
        const active = this.active;
        const nativeTurn = this.currentNativeTurn();
        await this.steering.observe(
            message,
            Boolean(active && nativeTurn.commands.has(active.uuid))
        );
        const result = nativeTurn.adapter.consume(value);
        if (!active?.cancellationRequested) {
            for (const event of result.events) {
                if (event.type !== 'turn.completed') await this.options.emit(event);
            }
        }
        if (!result.terminal) return;
        const summary = nativeTurn.adapter.summary();
        this.previousTotalCost = nativeTurn.adapter.totalCost;
        this.nativeTurn = undefined;
        if (summary.sessionId) this.options.sessionId(summary.sessionId);
        if (active && nativeTurn.commands.has(active.uuid)) {
            active.summary = summary;
            this.settleActiveLifecycle();
        }
    }

    private consumeControlResponse(message: Record<string, unknown>): void {
        const response = record(message.response);
        const requestId = string(response?.request_id);
        if (!requestId) return;
        const pending = this.controls.get(requestId);
        if (!pending) return;
        this.controls.delete(requestId);
        pending.resolve(
            response?.subtype === 'success'
                ? (record(response.response) ?? {})
                : undefined
        );
    }

    private consumeCommandLifecycle(message: Record<string, unknown>): void {
        const uuid = string(message.command_uuid);
        const state = string(message.state);
        if (!uuid || !state) return;
        const active = this.active;
        if (state === 'started') {
            if (uuid === active?.uuid) active.started = true;
            if (this.steering.started(uuid)) {
                if (active?.started && !active.settled && this.nativeTurn) {
                    this.nativeTurn.commands.add(uuid);
                } else {
                    this.pendingStarts.add(uuid);
                }
            } else if (this.nativeTurn && active?.started && !active.settled) {
                this.nativeTurn.commands.add(uuid);
            } else {
                this.pendingStarts.add(uuid);
            }
            return;
        }
        if (state !== 'completed' && state !== 'cancelled') return;
        this.pendingStarts.delete(uuid);
        this.steering.finished(uuid);
        if (!active || active.uuid !== uuid || active.settled) return;
        active.lifecycle = state;
        this.steering.rejectHeld('Claude Code did not consume steering input');
        this.settleActiveLifecycle();
    }

    private settleActiveLifecycle(): void {
        const active = this.active;
        if (!active || active.settled || !active.lifecycle) return;
        if (active.lifecycle === 'cancelled' || active.cancellationRequested) {
            active.settled = true;
            active.resolve({ reason: 'cancelled' });
            return;
        }
        if (!active.summary) return;
        if (active.summary.failureMessage) {
            this.fail(new Error(active.summary.failureMessage));
            return;
        }
        active.settled = true;
        active.resolve({ reason: active.summary.completionReason ?? 'completed' });
    }

    private currentNativeTurn(): NativeTurn {
        if (this.nativeTurn) return this.nativeTurn;
        const nativeTurn = {
            adapter: new ClaudeCodeEventAdapter(
                this.previousTotalCost,
                this.options.reportNativeCost
            ),
            commands: new Set(this.pendingStarts),
        };
        this.pendingStarts.clear();
        this.nativeTurn = nativeTurn;
        return nativeTurn;
    }

    private async control(
        request: Record<string, unknown>,
        timeoutMs: number
    ): Promise<Record<string, unknown> | undefined> {
        if (!this.running) return undefined;
        const requestId = crypto.randomUUID();
        const response = new Promise<Record<string, unknown> | undefined>((resolve) => {
            this.controls.set(requestId, { resolve });
        });
        try {
            await this.write({
                type: 'control_request',
                request_id: requestId,
                request,
            });
            return await within(response, timeoutMs);
        } finally {
            this.controls.delete(requestId);
        }
    }

    private write(value: Record<string, unknown>): Promise<void> {
        return this.writeLine(`${JSON.stringify(value)}\n`).catch((error) => {
            const failure = asError(error);
            this.fail(failure);
            throw failure;
        });
    }

    private async writeLine(value: string): Promise<void> {
        if (!this.child?.stdin || !this.running) {
            throw new Error('Claude Code process is not running');
        }
        await this.child.stdin.write(value);
        await this.child.stdin.flush?.();
    }

    private async consumeStderr(
        stream: ReadableStream<Uint8Array> | undefined
    ): Promise<void> {
        if (!stream) return;
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        for (;;) {
            const next = await reader.read();
            if (next.done) break;
            this.stderrTail =
                `${this.stderrTail}${decoder.decode(next.value, { stream: true })}`.slice(
                    -64 * 1024
                );
        }
        this.stderrTail = `${this.stderrTail}${decoder.decode()}`.slice(-64 * 1024);
    }

    private async handleExit(code: number): Promise<void> {
        this.exited = true;
        await this.requests?.close(false);
        await Promise.allSettled([this.stdoutLoop, this.stderrLoop]);
        const active = this.active;
        if (!active || active.settled || this.closed) return;
        const detail = prioritizeErrorLine(this.options.redact(this.stderrTail.trim()));
        this.fail(
            new Error(
                detail
                    ? `Claude Code exited without a result (code ${code}): ${detail}`
                    : `Claude Code exited without a result (code ${code})`
            ),
            false
        );
    }

    private fail(error: Error, stop = true): void {
        error = new Error(this.options.redact(error.message), { cause: error });
        this.exited = true;
        void this.requests?.close(false);
        for (const pending of this.controls.values()) pending.resolve(undefined);
        this.controls.clear();
        this.finishActive(error);
        this.steering.rejectAll(error.message);
        if (stop) void this.stop().catch(() => {});
    }

    private rejectCancelledSteers(response: Record<string, unknown> | undefined): void {
        const cancelled = new Set([
            ...strings(response?.still_queued),
            ...strings(response?.cancelled),
        ]);
        this.steering.rejectCancelled(
            cancelled,
            'Claude Code did not consume steering input'
        );
    }

    private finishActive(error: Error): void {
        const active = this.active;
        if (!active || active.settled) return;
        active.settled = true;
        active.reject(error);
    }

    private async stop(): Promise<void> {
        if (this.stopping) return this.stopping;
        this.stopping = this.stopChild();
        return this.stopping;
    }

    private async stopChild(): Promise<void> {
        const child = this.child;
        if (!child || this.childExited) return;
        this.exited = true;
        signal(child, 'SIGTERM');
        const stopped = Promise.allSettled([
            child.exited,
            this.stdoutLoop,
            this.stderrLoop,
        ]).then(() => undefined);
        if (await settlesWithin(stopped, 1_000)) return;
        signal(child, 'SIGKILL');
        await settlesWithin(stopped, 1_000);
    }
}

function prioritizeErrorLine(value: string): string {
    const lines = value.split('\n');
    const index = lines.findIndex((line) => line.trimStart().startsWith('error:'));
    if (index <= 0) return value;
    const error = lines[index]?.trimStart();
    if (!error) return value;
    return [error, ...lines.slice(0, index), ...lines.slice(index + 1)].join('\n');
}

function createActiveTurn(uuid: string): ActiveTurn {
    let resolve = (_result: RunnerTurnResult) => {};
    let reject = (_error: Error) => {};
    const promise = new Promise<RunnerTurnResult>((accepted, rejected) => {
        resolve = accepted;
        reject = rejected;
    });
    return {
        uuid,
        promise,
        resolve,
        reject,
        settled: false,
        started: false,
        lifecycle: undefined,
        summary: undefined,
        cancellationRequested: false,
    };
}
