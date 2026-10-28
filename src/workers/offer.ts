import { WorkerMachineProbe } from './machine.js';
import type { WorkerRuntime } from './protocol.js';

export interface WorkerRuntimeOfferDependencies {
    machine?: Pick<WorkerMachineProbe, 'docker'>;
}

/** The runtimes a worker offers. */
export interface WorkerRuntimes {
    runtimes: WorkerRuntime[];
}

/**
 * Decides what this machine offers of the runtimes a worker is allowed:
 * local always, and docker while Docker is reachable. It never changes the
 * machine to make Docker work.
 */
export class WorkerRuntimeOffer {
    readonly #machine: Pick<WorkerMachineProbe, 'docker'>;

    constructor(dependencies: WorkerRuntimeOfferDependencies = {}) {
        this.#machine = dependencies.machine ?? new WorkerMachineProbe();
    }

    async check(allowed: WorkerRuntime[]): Promise<WorkerRuntimes> {
        const docker = allowed.includes('docker')
            ? Boolean(await this.#machine.docker())
            : false;
        return {
            runtimes: allowed.filter((runtime) => runtime === 'local' || docker),
        };
    }
}
