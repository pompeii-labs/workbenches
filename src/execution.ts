export type WorkbenchEventType =
    | 'run.started'
    | 'run.ready'
    | 'turn.started'
    | 'turn.completed'
    | 'output.text'
    | 'tool.started'
    | 'tool.completed'
    | 'file.changed'
    | 'input.requested'
    | 'usage.updated'
    | 'run.completed'
    | 'run.failed'
    | 'run.cancelled'
    | 'runner.event';

export interface WorkbenchEvent<T = unknown> {
    protocol: 0;
    run_id: string;
    sequence: number;
    timestamp: string;
    type: WorkbenchEventType;
    runner: string;
    data: T;
}

export interface RunRequest {
    runId: string;
    task: string;
    repository: string;
    instructions: string[];
    skills: string[];
    mcps: string[];
    runner: string;
    model: string;
}

export type RunStatus = 'completed' | 'failed' | 'cancelled';

export interface RunResult {
    runId: string;
    status: RunStatus;
    error?: { message: string };
}

export interface RunHandle {
    runId: string;
    events: AsyncIterable<WorkbenchEvent>;
    send(input: string): Promise<void>;
    close(): Promise<void>;
    cancel(reason?: string): Promise<void>;
    result: Promise<RunResult>;
}

interface ManagedRunOptions {
    runId: string;
    runner: string;
    onInput: (input: string) => Promise<void> | void;
    onClose?: () => Promise<void> | void;
    onCancel?: (reason?: string) => Promise<void> | void;
    now?: () => Date;
}

export class ManagedRun implements RunHandle {
    readonly runId: string;
    readonly events: AsyncIterable<WorkbenchEvent>;
    readonly result: Promise<RunResult>;

    private readonly channel = new AsyncEventChannel<WorkbenchEvent>();
    private readonly runner: string;
    private readonly onInput: ManagedRunOptions['onInput'];
    private readonly onClose: NonNullable<ManagedRunOptions['onClose']>;
    private readonly onCancel: NonNullable<ManagedRunOptions['onCancel']>;
    private readonly now: NonNullable<ManagedRunOptions['now']>;
    private readonly resolveResult: (result: RunResult) => void;
    private sequence = 0;
    private terminal = false;
    private closePromise?: Promise<void>;
    private cancelPromise?: Promise<void>;

    constructor(options: ManagedRunOptions) {
        if (!options.runId.trim()) throw new Error('runId must not be empty');
        if (!options.runner.trim()) throw new Error('runner must not be empty');
        this.runId = options.runId;
        this.runner = options.runner;
        this.onInput = options.onInput;
        this.onClose = options.onClose ?? (() => {});
        this.onCancel = options.onCancel ?? (() => {});
        this.now = options.now ?? (() => new Date());
        this.events = this.channel;
        let resolveResult!: (result: RunResult) => void;
        this.result = new Promise((resolve) => {
            resolveResult = resolve;
        });
        this.resolveResult = resolveResult;
    }

    emit<T>(type: WorkbenchEventType, data: T): WorkbenchEvent<T> {
        if (this.terminal) throw new Error('run is already terminal');
        this.sequence += 1;
        const event: WorkbenchEvent<T> = {
            protocol: 0,
            run_id: this.runId,
            sequence: this.sequence,
            timestamp: this.now().toISOString(),
            type,
            runner: this.runner,
            data,
        };
        this.channel.push(event);
        return event;
    }

    async send(input: string): Promise<void> {
        if (this.terminal || this.closePromise || this.cancelPromise) {
            throw new Error('run is not accepting input');
        }
        const normalized = input.trim();
        if (!normalized) throw new Error('input must not be empty');
        await this.onInput(normalized);
    }

    close(): Promise<void> {
        if (this.terminal) return Promise.resolve();
        if (this.closePromise) return this.closePromise;
        this.closePromise = (async () => {
            try {
                await this.onClose();
                this.complete();
            } catch (error) {
                this.fail(error);
            }
        })();
        return this.closePromise;
    }

    cancel(reason?: string): Promise<void> {
        if (this.terminal) return Promise.resolve();
        if (this.cancelPromise) return this.cancelPromise;
        this.cancelPromise = (async () => {
            try {
                await this.onCancel(reason);
                this.finish('cancelled', 'run.cancelled', {
                    reason: reason?.trim() || undefined,
                });
            } catch (error) {
                this.fail(error);
            }
        })();
        return this.cancelPromise;
    }

    complete(): void {
        this.finish('completed', 'run.completed', {});
    }

    fail(error: unknown): void {
        const message = error instanceof Error ? error.message : String(error);
        this.finish('failed', 'run.failed', { message });
    }

    private finish(
        status: RunStatus,
        eventType: 'run.completed' | 'run.failed' | 'run.cancelled',
        data: Record<string, unknown>
    ): void {
        if (this.terminal) return;
        this.emit(eventType, data);
        this.terminal = true;
        this.channel.close();
        this.resolveResult({
            runId: this.runId,
            status,
            ...(status === 'failed' && typeof data.message === 'string'
                ? { error: { message: data.message } }
                : {}),
        });
    }
}

class AsyncEventChannel<T> implements AsyncIterable<T> {
    private readonly values: T[] = [];
    private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
    private closed = false;

    push(value: T): void {
        if (this.closed) throw new Error('event channel is closed');
        const waiter = this.waiters.shift();
        if (waiter) waiter({ done: false, value });
        else this.values.push(value);
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        for (const waiter of this.waiters.splice(0)) {
            waiter({ done: true, value: undefined });
        }
    }

    [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
            next: () => {
                const value = this.values.shift();
                if (value !== undefined) {
                    return Promise.resolve({ done: false, value });
                }
                if (this.closed) {
                    return Promise.resolve({ done: true, value: undefined });
                }
                return new Promise((resolve) => this.waiters.push(resolve));
            },
        };
    }
}
