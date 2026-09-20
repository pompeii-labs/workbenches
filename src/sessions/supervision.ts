import { AuthoringJob, type AuthoringJobRecord } from '../authoring/job.js';
import { RunStore, type StoredRun } from '../runs/store.js';
import { type RunSnapshot, RunSupervision } from '../runs/supervision.js';
import { SessionStore } from './store.js';

export interface SessionSnapshot extends RunSnapshot {
    run_state?: RunSnapshot['state'];
    authoring?: AuthoringJobRecord;
}

export class SessionSupervision {
    constructor(private readonly home: string) {}

    async resolve(
        id: string,
        options: { exactRun?: boolean } = {}
    ): Promise<StoredRun> {
        const runs = new RunStore(this.home);
        if (options.exactRun) return runs.read(id);
        // The session and its first run share an ID. Only a direct session
        // lookup follows the latest execution; linked run IDs remain exact.
        const session = await new SessionStore(this.home)
            .read(id)
            .catch(() => undefined);
        return runs.read(session?.latest_run_id ?? id);
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
        const jobs = new AuthoringJob(this.home);
        let authoring = await jobs.forRun(run.id);
        const result = await new RunSupervision(this.home).wait(run, {
            ...options,
            // Authoring's result includes post-execution package verification.
            terminalOnly:
                authoring !== undefined ||
                (run.repository?.delivery === 'pr' && run.mode !== 'interactive'),
        });
        if (!authoring) return result;
        if (result.state === 'completed' && !result.interrupted) {
            authoring = await jobs.wait(authoring, {
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
