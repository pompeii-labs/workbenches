import type { WorkbenchEvent } from '../runs/events.js';
import type { WorkerRunSpec } from './environment.js';
import type { RunStart, WorkerCommand } from './protocol.js';

/** A run the worker will not take, with the reason the server shows. */
export class WorkerRejection extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WorkerRejection';
    }
}

export interface WorkerAdmission {
    workbench: string;
    runner: string;
    /** The saved alias of the run's package, removed once the run expires. */
    package?: string;
}

/** A finished engine run of a session whose outcome can be uploaded. */
export interface WorkerOutcome {
    /** The engine run that produced it. */
    run: string;
    /** The pull request number its links name, for the log. */
    pullRequest?: number;
    archive(): Promise<Uint8Array>;
}

/**
 * The run a command continues. `start` is its original start while this
 * process holds it; after a restart only the saved fields remain, which are
 * enough to rebuild the starting member's environment.
 */
export interface WorkerRunContext {
    run: Pick<WorkerRunSpec, 'run_id' | 'runtime' | 'member_id'> & {
        runner: string;
        connection: string | null;
    };
    start?: RunStart;
}

/**
 * What the worker daemon needs from the engine. The engine implementation
 * runs ordinary detached sessions in the worker home; tests supply a fake.
 */
export interface WorkerRunHost {
    /** Downloads and checks the package. Throws `WorkerRejection` with the reason. */
    admit(start: RunStart): Promise<WorkerAdmission>;
    /** Starts the run as a detached engine session and returns its session id. */
    launch(start: RunStart): Promise<string>;
    /** The session's events after `after`, numbered across all of its runs. */
    events(session: string, after: number): Promise<WorkbenchEvent[]>;
    /** Whether the session's latest run is still executing. */
    active(session: string): Promise<boolean>;
    /** Relays a command into the session's controls; a continuation keeps the run's environment. */
    command(
        session: string,
        command: WorkerCommand,
        context: WorkerRunContext
    ): Promise<void>;
    /** Finished engine runs of the session with an outcome, except `uploaded`. */
    outcomes(session: string, uploaded: string[]): Promise<WorkerOutcome[]>;
    /** Releases what a run held on this machine once it has ended. */
    release(runId: string): Promise<void>;
    /** After a restart, releases what runs no longer active hold, and resumes what the active ones need. */
    recover(
        active: Array<{ run_id: string; runtime: string; session_id: string | null }>
    ): Promise<void>;
}
