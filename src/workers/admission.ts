import type { WorkerAssignment, WorkerAssignments } from './assignments.js';
import { WorkerRejection, type WorkerRunHost } from './contracts.js';
import type { WorkerHome, WorkerSettings } from './home.js';
import { excerpt, type WorkerLog } from './log.js';
import type { RunStart, WorkerMessage } from './protocol.js';

export interface WorkerRunAdmissionOptions {
    assignments: WorkerAssignments;
    host: Pick<WorkerRunHost, 'admit' | 'launch' | 'release'>;
    home: Pick<WorkerHome, 'readMember'>;
    settings: WorkerSettings;
    log: WorkerLog;
    now: () => Date;
    send: (message: WorkerMessage) => boolean;
    /** Whether the daemon is stopping, which takes no new runs. */
    stopping: () => boolean;
    /** Why this machine cannot take repository runs, which it then refuses. */
    repositoryRefusal?: string;
    /** Called whenever an accepted run changes. */
    changed: () => void;
}

/**
 * Takes `run.start` messages: refuses what this worker cannot run, admits
 * the package, records the assignment, and launches it. A start repeated
 * while the first is still being admitted is ignored, and a start for a run
 * already accepted is answered again, so a run is never launched twice.
 */
export class WorkerRunAdmission {
    /** Runs between run.start and their assignment, so slots count them. */
    readonly #admitting = new Set<string>();
    readonly #launching = new Map<
        string,
        {
            controller: AbortController;
            step: string;
            done: Promise<void>;
            cancelled: boolean;
        }
    >();

    constructor(private readonly options: WorkerRunAdmissionOptions) {}

    /** How many starts are still being admitted. */
    get pending(): number {
        return this.#admitting.size;
    }

    async cancel(runId: string, reason?: string): Promise<void> {
        const launch = this.#launching.get(runId);
        if (!launch) {
            const assignment = this.options.assignments.get(runId);
            if (assignment?.state !== 'launching' || assignment.session_id) return;
            await this.#finish(
                assignment,
                reason === undefined ? 'cancelled' : 'failed',
                reason ?? 'The run was cancelled'
            );
            await this.options.assignments.save();
            this.options.changed();
            return;
        }
        if (launch.controller.signal.aborted) return launch.done;
        launch.cancelled = reason === undefined;
        launch.controller.abort(new Error(reason ?? 'The run was cancelled'));
        await launch.done;
    }

    async expire(assignment: WorkerAssignment): Promise<void> {
        const launch = this.#launching.get(assignment.run_id);
        await this.cancel(
            assignment.run_id,
            `The run did not start within ${assignment.max_minutes} minutes. It was ${launch?.step ?? 'starting the session'}.`
        );
    }

    async start(start: RunStart): Promise<void> {
        if (this.#admitting.has(start.run_id)) return;
        const { assignments, host, log } = this.options;
        if (assignments.get(start.run_id)) {
            // A repeated start after a reconnect is answered the same way again.
            this.options.send({ type: 'run.accepted', run_id: start.run_id });
            return;
        }
        const reason = this.#refusal(start);
        if (reason) {
            this.#reject(start, reason);
            return;
        }
        this.#admitting.add(start.run_id);
        let assignment: WorkerAssignment;
        try {
            const admission = await host.admit(start);
            assignment = {
                run_id: start.run_id,
                session_id: null,
                workbench: admission.workbench,
                ...(admission.package ? { package: admission.package } : {}),
                runner: admission.runner,
                runtime: start.runtime === 'local' ? 'local' : 'docker',
                member_id: start.started_by.member_id,
                connection: start.connection,
                started_by: await this.#memberName(start.started_by.member_id),
                task: excerpt(start.task, 60),
                accepted_at: this.options.now().toISOString(),
                max_minutes: start.max_minutes,
                state: 'launching',
                observed: 0,
                uploaded: [],
            };
        } catch (error) {
            this.#admitting.delete(start.run_id);
            this.#reject(
                start,
                error instanceof WorkerRejection || error instanceof Error
                    ? error.message
                    : 'The run could not be admitted'
            );
            return;
        }
        assignments.add(assignment, start);
        this.#admitting.delete(start.run_id);
        const completion = Promise.withResolvers<void>();
        const launch = {
            controller: new AbortController(),
            step: 'preparing the launch',
            done: completion.promise,
            cancelled: false,
        };
        this.#launching.set(start.run_id, launch);
        try {
            await assignments.save();
            this.options.send({ type: 'run.accepted', run_id: start.run_id });
            const signal = launch.controller.signal;
            signal.throwIfAborted();
            const aborted = new Promise<never>((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason), {
                    once: true,
                });
            });
            assignment.session_id = await Promise.race([
                host.launch(start, {
                    signal,
                    step: (step) => {
                        launch.step = step;
                    },
                }),
                aborted,
            ]);
            signal.throwIfAborted();
            assignment.state = 'running';
            log.write(
                `${assignment.workbench} started  ${assignment.run_id}${assignment.started_by ? `  by ${assignment.started_by}` : ''}  "${assignment.task}"`
            );
        } catch (error) {
            launch.controller.abort(error);
            await this.#finish(
                assignment,
                launch.cancelled ? 'cancelled' : 'failed',
                error instanceof Error ? error.message : 'The run could not start'
            );
        }
        try {
            await assignments.save();
        } finally {
            this.#launching.delete(start.run_id);
            completion.resolve();
            this.options.changed();
        }
    }

    async #finish(
        assignment: WorkerAssignment,
        state: 'failed' | 'cancelled',
        reason: string
    ): Promise<void> {
        assignment.state = state;
        assignment.failure = reason;
        assignment.finished_at = this.options.now().toISOString();
        await this.options.host.release(assignment.run_id).catch(() => {});
        this.options.log.write(
            `${assignment.workbench} ${state === 'failed' ? 'failed to start' : 'cancelled during launch'}  ${excerpt(reason, 80)}`
        );
    }

    #refusal(start: RunStart): string | undefined {
        if (this.options.stopping()) return 'The worker is stopping';
        const { settings } = this.options;
        const offered = settings.runtimes;
        if (!offered.some((runtime) => runtime === start.runtime))
            return `This worker does not offer the ${start.runtime} runtime. It offers ${offered.join(', ')}`;
        if (start.runtime === 'local' && start.image_pull)
            return 'An image pull applies only to the docker runtime';
        if (start.workspace && this.options.repositoryRefusal)
            return this.options.repositoryRefusal;
        const used = this.options.assignments.active().length + this.#admitting.size;
        if (used >= settings.slots) return `All ${settings.slots} slots are busy`;
        return undefined;
    }

    #reject(start: RunStart, reason: string): void {
        this.options.send({ type: 'run.rejected', run_id: start.run_id, reason });
        this.options.log.write(`rejected a run  ${excerpt(reason, 80)}`);
    }

    /** The member's name from a sign-in on this machine, or null when it is not known. */
    async #memberName(memberId: string | null): Promise<string | null> {
        if (!memberId) return null;
        const member = await this.options.home
            .readMember(memberId)
            .catch(() => undefined);
        return member?.name ?? null;
    }
}
