import { open, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { WorkbenchEvent } from './events.js';
import { RunStore, type StoredRun, type StoredRunStatus } from './store.js';

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

/** Folded event state, cached beside the log with the byte offset it covers. */
interface Fold {
    cost_usd: number;
    last_activity_at?: string;
    activity: RunActivity;
    open_tools: Record<string, { title: string; started_at: string }>;
    pending: Record<string, { id: string; kind: string; action?: string }>;
    plan: RunStatus['plan'];
    steps: RunStatus['steps'];
}

interface Cache {
    version: 1;
    offset: number;
    fold: Fold;
}

const CACHE = 'status-cache.json';
const ACTIVE: ReadonlySet<string> = new Set(['dispatched', 'running']);

/**
 * Reads run status for status lines. Each call folds only the event-log bytes
 * appended since the last call; the fold is cached in the run directory, so a
 * once-a-second status line stays cheap however long the run gets. Old runs
 * need no migration: the first read folds their whole log once.
 */
export class RunStatusReader {
    private readonly store: RunStore;

    constructor(private readonly home: string) {
        this.store = new RunStore(home);
    }

    /** Active runs, plus runs that finished within `recentMs`, newest first. */
    async list(options: { recentMs: number; now?: number }): Promise<RunStatus[]> {
        const now = options.now ?? Date.now();
        const runs = (await this.store.list()).filter((run) => {
            if (ACTIVE.has(run.status)) return true;
            const finished = run.finished_at ? Date.parse(run.finished_at) : Number.NaN;
            return now - finished < options.recentMs;
        });
        return Promise.all(runs.map((run) => this.read(run)));
    }

    async read(run: StoredRun): Promise<RunStatus> {
        const fold = await this.fold(run.id);
        const status =
            ACTIVE.has(run.status) && run.pid !== undefined && !processAlive(run.pid)
                ? 'lost'
                : run.status;
        const { open_tools: _tools, pending, ...rest } = fold;
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

    private async fold(id: string): Promise<Fold> {
        const directory = join(this.home, 'runs', id);
        const cachePath = join(directory, CACHE);
        let cache = await readCache(cachePath);
        const handle = await open(join(directory, 'events.ndjson'), 'r').catch(
            () => null
        );
        if (!handle) return cache?.fold ?? emptyFold();
        try {
            const { size } = await handle.stat();
            // A log shorter than the cached offset was replaced: fold it again.
            if (!cache || size < cache.offset)
                cache = { version: 1, offset: 0, fold: emptyFold() };
            if (size === cache.offset) return cache.fold;
            const buffer = Buffer.alloc(size - cache.offset);
            await handle.read(buffer, 0, buffer.length, cache.offset);
            // Fold complete lines only; a partly written line waits for the next read.
            const end = buffer.lastIndexOf(0x0a) + 1;
            if (end === 0) return cache.fold;
            for (const line of buffer.subarray(0, end).toString('utf8').split('\n')) {
                if (!line) continue;
                try {
                    apply(cache.fold, JSON.parse(line) as WorkbenchEvent);
                } catch {
                    // A malformed line carries no status.
                }
            }
            cache.offset += end;
            await writeCache(cachePath, cache);
            return cache.fold;
        } finally {
            await handle.close();
        }
    }
}

export function median(values: number[]): number | undefined {
    if (values.length === 0) return undefined;
    const sorted = values.toSorted((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)];
}

function emptyFold(): Fold {
    return {
        cost_usd: 0,
        activity: { kind: 'starting' },
        open_tools: {},
        pending: {},
        plan: null,
        steps: { item: null, current: 0, completed: [] },
    };
}

function apply(fold: Fold, event: WorkbenchEvent): void {
    const data = (event.data ?? {}) as Record<string, unknown>;
    const id = typeof data.id === 'string' ? data.id : undefined;
    switch (event.type) {
        case 'usage.updated':
            if (data.kind === 'delta' && typeof data.cost_usd === 'number') {
                fold.cost_usd += data.cost_usd;
            }
            return;
        case 'plan.updated':
            plan(fold, data);
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
                    ...(typeof data.action === 'string' ? { action: data.action } : {}),
                };
            }
            return;
        case 'input.accepted':
        case 'input.rejected':
        case 'question.answered':
        case 'question.rejected':
            if (id) delete fold.pending[id];
            touch(fold, event, { kind: 'thinking' });
            return;
        case 'tool.started': {
            const title =
                typeof data.title === 'string'
                    ? data.title
                    : String(data.name ?? 'tool');
            if (id) fold.open_tools[id] = { title, started_at: event.timestamp };
            if (fold.steps.item !== null) fold.steps.current += 1;
            touch(fold, event, { kind: 'tool', title, started_at: event.timestamp });
            return;
        }
        case 'tool.completed':
            if (id) delete fold.open_tools[id];
            touch(fold, event, latestTool(fold) ?? { kind: 'thinking' });
            return;
        case 'file.changed':
            touch(fold, event, {
                kind: 'file',
                operation: String(data.operation ?? 'edit'),
                path: String(data.path ?? ''),
            });
            return;
        case 'output.text':
            touch(fold, event, { kind: 'writing' });
            return;
        case 'turn.started':
            touch(fold, event, { kind: 'thinking' });
            return;
        default:
            return;
    }
}

function touch(fold: Fold, event: WorkbenchEvent, activity: RunActivity): void {
    fold.last_activity_at = event.timestamp;
    // An open tool outranks text or edits that stream while it runs.
    fold.activity = latestTool(fold) ?? activity;
}

function latestTool(fold: Fold): RunActivity | undefined {
    const open = Object.values(fold.open_tools).at(-1);
    return open ? { kind: 'tool', ...open } : undefined;
}

function plan(fold: Fold, data: Record<string, unknown>): void {
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
    const current = items.find((item) => item.status === 'in_progress')?.text ?? null;
    if (current === fold.steps.item) return;
    const finished = items.some(
        (item) => item.text === fold.steps.item && item.status === 'completed'
    );
    if (finished && fold.steps.current > 0)
        fold.steps.completed.push(fold.steps.current);
    fold.steps.item = current;
    fold.steps.current = 0;
}

async function readCache(path: string): Promise<Cache | undefined> {
    try {
        const cache = JSON.parse(await readFile(path, 'utf8')) as Cache;
        return cache.version === 1 && Number.isSafeInteger(cache.offset)
            ? cache
            : undefined;
    } catch {
        return undefined;
    }
}

/** Atomic replace: concurrent status lines may race, but never read half a file. */
async function writeCache(path: string, cache: Cache): Promise<void> {
    const temporary = `${path}.${process.pid}.tmp`;
    try {
        await writeFile(temporary, JSON.stringify(cache), { mode: 0o600 });
        await rename(temporary, path);
    } catch {
        // A read-only or vanished run directory only costs the cache.
    }
}

function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM does not prove an exit.
        return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
    }
}
