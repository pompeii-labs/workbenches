import { ProcessTree } from '../processes/tree.js';
import { DockerRunContainers } from '../runtimes/docker/liveness.js';
import { WORKBENCH_EVENT_PROTOCOL } from './events.js';
import { RunStore, type StoredRun } from './store.js';

/** The fallback when a run's worker can no longer acknowledge control. */
export class RunTermination {
    constructor(
        private readonly runs: Pick<
            RunStore,
            'read' | 'update' | 'lastEvent' | 'appendEvent'
        >,
        private readonly processes: Pick<ProcessTree, 'stop'> = new ProcessTree(),
        private readonly containers: Pick<
            DockerRunContainers,
            'remove'
        > = new DockerRunContainers()
    ) {}

    async stop(
        id: string,
        state: 'failed' | 'cancelled',
        reason?: string
    ): Promise<void> {
        const run = await this.runs.read(id);
        if (RunStore.isTerminal(run.status)) return;
        if (run.pid) this.processes.stop(run.pid);
        if (run.runtime === 'docker')
            await this.containers.remove(run.id).catch(() => {});
        const current = await this.runs.read(id);
        if (RunStore.isTerminal(current.status)) return;
        const last = await this.runs.lastEvent(id);
        if (
            last &&
            (last.type === 'run.completed' ||
                last.type === 'run.failed' ||
                last.type === 'run.cancelled')
        ) {
            const status =
                last.type === 'run.completed'
                    ? 'completed'
                    : last.type === 'run.failed'
                      ? 'failed'
                      : 'cancelled';
            await this.runs.update(id, {
                status,
                exit_code: status === 'completed' ? 0 : status === 'failed' ? 1 : 130,
                finished_at: last.timestamp,
            });
            return;
        }
        await this.record(current, state, reason);
    }

    private async record(
        run: StoredRun,
        state: 'failed' | 'cancelled',
        reason?: string
    ): Promise<void> {
        const timestamp = new Date().toISOString();
        await this.runs.appendEvent(run.id, {
            protocol: WORKBENCH_EVENT_PROTOCOL,
            run_id: run.id,
            sequence: ((await this.runs.lastEvent(run.id))?.sequence ?? 0) + 1,
            timestamp,
            type: state === 'failed' ? 'run.failed' : 'run.cancelled',
            runner: run.runner,
            data: reason ? { message: reason } : {},
        });
        await this.runs.update(run.id, {
            status: state,
            exit_code: state === 'failed' ? 1 : 130,
            finished_at: timestamp,
        });
    }
}
