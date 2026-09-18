import type { WorkbenchEvent } from './events.js';
import { RunStore, type StoredRun } from './store.js';

export type SupervisionState =
    | 'starting'
    | 'running'
    | 'idle'
    | 'turn_completed'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'needs_input'
    | 'timeout';

export interface PendingRunRequest {
    id: string;
    kind: 'permission' | 'question' | 'authentication';
    sequence: number;
    details: Record<string, unknown>;
}

export interface RunSnapshot {
    session_id: string;
    run_id: string;
    state: SupervisionState;
    sequence: number;
    final: string;
    usage: Record<string, unknown>;
    outcome_id?: string;
    error?: string;
    pending_requests: PendingRunRequest[];
    interrupted?: boolean;
}

/** Read-only projection of the existing run protocol, not a second run state. */
export class RunSupervision {
    private readonly store: RunStore;

    constructor(home: string) {
        this.store = new RunStore(home);
    }

    async snapshot(run: StoredRun): Promise<RunSnapshot> {
        await this.store.reconcile(await this.store.read(run.id));
        const view = new RunObservation(run);
        for (const event of await this.store.readEvents(run.id)) view.apply(event);
        return this.settledSnapshot(
            view,
            await this.store.reconcile(await this.store.read(run.id))
        );
    }

    async wait(
        run: StoredRun,
        options: {
            afterSequence?: number;
            timeoutMilliseconds?: number;
            signal?: AbortSignal;
            terminalOnly?: boolean;
        } = {}
    ): Promise<RunSnapshot> {
        const after = options.afterSequence ?? 0;
        const timeout = options.timeoutMilliseconds;
        if (!Number.isSafeInteger(after) || after < 0)
            throw new Error('--after must be a non-negative integer');
        if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0))
            throw new Error('--timeout must be a non-negative number of seconds');
        const view = new RunObservation(run);
        let sequence = 0;
        const controller = new AbortController();
        const stop = () => controller.abort();
        options.signal?.addEventListener('abort', stop, { once: true });
        const timer = timeout === undefined ? undefined : setTimeout(stop, timeout);
        try {
            await this.store.reconcile(await this.store.read(run.id));
            for (const event of await this.store.readEvents(run.id)) view.apply(event);
            sequence = view.sequence;
            let current = await this.store.reconcile(await this.store.read(run.id));
            let result = await this.settledSnapshot(view, current);
            let boundary = view.boundarySnapshot(result, after, options.terminalOnly);
            if (boundary) return boundary;
            if (!controller.signal.aborted && !options.signal?.aborted) {
                for await (const event of this.store.follow(run.id, {
                    afterSequence: sequence,
                    signal: controller.signal,
                    pollMilliseconds: 25,
                })) {
                    view.apply(event);
                    current = await this.store.reconcile(await this.store.read(run.id));
                    result = await this.settledSnapshot(view, current);
                    boundary = view.boundarySnapshot(
                        result,
                        after,
                        options.terminalOnly
                    );
                    if (boundary) return boundary;
                }
            }
            // Terminal records can precede the observer's final metadata read.
            current = await this.store.reconcile(await this.store.read(run.id));
            result = await this.settledSnapshot(view, current);
            boundary = view.boundarySnapshot(result, after, options.terminalOnly);
            if (boundary) return boundary;
            return options.signal?.aborted
                ? { ...result, interrupted: true }
                : { ...result, state: 'timeout' };
        } finally {
            if (timer !== undefined) clearTimeout(timer);
            options.signal?.removeEventListener('abort', stop);
            controller.abort();
        }
    }

    private async settledSnapshot(
        view: RunObservation,
        run: StoredRun
    ): Promise<RunSnapshot> {
        // A worker can finish while an observer consumes an older event batch.
        // Drain the durable tail before exposing a terminal boundary.
        if (RunStore.isTerminal(run.status))
            for (const event of await this.store.readEvents(run.id))
                if (event.sequence > view.sequence) view.apply(event);
        return view.snapshot(run);
    }
}

class RunObservation {
    sequence = 0;
    private active = false;
    private ready = false;
    private boundary = 0;
    private answer = '';
    private answerId = '';
    private usage: Record<string, unknown> = {};
    private outcomeId: string | undefined;
    private error: string | undefined;
    private readonly pending = new Map<string, PendingRunRequest>();
    private readonly queued = new Set<string>();
    private readonly completedTurns: RunSnapshot[] = [];

    constructor(private readonly initial: StoredRun) {}

    apply(event: WorkbenchEvent): void {
        this.sequence = event.sequence;
        const data = event.data as Record<string, unknown>;
        const id = text(data.id);
        if (event.type === 'run.ready') {
            this.ready = true;
            this.boundary = event.sequence;
        }
        if (event.type === 'turn.started') {
            this.active = true;
            this.answer = '';
            this.answerId = '';
            this.usage = {};
        }
        if (event.type === 'turn.completed') {
            this.active = false;
            this.boundary = event.sequence;
            this.pending.clear();
            if (data.reason !== 'cancelled') {
                this.completedTurns.push({
                    ...this.snapshot(this.initial, false),
                    state: 'turn_completed',
                    usage: { ...this.usage },
                });
            }
        }
        if (event.type === 'output.text') {
            if (id && id !== this.answerId) {
                this.answer = '';
                this.answerId = id;
            }
            this.answer += text(data.text);
        }
        if (event.type === 'usage.updated') {
            for (const [key, value] of Object.entries(data)) {
                this.usage[key] =
                    data.kind === 'delta' && typeof value === 'number'
                        ? Number(this.usage[key] ?? 0) + value
                        : value;
            }
        }
        if (typeof data.outcome_id === 'string') this.outcomeId = data.outcome_id;
        if (event.type === 'run.failed') this.error = text(data.message);
        if (event.type === 'input.queued') this.queued.add(id);
        if (event.type === 'input.delivered' || event.type === 'input.rejected')
            this.queued.delete(id);
        if (
            event.type === 'input.delivered' &&
            (data.kind === 'send' || data.kind === 'follow_up')
        )
            this.active = true;
        if (event.type === 'input.requested' || event.type === 'question.requested') {
            this.pending.set(id, {
                id,
                kind: event.type === 'question.requested' ? 'question' : 'permission',
                sequence: event.sequence,
                details: data,
            });
        }
        if (event.type === 'input.accepted' && data.kind === 'permission')
            this.pending.delete(id);
        if (event.type === 'question.answered' || event.type === 'question.rejected')
            this.pending.delete(id);
        if (event.type === 'authentication.requested') {
            const key = `authentication:${text(data.provider)}`;
            this.pending.set(key, {
                id: key,
                kind: 'authentication',
                sequence: event.sequence,
                details: data,
            });
        }
        if (event.type === 'authentication.completed')
            this.pending.delete(`authentication:${text(data.provider)}`);
    }

    snapshot(run: StoredRun, useStoredOutcome = true): RunSnapshot {
        const terminal = RunStore.isTerminal(run.status);
        const pending = terminal ? [] : [...this.pending.values()];
        const state: SupervisionState = terminal
            ? (run.status as 'completed' | 'failed' | 'cancelled')
            : pending.length
              ? 'needs_input'
              : this.active || this.queued.size
                ? 'running'
                : this.ready
                  ? 'idle'
                  : 'starting';
        const outcomeId =
            this.outcomeId ?? (useStoredOutcome ? run.outcome_id : undefined);
        return {
            session_id: run.session_id ?? this.initial.session_id ?? run.id,
            run_id: run.id,
            state,
            sequence: this.sequence,
            final: this.answer.trimEnd(),
            usage: this.usage,
            ...(outcomeId ? { outcome_id: outcomeId } : {}),
            ...(this.error ? { error: this.error } : {}),
            pending_requests: pending,
        };
    }

    boundarySnapshot(
        result: RunSnapshot,
        after: number,
        terminalOnly = false
    ): RunSnapshot | undefined {
        if (result.state === 'failed' || result.state === 'cancelled') return result;
        const turn = terminalOnly
            ? undefined
            : this.completedTurns.find((turn) => turn.sequence > after);
        if (turn) {
            // Only the last turn can describe the execution's current idle/terminal state.
            if (
                turn === this.completedTurns.at(-1) &&
                !this.active &&
                !this.queued.size
            ) {
                if (result.state === 'completed') return result;
                if (result.state === 'idle' && this.initial.mode === 'interactive')
                    return { ...turn, state: 'idle' };
            }
            return turn;
        }
        if (result.state === 'needs_input' || result.state === 'completed')
            return result;
        return !terminalOnly &&
            result.state === 'idle' &&
            this.initial.mode === 'interactive' &&
            this.boundary > after
            ? result
            : undefined;
    }
}

function text(value: unknown): string {
    return typeof value === 'string' ? value : '';
}
