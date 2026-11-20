import { RegistryClient } from '../registry/client.js';
import type { PendingRunRequest, RunSnapshot } from '../runs/supervision.js';
import { type CloudEvent, type CloudRun, terminal } from './contracts.js';

/** Projects the public event sequence without inventing local run metadata. */
export class CloudObservation {
    sequence = 0;
    private answer = '';
    private answerId = '';
    private readonly total: Record<string, number> = {};
    private readonly delta: Record<string, number> = {};
    private step: Record<string, number> = {};
    private readonly pending = new Map<string, PendingRunRequest>();
    private outcome: string | undefined;
    private error: string | undefined;
    private boundary: RunSnapshot | undefined;
    private lastBoundary = 0;
    private ended: 'completed' | 'failed' | 'cancelled' | undefined;

    constructor(
        private readonly run: CloudRun,
        private readonly after: number
    ) {}

    apply(event: CloudEvent): void {
        this.sequence = event.sequence;
        if (event.type === 'run.completed') this.ended = 'completed';
        if (event.type === 'run.failed') this.ended = 'failed';
        if (event.type === 'run.cancelled') this.ended = 'cancelled';
        const data = RegistryClient.isRecord(event.data) ? event.data : {};
        const id = typeof data.id === 'string' ? data.id : '';
        if (event.type === 'turn.started') {
            this.answer = '';
            this.answerId = '';
            this.step = {};
        }
        if (event.type === 'output.text' && typeof data.text === 'string') {
            if (id && id !== this.answerId) {
                this.answer = '';
                this.answerId = id;
            }
            this.answer += data.text;
        }
        if (event.type === 'usage.updated')
            for (const [key, value] of Object.entries(data)) {
                if (typeof value !== 'number' || !Number.isFinite(value)) continue;
                const amount =
                    data.kind === 'delta' ? value : value - (this.step[key] ?? 0);
                this.total[key] = (this.total[key] ?? 0) + amount;
                this.step[key] = (this.step[key] ?? 0) + amount;
                this.delta[key] =
                    (this.delta[key] ?? 0) + (event.sequence > this.after ? amount : 0);
            }
        if (typeof data.outcome_id === 'string') this.outcome = data.outcome_id;
        if (event.type === 'run.failed' && typeof data.message === 'string')
            this.error = data.message;
        if (event.type === 'input.requested' || event.type === 'question.requested')
            this.pending.set(id, {
                id,
                kind: event.type === 'question.requested' ? 'question' : 'permission',
                sequence: event.sequence,
                details: data,
            });
        if (event.type === 'authentication.requested') {
            const key = `authentication:${typeof data.provider === 'string' ? data.provider : ''}`;
            this.pending.set(key, {
                id: key,
                kind: 'authentication',
                sequence: event.sequence,
                details: data,
            });
        }
        if (event.type === 'authentication.completed')
            this.pending.delete(
                `authentication:${typeof data.provider === 'string' ? data.provider : ''}`
            );
        if (
            event.type === 'question.answered' ||
            event.type === 'question.rejected' ||
            ((event.type === 'input.accepted' || event.type === 'input.rejected') &&
                data.kind === 'permission')
        )
            this.pending.delete(id);
        if (event.type === 'turn.completed') {
            this.lastBoundary = event.sequence;
            this.pending.clear();
            if (
                !this.boundary &&
                event.sequence > this.after &&
                data.reason !== 'cancelled'
            )
                this.boundary = { ...this.snapshot(), state: 'turn_completed' };
        }
    }

    snapshot(current: CloudRun = this.run): RunSnapshot {
        const status = this.ended ?? current.status;
        return {
            session_id: current.session_id,
            run_id: current.id,
            state: terminal(status)
                ? status
                : this.pending.size
                  ? 'needs_input'
                  : 'running',
            sequence: this.sequence,
            final: this.answer.trimEnd(),
            usage: { kind: 'delta', ...this.delta },
            usage_total: { kind: 'total', ...this.total },
            pending_requests: terminal(status) ? [] : [...this.pending.values()],
            ...(this.outcome ? { outcome_id: this.outcome } : {}),
            // As locally, only a failure reports an error; a completed run's
            // terminal reason is just "completed".
            ...(status === 'failed' && (this.error || current.terminal_reason)
                ? { error: this.error ?? current.terminal_reason ?? '' }
                : {}),
        };
    }

    settled(current: CloudRun): RunSnapshot | undefined {
        const result = this.snapshot(current);
        if (result.state === 'failed' || result.state === 'cancelled') return result;
        if (
            this.boundary &&
            (result.state !== 'completed' ||
                this.boundary.sequence !== this.lastBoundary)
        )
            return this.boundary;
        if (terminal(result.state) || result.state === 'needs_input') return result;
        return this.boundary;
    }
}
