import type { WorkbenchEvent } from '../runs/events.js';
import { RunStore, type StoredRun } from '../runs/store.js';
import type { SessionStore } from '../sessions/store.js';

interface TrackedRun {
    id: string;
    /** The highest sequence the run has produced so far. */
    last: number;
    terminal: boolean;
}

/** Sessions kept in memory; older ones are read again from the store when asked. */
const TRACKED_SESSIONS = 256;

/**
 * Follows the engine runs of worker sessions without rescanning the store.
 * Each session's runs are found once by walking back from its latest run,
 * and after that only a new latest run, the last sequence of an unfinished
 * run, and events past a cursor are read.
 */
export class WorkerSessionRuns {
    /** In least recently used order, bounded. */
    readonly #sessions = new Map<string, TrackedRun[]>();

    constructor(
        private readonly stores: {
            runs: Pick<RunStore, 'read' | 'readEventsAfter' | 'lastEvent'>;
            sessions: Pick<SessionStore, 'read'>;
        }
    ) {}

    /** The session's engine run ids in the order they were dispatched. */
    async ids(session: string): Promise<string[]> {
        return (await this.#refresh(session)).map((run) => run.id);
    }

    /** The session's latest engine run, or undefined when it has none. */
    async latest(session: string): Promise<StoredRun | undefined> {
        const latest = (await this.#refresh(session)).at(-1);
        return latest ? this.stores.runs.read(latest.id) : undefined;
    }

    /**
     * The session's events after `after`, numbered consecutively across its
     * runs: each run's sequences continue after the last of the run before.
     */
    async events(session: string, after: number): Promise<WorkbenchEvent[]> {
        const numbered: WorkbenchEvent[] = [];
        let offset = 0;
        for (const run of await this.#refresh(session)) {
            if (offset + run.last > after) {
                const events = await this.stores.runs.readEventsAfter(
                    run.id,
                    Math.max(0, after - offset)
                );
                for (const event of events)
                    numbered.push({ ...event, sequence: offset + event.sequence });
            }
            offset += run.last;
        }
        return numbered;
    }

    async #refresh(session: string): Promise<TrackedRun[]> {
        const known = this.#sessions.get(session) ?? [];
        this.#sessions.delete(session);
        const latest = await this.stores.sessions
            .read(session)
            .then((stored) => stored.latest_run_id)
            .catch(() => session);
        const added: TrackedRun[] = [];
        let next: string | undefined = latest;
        while (next && !known.some((run) => run.id === next)) {
            const run: StoredRun | undefined = await this.stores.runs
                .read(next)
                .catch(() => undefined);
            if (!run) break;
            added.unshift({ id: run.id, last: 0, terminal: false });
            next = run.resumed_from;
        }
        const runs = [...known, ...added];
        for (const run of runs) {
            if (run.terminal) continue;
            const stored = await this.stores.runs.read(run.id);
            // Read the status first: a run that ended has written its last event.
            run.terminal = RunStore.isTerminal(stored.status);
            run.last = (await this.stores.runs.lastEvent(run.id))?.sequence ?? 0;
        }
        this.#sessions.set(session, runs);
        if (this.#sessions.size > TRACKED_SESSIONS) {
            const oldest = this.#sessions.keys().next().value;
            if (oldest !== undefined) this.#sessions.delete(oldest);
        }
        return runs;
    }
}
