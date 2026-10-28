import type { WorkbenchEvent } from '../runs/events.js';
import { type WorkerAssignment, WorkerAssignments } from './assignments.js';
import type { WorkerRunHost } from './contracts.js';
import type { RunCursor, WorkerMessage } from './protocol.js';

/** At most this many events go in one `events` message. */
const EVENT_BATCH = 200;

/**
 * Sends each run's events in sequence order and tracks two cursors per run:
 * what this connection has sent and what the server has stored. A new
 * connection starts again from the stored cursor, so every event the server
 * did not acknowledge is sent again (at least once; the server dedupes by run
 * and sequence).
 */
export class WorkerEventStream {
    /** The highest sequence sent on the current connection, per server run. */
    readonly #sent = new Map<string, number>();
    /** The highest sequence the server has stored, per server run. */
    readonly #stored = new Map<string, number>();

    constructor(
        private readonly assignments: WorkerAssignments,
        private readonly host: Pick<WorkerRunHost, 'events'>,
        private readonly send: (message: WorkerMessage) => boolean
    ) {}

    /** The runs `hello` lists: unfinished, or with events the server may not have. */
    cursors(): RunCursor[] {
        return this.assignments
            .list()
            .filter(
                (run) =>
                    !WorkerAssignments.isTerminal(run.state) ||
                    produced(run) > (this.#stored.get(run.run_id) ?? 0)
            )
            .map((run) => ({ run_id: run.run_id, sequence: produced(run) }));
    }

    stored(runId: string, sequence: number): void {
        this.#stored.set(runId, Math.max(this.#stored.get(runId) ?? 0, sequence));
    }

    /**
     * Rewinds every run to what the server reports stored. Resolves how many
     * events sent on the previous connection must be sent again.
     */
    welcome(stored: RunCursor[]): number {
        const previous = new Map(this.#sent);
        this.#sent.clear();
        for (const cursor of stored) this.#stored.set(cursor.run_id, cursor.sequence);
        let resent = 0;
        for (const run of this.assignments.list()) {
            const acknowledged = this.#stored.get(run.run_id) ?? 0;
            this.#sent.set(run.run_id, acknowledged);
            resent += Math.max(
                0,
                (previous.get(run.run_id) ?? acknowledged) - acknowledged
            );
        }
        return resent;
    }

    /** True when the server has stored every event of every run. */
    acknowledged(): boolean {
        return this.assignments
            .list()
            .every((run) => (this.#stored.get(run.run_id) ?? 0) >= produced(run));
    }

    async flush(): Promise<void> {
        await Promise.all(this.assignments.list().map((run) => this.#flushRun(run)));
    }

    async #flushRun(assignment: WorkerAssignment): Promise<void> {
        const sent = this.#sent.get(assignment.run_id) ?? 0;
        if (assignment.failure && !assignment.session_id) {
            if (sent >= 1) return;
            this.#sent.set(assignment.run_id, 1);
            this.#send(assignment, [failure(assignment)]);
            return;
        }
        if (!assignment.session_id) return;
        if (
            sent >= assignment.observed &&
            WorkerAssignments.isTerminal(assignment.state)
        )
            return;
        const events = await this.host
            .events(assignment.session_id, sent)
            .catch(() => []);
        // Another pass may have advanced the cursor meanwhile; send only past it.
        const current = this.#sent.get(assignment.run_id) ?? 0;
        const after = events.filter((event) => event.sequence > current);
        // A run's end is sent only once the worker is done with the run, so its
        // outcome reaches the server while the server still takes uploads.
        const fresh = WorkerAssignments.isTerminal(assignment.state)
            ? after
            : beforeEnd(after);
        const last = fresh.at(-1);
        if (!last) return;
        this.#sent.set(assignment.run_id, last.sequence);
        for (let index = 0; index < fresh.length; index += EVENT_BATCH) {
            this.#send(assignment, fresh.slice(index, index + EVENT_BATCH));
        }
    }

    #send(assignment: WorkerAssignment, events: WorkbenchEvent[]): void {
        this.send({
            type: 'events',
            run_id: assignment.run_id,
            events: events.map((event) => ({ ...event, run_id: assignment.run_id })),
        });
    }
}

/** The events before a run's first terminal event. */
function beforeEnd(events: WorkbenchEvent[]): WorkbenchEvent[] {
    const end = events.findIndex(
        (event) =>
            event.type === 'run.completed' ||
            event.type === 'run.failed' ||
            event.type === 'run.cancelled'
    );
    return end === -1 ? events : events.slice(0, end);
}

/** The highest sequence a run has produced. */
function produced(run: WorkerAssignment): number {
    return run.failure && !run.session_id ? 1 : run.observed;
}

/** The one event a run that never reached a session reports. */
function failure(assignment: WorkerAssignment): WorkbenchEvent {
    return {
        protocol: 0,
        run_id: assignment.run_id,
        sequence: 1,
        timestamp: assignment.finished_at ?? assignment.accepted_at,
        type: 'run.failed',
        runner: assignment.runner,
        data: { message: assignment.failure ?? 'The run could not start' },
    };
}
