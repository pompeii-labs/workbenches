import type { WorkbenchEvent } from '../runs/events.js';
import type { WorkerRunAdmission } from './admission.js';
import { type WorkerAssignment, WorkerAssignments } from './assignments.js';
import type { WorkerRunHost } from './contracts.js';
import { duration, excerpt, type WorkerLog } from './log.js';
import type { WorkerOutcomeData } from './outcome.js';

export interface WorkerUploader {
    uploadOutcome(
        runId: string,
        runToken: string,
        outcome: WorkerOutcomeData,
        credentials: string[],
        report: (message: string) => void
    ): Promise<void>;
}

/** How many passes a finished run continued with send is followed before it must show new events. */
const WAKE_PASSES = 3;
/** How often a running Docker run's container is looked for. */
const CONTAINER_CHECK_MS = 15_000;
/** How long a running Docker run's container may be absent before the run fails. */
const CONTAINER_GONE_MS = 60_000;

/**
 * Follows each accepted run's session: its state for slots and status, its
 * lifecycle log lines, its time limit, and its outcome uploads. It reads the
 * same events the stream sends, but independently of the connection, so the
 * log and uploads keep going while the worker is offline. Only unfinished
 * runs are followed, and a finished one again after a command continues it.
 */
export class WorkerRunTracker {
    /** Finished runs a command may have continued, with the passes left to show it. */
    readonly #awake = new Map<string, number>();
    /** When each Docker run's container was last looked for. */
    readonly #checked = new Map<string, number>();
    /** Since when each Docker run's container has been absent. */
    readonly #missing = new Map<string, number>();

    constructor(
        private readonly assignments: WorkerAssignments,
        private readonly host: WorkerRunHost,
        private readonly uploader: WorkerUploader,
        private readonly log: WorkerLog,
        private readonly now: () => Date,
        private readonly launches: Pick<WorkerRunAdmission, 'expire' | 'cancel'>
    ) {}

    /** Follows a finished run again, because a command was relayed into its session. */
    wake(runId: string): void {
        this.#awake.set(runId, WAKE_PASSES);
    }

    /** Observes every unfinished run once. True when anything changed. */
    async observe(): Promise<boolean> {
        let changed = false;
        for (const assignment of this.assignments.list()) {
            if (!assignment.session_id) {
                if (
                    assignment.state === 'launching' &&
                    assignment.max_minutes &&
                    this.now().getTime() - Date.parse(assignment.accepted_at) >=
                        assignment.max_minutes * 60_000
                ) {
                    await this.launches.expire(assignment);
                    changed = true;
                }
                continue;
            }
            const finished = WorkerAssignments.isTerminal(assignment.state);
            const passes = this.#awake.get(assignment.run_id);
            if (finished && passes === undefined) continue;
            const events = await this.host
                .events(assignment.session_id, assignment.observed)
                .catch(() => []);
            const consumed = await this.consume(assignment, events);
            changed = consumed || changed;
            if (passes !== undefined) {
                if (consumed || passes <= 1) this.#awake.delete(assignment.run_id);
                else this.#awake.set(assignment.run_id, passes - 1);
            }
            if (!WorkerAssignments.isTerminal(assignment.state)) {
                if (await this.enforceLimit(assignment)) {
                    changed = true;
                    continue;
                }
                const active = await this.host
                    .active(assignment.session_id)
                    .catch(() => true);
                const now = this.now().getTime();
                if (
                    active &&
                    assignment.runtime === 'docker' &&
                    now - (this.#checked.get(assignment.run_id) ?? -Infinity) >=
                        CONTAINER_CHECK_MS
                ) {
                    this.#checked.set(assignment.run_id, now);
                    const exists = await this.host
                        .containerExists(assignment.session_id)
                        .catch(() => undefined);
                    if (exists === true) this.#missing.delete(assignment.run_id);
                    if (exists === false) {
                        const since = this.#missing.get(assignment.run_id) ?? now;
                        this.#missing.set(assignment.run_id, since);
                        if (now - since >= CONTAINER_GONE_MS) {
                            const reason = "The run's container is gone";
                            await this.host.fail(assignment.session_id, reason);
                            assignment.failure = reason;
                            await this.consume(
                                assignment,
                                await this.host.events(
                                    assignment.session_id,
                                    assignment.observed
                                )
                            );
                            if (!WorkerAssignments.isTerminal(assignment.state))
                                await this.finish(assignment, 'failed', reason);
                            changed = true;
                            continue;
                        }
                    }
                }
                if (!active) {
                    // The session ended without a terminal event, for example after a crash.
                    const late = await this.host
                        .events(assignment.session_id, assignment.observed)
                        .catch(() => []);
                    await this.consume(assignment, late);
                    if (!WorkerAssignments.isTerminal(assignment.state)) {
                        await this.finish(assignment, 'failed');
                    }
                    changed = true;
                }
            }
        }
        return changed;
    }

    /** Cancels every unfinished run, for `wb worker stop --now`. */
    async cancelAll(): Promise<void> {
        await Promise.all(
            this.assignments
                .active()
                .map((assignment) =>
                    this.cancel(assignment, `stop-${assignment.run_id}`)
                )
        );
    }

    private async cancel(
        assignment: WorkerAssignment,
        commandId: string
    ): Promise<void> {
        if (!assignment.session_id) {
            await this.launches.cancel(assignment.run_id);
            return;
        }
        await this.host
            .command(
                assignment.session_id,
                {
                    type: 'command',
                    command_id: commandId,
                    run_id: assignment.run_id,
                    kind: 'cancel',
                    payload: {},
                },
                {
                    run: {
                        run_id: assignment.run_id,
                        runtime: assignment.runtime,
                        member_id: assignment.member_id,
                        runner: assignment.runner,
                        connection: assignment.connection,
                    },
                }
            )
            .catch(() => {});
    }

    private async consume(
        assignment: WorkerAssignment,
        events: WorkbenchEvent[]
    ): Promise<boolean> {
        if (events.length === 0) return false;
        for (const event of events) {
            assignment.observed = Math.max(assignment.observed, event.sequence);
            if (
                event.type === 'run.started' &&
                WorkerAssignments.isTerminal(assignment.state)
            ) {
                assignment.state = 'running';
                delete assignment.finished_at;
                this.log.write(
                    `${assignment.workbench} continued  ${assignment.run_id}`
                );
            } else if (event.type === 'run.started' || event.type === 'turn.started') {
                if (assignment.state === 'launching') assignment.state = 'running';
            } else if (
                event.type === 'input.requested' ||
                event.type === 'question.requested'
            ) {
                assignment.state = 'needs_input';
                this.log.write(
                    `${assignment.workbench} needs input  ${request(event)}`
                );
            } else if (
                event.type === 'input.accepted' ||
                event.type === 'input.rejected' ||
                event.type === 'question.answered' ||
                event.type === 'question.rejected'
            ) {
                if (assignment.state === 'needs_input') assignment.state = 'running';
            } else if (event.type === 'run.completed') {
                await this.finish(assignment, 'completed');
            } else if (event.type === 'run.failed') {
                await this.finish(assignment, 'failed', message(event));
            } else if (event.type === 'run.cancelled') {
                await this.finish(assignment, 'cancelled');
            }
        }
        return true;
    }

    private async finish(
        assignment: WorkerAssignment,
        state: 'completed' | 'failed' | 'cancelled',
        reason?: string
    ): Promise<void> {
        this.#checked.delete(assignment.run_id);
        this.#missing.delete(assignment.run_id);
        // The outcome goes up first: the run counts as finished, and its end is
        // sent, only after the server has had the chance to take it.
        const pullRequest = await this.upload(assignment);
        assignment.state = state;
        assignment.finished_at = this.now().toISOString();
        const elapsed = duration(
            this.now().getTime() - Date.parse(assignment.accepted_at)
        );
        await this.host.release(assignment.run_id).catch((error: unknown) => {
            this.log.write(
                `${assignment.workbench} cleanup failed: ${excerpt(error instanceof Error ? error.message : String(error), 80)}`
            );
        });
        const suffix =
            state === 'failed' && reason
                ? `  ${excerpt(reason, 80)}`
                : pullRequest
                  ? `  PR #${pullRequest}`
                  : '';
        this.log.write(`${assignment.workbench} ${state} in ${elapsed}${suffix}`);
    }

    /** Uploads each finished engine run's outcome once. Returns a pull request number it names. */
    private async upload(assignment: WorkerAssignment): Promise<number | undefined> {
        if (!assignment.session_id) return undefined;
        const outcomes = await this.host
            .outcomes(assignment.session_id, assignment.uploaded)
            .catch(() => []);
        const start = this.assignments.start(assignment.run_id);
        let pullRequest: number | undefined;
        for (const outcome of outcomes) {
            pullRequest = outcome.pullRequest ?? pullRequest;
            assignment.uploaded.push(outcome.run);
            if (!start) {
                this.log.write(
                    `${assignment.workbench} outcome not uploaded: the worker restarted during the run`
                );
                continue;
            }
            try {
                await this.uploader.uploadOutcome(
                    assignment.run_id,
                    start.run_token,
                    await outcome.files(),
                    [
                        ...Object.values(start.env),
                        start.run_token,
                        start.workspace?.credential ?? '',
                        start.workspace?.clone?.credential ?? '',
                        start.image_pull?.password ?? '',
                    ],
                    (message) =>
                        this.log.write(
                            `${assignment.workbench} outcome: ${excerpt(message, 80)}`
                        )
                );
            } catch (error) {
                this.log.write(
                    `${assignment.workbench} outcome upload failed: ${excerpt(
                        error instanceof Error ? error.message : String(error),
                        80
                    )}`
                );
            }
        }
        return pullRequest;
    }

    private async enforceLimit(assignment: WorkerAssignment): Promise<boolean> {
        if (!assignment.max_minutes || !assignment.session_id) return false;
        const elapsed = this.now().getTime() - Date.parse(assignment.accepted_at);
        if (elapsed < assignment.max_minutes * 60_000) return false;
        // Cancel once: the limit is cleared so a slow cancellation is not repeated.
        const limit = assignment.max_minutes;
        assignment.max_minutes = null;
        this.log.write(
            `${assignment.workbench} reached its ${limit} minute limit, cancelling`
        );
        await this.cancel(assignment, `limit-${assignment.run_id}`);
        return true;
    }
}

/** `permission: bash "npm install"` or `question: Which database?`, short and on one line. */
function request(event: WorkbenchEvent): string {
    const data = event.data;
    if (typeof data !== 'object' || data === null) return 'input';
    if (event.type === 'question.requested') {
        const questions = Reflect.get(data, 'questions');
        const first = Array.isArray(questions) ? questions[0] : undefined;
        const text =
            typeof first === 'object' && first !== null
                ? Reflect.get(first, 'question')
                : undefined;
        return typeof text === 'string' ? `question: ${excerpt(text)}` : 'question';
    }
    const action = Reflect.get(data, 'action');
    const resources = Reflect.get(data, 'resources');
    const resource = Array.isArray(resources) ? resources[0] : undefined;
    return [
        'permission:',
        typeof action === 'string' ? excerpt(action, 24) : undefined,
        typeof resource === 'string' ? `"${excerpt(resource)}"` : undefined,
    ]
        .filter(Boolean)
        .join(' ');
}

function message(event: WorkbenchEvent): string | undefined {
    const data = event.data;
    if (typeof data !== 'object' || data === null) return undefined;
    const text = Reflect.get(data, 'message');
    return typeof text === 'string' ? text : undefined;
}
