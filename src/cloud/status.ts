import { RunFold } from '../runs/fold.js';
import type { RunStatus } from '../runs/status.js';
import type { CloudClient } from './client.js';
import { type CloudRun, standardEvent, terminal } from './contracts.js';

/** Folds documented cloud events into the same progress summary as local runs. */
export class CloudStatusReader {
    constructor(
        private readonly client: Pick<CloudClient, 'list' | 'events'>,
        private readonly clock: () => number = Date.now
    ) {}

    async list(options: { recentMs: number }): Promise<RunStatus[]> {
        const runs: RunStatus[] = [];
        for await (const run of this.client.list(['needs_input', 'active']))
            runs.push(await this.status(run));
        // The API cannot filter by finish time, so only the newest page of
        // finished runs is read instead of the organization's whole history.
        let read = 0;
        for await (const run of this.client.list(['finished'])) {
            if (
                run.completed_at &&
                this.clock() - Date.parse(run.completed_at) < options.recentMs
            )
                runs.push(await this.status(run));
            if (++read === 100) break;
        }
        return runs;
    }

    private async status(run: CloudRun): Promise<RunStatus> {
        const fold = RunFold.empty();
        let after = 0;
        let length: number;
        do {
            const page = await this.client.events(run.id, after);
            for (const event of page) {
                if (standardEvent(event)) fold.apply(event);
                after = event.sequence;
            }
            length = page.length;
        } while (length === 500);
        const { pending, open_tools: _tools, terminal: ended, ...state } = fold.state;
        return {
            run_id: run.id,
            workbench: `${run.workbench.organization_slug}/${run.workbench.slug}`,
            workbench_version: run.version.version,
            status:
                ended ??
                (terminal(run.status)
                    ? run.status
                    : ['queued', 'provisioning', 'starting'].includes(run.status)
                      ? 'dispatched'
                      : 'running'),
            dispatched_at: run.created_at,
            ...(run.started_at ? { started_at: run.started_at } : {}),
            ...(run.completed_at ? { finished_at: run.completed_at } : {}),
            ...state,
            cost_usd: run.usage?.cost_usd ?? state.cost_usd,
            pending_input: Object.values(pending).at(-1) ?? null,
        };
    }
}
