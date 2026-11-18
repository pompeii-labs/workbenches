import type { RunStore, StoredRun } from '../runs/store.js';
import type { RunSnapshot, RunSupervision } from '../runs/supervision.js';
import type { SessionStore } from './store.js';

export type SessionSnapshot = RunSnapshot;

export class SessionSupervision {
    constructor(
        private readonly runs: Pick<RunStore, 'read'>,
        private readonly sessions: Pick<SessionStore, 'read'>,
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
        return this.supervision.wait(run, {
            ...options,
            terminalOnly:
                run.repository?.delivery === 'pr' && run.mode !== 'interactive',
        });
    }
}
