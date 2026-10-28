import type { WorkerHome } from './home.js';
import {
    isRecord,
    isWorkerRuntime,
    type RunStart,
    type WorkerRuntime,
} from './protocol.js';

export type WorkerAssignmentState =
    | 'launching'
    | 'running'
    | 'needs_input'
    | 'completed'
    | 'failed'
    | 'cancelled';

/** One accepted run as the worker remembers it across restarts. Nothing here is secret. */
export interface WorkerAssignment {
    run_id: string;
    session_id: string | null;
    workbench: string;
    /** The saved alias of the run's package in the worker home. */
    package?: string;
    runner: string;
    runtime: WorkerRuntime;
    member_id: string | null;
    /** The connection the run was asked to use, which its continuations keep. */
    connection: string | null;
    started_by: string | null;
    task: string;
    accepted_at: string;
    max_minutes: number | null;
    state: WorkerAssignmentState;
    /** The highest session sequence the worker has read and logged. */
    observed: number;
    /** Engine runs of the session whose outcome was uploaded or given up on. */
    uploaded: string[];
    /** Why the run failed before its session could start. */
    failure?: string;
    finished_at?: string;
}

const terminal = new Set<WorkerAssignmentState>(['completed', 'failed', 'cancelled']);

/**
 * The runs this worker accepted. The index on disk holds only non-secret
 * fields; each run's credentials, environment, and run token stay in memory
 * for the life of the daemon process and are never written.
 */
export class WorkerAssignments {
    readonly #runs = new Map<string, WorkerAssignment>();
    readonly #secrets = new Map<string, RunStart>();

    constructor(
        private readonly home: Pick<WorkerHome, 'assignmentsPath' | 'read' | 'write'>
    ) {}

    static isTerminal(state: WorkerAssignmentState): boolean {
        return terminal.has(state);
    }

    async load(): Promise<void> {
        const value = await this.home.read('assignments.json');
        const entries = isRecord(value) && Array.isArray(value.runs) ? value.runs : [];
        for (const entry of entries) {
            const assignment = parseAssignment(entry);
            if (assignment) this.#runs.set(assignment.run_id, assignment);
        }
    }

    async save(): Promise<void> {
        await this.home.write('assignments.json', {
            version: 1,
            runs: [...this.#runs.values()],
        });
    }

    /** Forgets and returns the runs that finished before `horizon`. */
    expire(horizon: Date): WorkerAssignment[] {
        const expired: WorkerAssignment[] = [];
        for (const [id, run] of this.#runs) {
            if (
                WorkerAssignments.isTerminal(run.state) &&
                run.finished_at &&
                Date.parse(run.finished_at) < horizon.getTime()
            ) {
                expired.push(run);
                this.#runs.delete(id);
                this.#secrets.delete(id);
            }
        }
        return expired;
    }

    get(runId: string): WorkerAssignment | undefined {
        return this.#runs.get(runId);
    }

    list(): WorkerAssignment[] {
        return [...this.#runs.values()];
    }

    active(): WorkerAssignment[] {
        return this.list().filter((run) => !WorkerAssignments.isTerminal(run.state));
    }

    add(assignment: WorkerAssignment, start: RunStart): void {
        this.#runs.set(assignment.run_id, assignment);
        this.#secrets.set(assignment.run_id, start);
    }

    /** The run's start message with its credentials, while this process holds them. */
    start(runId: string): RunStart | undefined {
        return this.#secrets.get(runId);
    }
}

function parseAssignment(value: unknown): WorkerAssignment | undefined {
    if (
        !isRecord(value) ||
        typeof value.run_id !== 'string' ||
        typeof value.workbench !== 'string' ||
        typeof value.runtime !== 'string' ||
        !isWorkerRuntime(value.runtime) ||
        typeof value.accepted_at !== 'string' ||
        typeof value.state !== 'string'
    )
        return undefined;
    const states: WorkerAssignmentState[] = [
        'launching',
        'running',
        'needs_input',
        'completed',
        'failed',
        'cancelled',
    ];
    const state = states.find((candidate) => candidate === value.state);
    if (!state) return undefined;
    const text = (entry: unknown) => (typeof entry === 'string' ? entry : null);
    // A launch the daemon never finished cannot be picked up by a new process.
    const abandoned = state === 'launching' && !text(value.session_id);
    const failure = abandoned
        ? 'The worker stopped before the run started'
        : text(value.failure);
    return {
        run_id: value.run_id,
        session_id: text(value.session_id),
        workbench: value.workbench,
        ...(typeof value.package === 'string' ? { package: value.package } : {}),
        runner: typeof value.runner === 'string' ? value.runner : 'unknown',
        runtime: value.runtime,
        member_id: text(value.member_id),
        connection: text(value.connection),
        started_by: text(value.started_by),
        task: typeof value.task === 'string' ? value.task : '',
        accepted_at: value.accepted_at,
        max_minutes: typeof value.max_minutes === 'number' ? value.max_minutes : null,
        state: abandoned ? 'failed' : state,
        observed: typeof value.observed === 'number' ? value.observed : 0,
        uploaded: Array.isArray(value.uploaded)
            ? value.uploaded.filter(
                  (entry): entry is string => typeof entry === 'string'
              )
            : [],
        ...(failure ? { failure } : {}),
        ...(typeof value.finished_at === 'string'
            ? { finished_at: value.finished_at }
            : {}),
    };
}
