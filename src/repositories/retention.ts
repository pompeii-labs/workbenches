import { isDeepStrictEqual } from 'node:util';
import { OutcomeApplier } from '../outcomes/apply.js';
import { OutcomeStore } from '../outcomes/store.js';
import { RunStore } from '../runs/store.js';
import type { RepositoryBinding } from './contracts.js';

/** Recovers saved remote edits before a continuation captures its baseline. */
export class RepositoryRetention {
    constructor(
        private readonly home: string,
        private readonly binding: RepositoryBinding
    ) {}

    async restore(runId: string, directory: string): Promise<void> {
        const runs = new RunStore(this.home);
        const current = await runs.read(runId);
        if (!isDeepStrictEqual(current.repository, this.binding))
            throw new Error('Run repository provenance does not match retained edits');
        const history: string[] = [];
        const seen = new Set([runId]);
        let previous = current.resumed_from;
        while (previous) {
            if (seen.has(previous)) throw new Error('Invalid repository run history');
            seen.add(previous);
            const run = await runs.read(previous);
            if (!isDeepStrictEqual(run.repository, this.binding) || !run.outcome_id)
                throw new Error(
                    'Repository run history has missing results; refusing to lose retained edits'
                );
            history.unshift(run.outcome_id);
            previous = run.resumed_from;
        }
        const store = new OutcomeStore(this.home);
        try {
            for (const id of history) {
                if ((await store.receipt(id)).state !== 'pending') continue;
                await new OutcomeApplier(store).apply(await store.read(id), {
                    primary: directory,
                });
            }
        } finally {
            await store.close();
        }
    }
}
