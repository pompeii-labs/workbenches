import type { AuthoringJob, AuthoringJobRecord } from '../authoring/job.js';
import type { RunStore, StoredRun } from '../runs/store.js';
import type { RunSnapshot, RunSupervision } from '../runs/supervision.js';
import type { SessionStore } from './store.js';

export interface SessionSnapshot extends RunSnapshot {
    run_state?: RunSnapshot['state'];
    authoring?: AuthoringJobRecord;
}

export class SessionSupervision {
    constructor(
        private readonly runs: Pick<RunStore, 'read'>,
        private readonly sessions: Pick<SessionStore, 'read'>,
        private readonly jobs: Pick<AuthoringJob, 'forRun' | 'wait'>,
        private readonly supervision: Pick<RunSupervision, 'wait'>
    ) {}

    async resolve(
        id: string,
        options: { exactRun?: boolean } = {}
    ): Promise<StoredRun> {
        if (options.exactRun) return this.runs.read(id);
        // The session and its first run share an ID. Only a direct session
        // lookup follows the latest execution; linked run IDs remain exact.
        const session = await this.sessions.read(id).catch(() => undefined);
        return this.runs.read(session?.latest_run_id ?? id);
    }

    async wait(
        run: StoredRun,
        options: {
            afterSequence?: number;
            timeoutMilliseconds?: number;
            signal?: AbortSignal;
        } = {}
    ): Promise<SessionSnapshot> {
        const started = performance.now();
        let authoring = await this.jobs.forRun(run.id);
        const result = await this.supervision.wait(run, {
            ...options,
            // Authoring's result includes post-execution package verification.
            terminalOnly:
                authoring !== undefined ||
                (run.repository?.delivery === 'pr' && run.mode !== 'interactive'),
        });
        if (!authoring) return result;
        if (result.state === 'completed' && !result.interrupted) {
            authoring = await this.jobs.wait(authoring, {
                ...(options.timeoutMilliseconds !== undefined
                    ? {
                          timeoutMilliseconds: Math.max(
                              0,
                              options.timeoutMilliseconds -
                                  (performance.now() - started)
                          ),
                      }
                    : {}),
                ...(options.signal ? { signal: options.signal } : {}),
            });
            if (options.signal?.aborted)
                return { ...result, authoring, interrupted: true };
            if (authoring.status === 'running')
                return {
                    ...result,
                    authoring,
                    run_state: result.state,
                    state: 'timeout',
                };
            if (authoring.status === 'failed')
                return {
                    ...result,
                    authoring,
                    run_state: result.state,
                    state: 'failed',
                    ...(authoring.result?.error
                        ? { error: authoring.result.error }
                        : {}),
                };
        }
        return { ...result, authoring };
    }
}
