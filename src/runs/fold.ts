import { RowReader } from '../database/rows.js';
import type { WorkbenchEvent } from './events.js';
import type { RunActivity, RunStatus } from './status.js';
import type { StoredRunStatus } from './store.js';

/** Folded event state, cached in the database with the last event it covers. */
export interface RunFoldState {
    cost_usd: number;
    last_activity_at?: string;
    activity: RunActivity;
    open_tools: Record<string, { title: string; started_at: string }>;
    pending: Record<string, { id: string; kind: string; action?: string }>;
    plan: RunStatus['plan'];
    steps: RunStatus['steps'];
    /** Set by a terminal run event; it outranks a stale run record. */
    terminal?: StoredRunStatus;
}

/** A run's events folded into the state one status line needs. */
export class RunFold {
    private constructor(readonly state: RunFoldState) {}

    static empty(): RunFold {
        return new RunFold({
            cost_usd: 0,
            activity: { kind: 'starting' },
            open_tools: {},
            pending: {},
            plan: null,
            steps: { item: null, current: 0, completed: [] },
        });
    }

    /** Rebuilds a fold from its cached JSON, or undefined when it is not one. */
    static restore(value: unknown): RunFold | undefined {
        return RowReader.isRecord(value) && RowReader.isRecord(value.activity)
            ? new RunFold(value as unknown as RunFoldState)
            : undefined;
    }

    apply(event: WorkbenchEvent): void {
        const fold = this.state;
        const data = (event.data ?? {}) as Record<string, unknown>;
        const id = typeof data.id === 'string' ? data.id : undefined;
        switch (event.type) {
            case 'usage.updated':
                if (data.kind === 'delta' && typeof data.cost_usd === 'number') {
                    fold.cost_usd += data.cost_usd;
                }
                return;
            case 'plan.updated':
                this.plan(data);
                return;
            case 'input.requested':
            case 'question.requested':
                if (id) {
                    fold.pending[id] = {
                        id,
                        kind:
                            event.type === 'question.requested'
                                ? 'question'
                                : String(data.kind ?? 'input'),
                        ...(typeof data.action === 'string'
                            ? { action: data.action }
                            : {}),
                    };
                }
                return;
            case 'input.accepted':
            case 'input.rejected':
            case 'question.answered':
            case 'question.rejected':
                if (id) delete fold.pending[id];
                this.touch(event, { kind: 'thinking' });
                return;
            case 'tool.started': {
                const title =
                    typeof data.title === 'string'
                        ? data.title
                        : String(data.name ?? 'tool');
                if (id) fold.open_tools[id] = { title, started_at: event.timestamp };
                if (fold.steps.item !== null) fold.steps.current += 1;
                this.touch(event, {
                    kind: 'tool',
                    title,
                    started_at: event.timestamp,
                });
                return;
            }
            case 'tool.completed':
                if (id) delete fold.open_tools[id];
                this.touch(event, this.latestTool() ?? { kind: 'thinking' });
                return;
            case 'file.changed':
                this.touch(event, {
                    kind: 'file',
                    operation: String(data.operation ?? 'edit'),
                    path: String(data.path ?? ''),
                });
                return;
            case 'output.text':
                this.touch(event, { kind: 'writing' });
                return;
            case 'turn.started':
                this.touch(event, { kind: 'thinking' });
                return;
            case 'run.completed':
                fold.terminal = 'completed';
                return;
            case 'run.failed':
                fold.terminal = 'failed';
                return;
            case 'run.cancelled':
                fold.terminal = 'cancelled';
                return;
            default:
                return;
        }
    }

    private touch(event: WorkbenchEvent, activity: RunActivity): void {
        this.state.last_activity_at = event.timestamp;
        // An open tool outranks text or edits that stream while it runs.
        this.state.activity = this.latestTool() ?? activity;
    }

    private latestTool(): RunActivity | undefined {
        const open = Object.values(this.state.open_tools).at(-1);
        return open ? { kind: 'tool', ...open } : undefined;
    }

    private plan(data: Record<string, unknown>): void {
        const fold = this.state;
        const items = (Array.isArray(data.items) ? data.items : [])
            .map((item) => item as Record<string, unknown>)
            .filter((item) => typeof item.text === 'string')
            .map((item) => ({
                text: String(item.text),
                status: String(item.status ?? 'pending'),
            }));
        fold.plan = {
            items,
            completed: Number(data.completed ?? 0),
            total: Number(data.total ?? items.length),
        };
        const current =
            items.find((item) => item.status === 'in_progress')?.text ?? null;
        if (current === fold.steps.item) return;
        const finished = items.some(
            (item) => item.text === fold.steps.item && item.status === 'completed'
        );
        if (finished && fold.steps.current > 0)
            fold.steps.completed.push(fold.steps.current);
        fold.steps.item = current;
        fold.steps.current = 0;
    }
}
