import { RunStore } from '../runs/store.js';
import { RunTermination } from '../runs/termination.js';
import { DockerRunContainers } from '../runtimes/docker/liveness.js';

/** The smoke containers and detached process acquired while a worker launches a run. */
export class WorkerRunResources {
    readonly #launches = new Map<string, { docker: boolean; ids: Set<string> }>();
    readonly #termination: RunTermination;

    constructor(
        runs: ConstructorParameters<typeof RunTermination>[0],
        readonly containers: Pick<
            DockerRunContainers,
            'exists' | 'remove'
        > = new DockerRunContainers()
    ) {
        this.#termination = new RunTermination(runs, undefined, containers);
    }

    begin(runId: string, home: string, runtime: string): { id: string; scope: string } {
        const smoke = { id: RunStore.createId(), scope: RunStore.scope(home) };
        this.#launches.set(runId, {
            docker: runtime === 'docker',
            ids: new Set(runtime === 'docker' ? [smoke.id] : []),
        });
        return smoke;
    }

    prepared(runId: string, id: string): void {
        this.#launches.get(runId)?.ids.add(id);
    }

    stop(id: string, state: 'failed' | 'cancelled', reason?: string): Promise<void> {
        return this.#termination.stop(id, state, reason);
    }

    async release(runId: string): Promise<void> {
        const launch = this.#launches.get(runId);
        this.#launches.delete(runId);
        await Promise.all(
            [...(launch?.ids ?? [])].map(async (id) => {
                await this.#termination.stop(id, 'cancelled').catch(() => {});
                if (launch?.docker) await this.containers.remove(id);
            })
        );
    }
}
