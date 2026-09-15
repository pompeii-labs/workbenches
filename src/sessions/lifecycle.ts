import { RunStore, type StoredRun } from '../runs/store.js';
import { SessionStore, type StoredSession } from './store.js';

export interface SessionActivity {
    id: string;
    run: StoredRun;
    session?: StoredSession;
    resumable: boolean;
}

export class SessionLifecycle {
    readonly #runs: RunStore;
    readonly #sessions: SessionStore;

    constructor(home: string) {
        this.#runs = new RunStore(home);
        this.#sessions = new SessionStore(home);
    }

    async resolve(id: string): Promise<SessionActivity> {
        const session = await this.session(id);
        if (session) return this.#activity(session);

        const run = await this.#runs.read(id).catch(() => undefined);
        if (!run) throw new Error(`Workbench session does not exist: ${id}`);
        return this.#legacy(run, run.session_id);
    }

    async session(id: string): Promise<StoredSession | undefined> {
        const direct = await this.#sessions.read(id).catch(() => undefined);
        if (direct) return direct;
        const run = await this.#runs.read(id).catch(() => undefined);
        if (!run?.session_id) return undefined;
        return this.#sessions.read(run.session_id).catch(() => undefined);
    }

    async latest(): Promise<SessionActivity> {
        const latest = (await this.list({ all: true }))[0];
        if (!latest) throw new Error('No Workbench sessions have been started');
        return latest;
    }

    async latestActive(): Promise<SessionActivity> {
        const latest = (await this.list({ all: true })).find(
            (activity) => !RunStore.isTerminal(activity.run.status)
        );
        if (!latest) throw new Error('No active Workbench sessions');
        return latest;
    }

    async list(options: { all?: boolean } = {}): Promise<SessionActivity[]> {
        const sessions = await this.#sessions.list();
        const sessionIds = new Set(sessions.map((session) => session.id));
        const activities = await Promise.all(
            sessions.map((session) => this.#activity(session).catch(() => undefined))
        );
        const legacy = new Map<string, StoredRun>();
        for (const run of await this.#runs.list()) {
            if (run.session_id && sessionIds.has(run.session_id)) continue;
            const id = run.session_id ?? run.id;
            const current = legacy.get(id);
            if (!current || run.dispatched_at > current.dispatched_at) {
                legacy.set(id, run);
            }
        }
        const legacyRuns = await Promise.all(
            [...legacy].map(([id, run]) => this.#legacy(run, id))
        );

        return [...activities.filter(isActivity), ...legacyRuns]
            .filter(
                (activity) =>
                    options.all ||
                    activity.resumable ||
                    !RunStore.isTerminal(activity.run.status)
            )
            .toSorted((left, right) =>
                right.run.dispatched_at.localeCompare(left.run.dispatched_at)
            );
    }

    async #activity(session: StoredSession): Promise<SessionActivity> {
        return {
            id: session.id,
            session,
            run: await this.#runs.reconcile(
                await this.#runs.read(session.latest_run_id)
            ),
            resumable: Boolean(session.native_session_id),
        };
    }

    async #legacy(run: StoredRun, id = run.id): Promise<SessionActivity> {
        return { id, run: await this.#runs.reconcile(run), resumable: false };
    }
}

function isActivity(
    activity: SessionActivity | undefined
): activity is SessionActivity {
    return activity !== undefined;
}
