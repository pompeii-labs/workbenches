import { RunStore, type StoredRun } from '../runs/store.js';
import type { ManagedDockerContainer } from '../runtimes/index.js';
import { SessionStore, type StoredSession } from './store.js';

export interface SessionRetentionPolicy {
    before: Date;
    includeResumableSessions?: boolean;
}

export interface CleanupStorageItem {
    id: string;
    bytes: number;
}

export interface SessionRetentionReview {
    before: string;
    includeResumableSessions: boolean;
    sessions: CleanupStorageItem[];
    runs: CleanupStorageItem[];
    containers: ManagedDockerContainer[];
    activeRuns: string[];
    protectedResumableSessions: string[];
    reconciledRuns: string[];
    bytes: number;
}

export interface SessionRetentionResult extends SessionRetentionReview {
    removedSessions: string[];
    removedRuns: string[];
    removedContainers: string[];
    skipped: string[];
    removedBytes: number;
}

export interface SessionRetentionDependencies {
    containers?: ManagedContainerStorage;
}

export interface ManagedContainerStorage {
    list(): Promise<ManagedDockerContainer[]>;
    remove(container: ManagedDockerContainer): Promise<void>;
}

export class SessionRetention {
    readonly #runs: RunStore;
    readonly #sessions: SessionStore;
    readonly #containers: ManagedContainerStorage | undefined;

    constructor(home: string, dependencies: SessionRetentionDependencies = {}) {
        this.#runs = new RunStore(home);
        this.#sessions = new SessionStore(home);
        this.#containers = dependencies.containers;
    }

    async review(policy: SessionRetentionPolicy): Promise<SessionRetentionReview> {
        this.validate(policy);
        const sessions = await this.#sessions.list();
        const originalRuns = await this.#runs.list();
        const runs: StoredRun[] = [];
        const reconciledRuns: string[] = [];
        for (const original of originalRuns) {
            const run = await this.#runs.reconcile(original);
            runs.push(run);
            if (run.status !== original.status) reconciledRuns.push(run.id);
        }

        const sessionsById = new Map(sessions.map((session) => [session.id, session]));
        const runsBySession = this.groupRuns(runs);
        const selectedSessions = sessions.filter((session) =>
            this.sessionEligible(session, runsBySession.get(session.id) ?? [], policy)
        );
        const selectedSessionIds = new Set(
            selectedSessions.map((session) => session.id)
        );
        const selectedRuns = runs.filter((run) => {
            if (!RunStore.isTerminal(run.status)) return false;
            if (run.session_id && selectedSessionIds.has(run.session_id)) return true;
            if (!this.oldEnough(this.runTimestamp(run), policy.before)) return false;
            if (!run.session_id) return true;
            const session = sessionsById.get(run.session_id);
            return !session || session.latest_run_id !== run.id;
        });

        const [sessionItems, runItems, containers] = await Promise.all([
            Promise.all(
                selectedSessions.map(async (session) => ({
                    id: session.id,
                    bytes: await this.#sessions.size(session.id),
                }))
            ),
            Promise.all(
                selectedRuns.map(async (run) => ({
                    id: run.id,
                    bytes: await this.#runs.size(run.id),
                }))
            ),
            this.staleContainers(new Map(runs.map((run) => [run.id, run]))),
        ]);
        return {
            before: policy.before.toISOString(),
            includeResumableSessions: policy.includeResumableSessions ?? false,
            sessions: sessionItems,
            runs: runItems,
            containers,
            activeRuns: runs
                .filter((run) => !RunStore.isTerminal(run.status))
                .map((run) => run.id),
            protectedResumableSessions: sessions
                .filter(
                    (session) =>
                        Boolean(session.native_session_id) &&
                        !(policy.includeResumableSessions ?? false) &&
                        this.oldEnough(
                            this.sessionTimestamp(
                                session,
                                runsBySession.get(session.id) ?? []
                            ),
                            policy.before
                        )
                )
                .map((session) => session.id),
            reconciledRuns,
            bytes: [...sessionItems, ...runItems].reduce(
                (total, item) => total + item.bytes,
                0
            ),
        };
    }

    async apply(policy: SessionRetentionPolicy): Promise<SessionRetentionResult> {
        const review = await this.review(policy);
        const removedSessions: string[] = [];
        const removedRuns: string[] = [];
        const removedContainers: string[] = [];
        const skipped: string[] = [];
        let removedBytes = 0;
        const runBytes = new Map(review.runs.map((run) => [run.id, run.bytes]));
        const sessionBytes = new Map(
            review.sessions.map((session) => [session.id, session.bytes])
        );

        for (const candidate of review.sessions) {
            try {
                await this.#sessions.exclusive(candidate.id, async () => {
                    const session = await this.#sessions
                        .read(candidate.id)
                        .catch(() => undefined);
                    if (!session) {
                        skipped.push(candidate.id);
                        return;
                    }
                    const linked = (await this.#runs.list()).filter(
                        (run) => run.session_id === session.id
                    );
                    const runs = await this.reconcile(linked);
                    if (!this.sessionEligible(session, runs, policy)) {
                        skipped.push(candidate.id);
                        return;
                    }
                    await this.#sessions.remove(session.id);
                    removedSessions.push(session.id);
                    removedBytes += sessionBytes.get(session.id) ?? 0;
                    for (const run of runs) {
                        await this.#runs.removeTerminal(run.id);
                        removedRuns.push(run.id);
                        removedBytes += runBytes.get(run.id) ?? 0;
                    }
                });
            } catch (error) {
                if (await this.#sessions.read(candidate.id).catch(() => undefined)) {
                    throw error;
                }
                skipped.push(candidate.id);
            }
        }

        for (const candidate of review.runs) {
            if (removedRuns.includes(candidate.id)) continue;
            let removed: boolean;
            try {
                removed = await this.removeRun(candidate.id, policy);
            } catch (error) {
                if (await this.#runs.read(candidate.id).catch(() => undefined)) {
                    throw error;
                }
                removed = false;
            }
            if (removed) {
                removedRuns.push(candidate.id);
                removedBytes += candidate.bytes;
            } else {
                skipped.push(candidate.id);
            }
        }

        for (const container of review.containers) {
            if (await this.removeContainer(container)) {
                removedContainers.push(container.id);
            } else {
                skipped.push(container.id);
            }
        }

        return {
            ...review,
            removedSessions,
            removedRuns,
            removedContainers,
            skipped: [...new Set(skipped)],
            removedBytes,
        };
    }

    private async removeRun(
        id: string,
        policy: SessionRetentionPolicy
    ): Promise<boolean> {
        const initial = await this.#runs.read(id).catch(() => undefined);
        if (!initial) return false;
        if (!initial.session_id) return this.removeIfEligible(initial, policy);
        const session = await this.#sessions
            .read(initial.session_id)
            .catch(() => undefined);
        if (!session) return this.removeIfEligible(initial, policy);
        return this.#sessions.exclusive(session.id, async () => {
            const currentSession = await this.#sessions.read(session.id);
            if (currentSession.latest_run_id === id) return false;
            return this.removeIfEligible(await this.#runs.read(id), policy);
        });
    }

    private async removeIfEligible(
        run: StoredRun,
        policy: SessionRetentionPolicy
    ): Promise<boolean> {
        const current = await this.#runs.reconcile(run);
        if (
            !RunStore.isTerminal(current.status) ||
            !this.oldEnough(this.runTimestamp(current), policy.before)
        ) {
            return false;
        }
        await this.#runs.removeTerminal(current.id);
        return true;
    }

    private async removeContainer(container: ManagedDockerContainer): Promise<boolean> {
        if (!this.#containers) return false;
        const run = await this.#runs.read(container.runId).catch(() => undefined);
        if (run && !RunStore.isTerminal((await this.#runs.reconcile(run)).status)) {
            return false;
        }
        await this.#containers.remove(container);
        return true;
    }

    private async staleContainers(
        runs: Map<string, StoredRun>
    ): Promise<ManagedDockerContainer[]> {
        if (!this.#containers) return [];
        return (await this.#containers.list()).filter((container) => {
            const run = runs.get(container.runId);
            return !run || RunStore.isTerminal(run.status);
        });
    }

    private sessionEligible(
        session: StoredSession,
        runs: StoredRun[],
        policy: SessionRetentionPolicy
    ): boolean {
        if (session.native_session_id && !policy.includeResumableSessions) return false;
        if (
            runs.length === 0 ||
            !runs.some((run) => run.id === session.latest_run_id)
        ) {
            return false;
        }
        if (runs.some((run) => !RunStore.isTerminal(run.status))) return false;
        return this.oldEnough(this.sessionTimestamp(session, runs), policy.before);
    }

    private sessionTimestamp(session: StoredSession, runs: StoredRun[]): string {
        return (
            [session.updated_at, ...runs.map((run) => this.runTimestamp(run))]
                .filter((value) => Number.isFinite(Date.parse(value)))
                .toSorted((left, right) => right.localeCompare(left))[0] ??
            session.updated_at
        );
    }

    private runTimestamp(run: StoredRun): string {
        return run.finished_at ?? run.started_at ?? run.dispatched_at;
    }

    private oldEnough(timestamp: string, before: Date): boolean {
        const time = Date.parse(timestamp);
        return Number.isFinite(time) && time <= before.getTime();
    }

    private groupRuns(runs: StoredRun[]): Map<string, StoredRun[]> {
        const grouped = new Map<string, StoredRun[]>();
        for (const run of runs) {
            if (!run.session_id) continue;
            const entries = grouped.get(run.session_id) ?? [];
            entries.push(run);
            grouped.set(run.session_id, entries);
        }
        return grouped;
    }

    private reconcile(runs: StoredRun[]): Promise<StoredRun[]> {
        return Promise.all(runs.map((run) => this.#runs.reconcile(run)));
    }

    private validate(policy: SessionRetentionPolicy): void {
        if (!Number.isFinite(policy.before.getTime())) {
            throw new Error('Retention cutoff must be a valid date');
        }
        if (policy.before.getTime() > Date.now()) {
            throw new Error('Retention cutoff cannot be in the future');
        }
    }
}
