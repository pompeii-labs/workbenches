import type { Connection } from '../database/connection.js';
import { RunEventStore } from '../database/runs/events.js';
import { RunStatusStore } from '../database/runs/statuses.js';
import type { ProcessProbe } from '../processes/probe.js';
import { RunFold, type RunFoldState } from './fold.js';
import type { RunStore, StoredRun, StoredRunStatus } from './store.js';

/** What the run is doing right now, from its latest activity event. */
export type RunActivity =
    | { kind: 'starting' }
    | { kind: 'thinking' }
    | { kind: 'writing' }
    | { kind: 'tool'; title: string; started_at: string }
    | { kind: 'file'; operation: string; path: string };

export interface RunPlanItem {
    text: string;
    status: string;
}

/**
 * A run folded from its event log: enough for one status line, without
 * re-reading the log. `steps` are tool calls per todo: `current` counts the
 * calls since the in-progress item last changed; `completed` holds one count
 * per item that ended completed.
 */
export interface RunStatus {
    run_id: string;
    workbench: string;
    workbench_version: string;
    /** `lost` is a run recorded as active whose worker process is gone. */
    status: StoredRunStatus | 'lost';
    dispatched_at: string;
    started_at?: string;
    finished_at?: string;
    cost_usd: number;
    last_activity_at?: string;
    activity: RunActivity;
    pending_input: { id: string; kind: string; action?: string } | null;
    plan: { items: RunPlanItem[]; completed: number; total: number } | null;
    steps: { item: string | null; current: number; completed: number[] };
}

const ACTIVE: ReadonlySet<string> = new Set(['dispatched', 'running']);

/**
 * Reads run status for status lines. Each call folds only the events
 * appended since the last call; the fold is cached in the database, so a
 * once-a-second status line stays cheap however long the run gets.
 */
export class RunStatusReader {
    private readonly events: RunEventStore;
    private readonly cache: RunStatusStore;

    constructor(
        private readonly store: Pick<RunStore, 'list'>,
        database: Pick<Connection, 'run' | 'one' | 'all'>,
        private readonly probe: Pick<ProcessProbe, 'alive'>,
        private readonly clock: () => number = Date.now
    ) {
        this.events = new RunEventStore(database);
        this.cache = new RunStatusStore(database);
    }

    /** Active runs, plus runs that finished within `recentMs`, newest first. */
    async list(options: { recentMs: number }): Promise<RunStatus[]> {
        const now = this.clock();
        const runs = (await this.store.list()).filter((run) => {
            if (ACTIVE.has(run.status)) return true;
            const finished = run.finished_at ? Date.parse(run.finished_at) : Number.NaN;
            return now - finished < options.recentMs;
        });
        return Promise.all(runs.map((run) => this.read(run)));
    }

    async read(run: StoredRun): Promise<RunStatus> {
        const fold = await this.fold(run.id);
        // A crashed worker can leave the run recorded as active after the log ended.
        const active = ACTIVE.has(run.status);
        const gone = run.pid !== undefined && !this.probe.alive(run.pid);
        const status =
            (active && fold.terminal) || (active && gone ? 'lost' : run.status);
        const { open_tools: _tools, pending, terminal: _terminal, ...rest } = fold;
        return {
            run_id: run.id,
            workbench: run.workbench,
            workbench_version: run.workbench_version,
            status,
            dispatched_at: run.dispatched_at,
            ...(run.started_at ? { started_at: run.started_at } : {}),
            ...(run.finished_at ? { finished_at: run.finished_at } : {}),
            ...rest,
            pending_input: Object.values(pending).at(-1) ?? null,
        };
    }

    /**
     * Median tool calls per completed todo across this workbench's finished
     * runs, or undefined without history. Each run's fold is cached, so only
     * runs never read before cost a full log read.
     */
    async typicalStep(
        workbench: string,
        exclude?: string
    ): Promise<number | undefined> {
        const counts: number[] = [];
        for (const run of await this.store.list()) {
            if (run.workbench !== workbench || run.id === exclude) continue;
            if (ACTIVE.has(run.status)) continue;
            counts.push(...(await this.fold(run.id)).steps.completed);
        }
        return median(counts);
    }

    private async fold(id: string): Promise<RunFoldState> {
        const cached = this.cache.read(id) ?? { cursor: 0, fold: RunFold.empty() };
        const logged = this.events.after(id, cached.cursor);
        const last = logged.at(-1);
        if (!last) return cached.fold.state;
        for (const entry of logged) cached.fold.apply(entry.event);
        cached.cursor = last.cursor;
        this.cache.write(id, cached);
        return cached.fold.state;
    }
}

export function median(values: number[]): number | undefined {
    if (values.length === 0) return undefined;
    const sorted = values.toSorted((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)];
}
