import { arch, cpus, platform, totalmem } from 'node:os';

import { GpuDiscovery, type GpuInventory } from './gpus.js';
import type { RequirementsHost } from './requirements.js';

/** Describes the machine a local or Docker runtime runs on. */
export interface HostDescriber {
    describe(): RequirementsHost;
    /** The machine's GPUs. A describer without it reports none. */
    gpus?(): Promise<GpuInventory>;
}

/**
 * Describes the machine the engine runs on. It reads `node:os` each time
 * `describe` is called, so only a Node compatible host imports this module.
 * Remote runtimes never need it. GPUs are discovered once, when first asked,
 * because discovery runs a command.
 */
export class NodeHost implements HostDescriber {
    #gpus: Promise<GpuInventory> | undefined;

    constructor(
        private readonly discovery: Pick<GpuDiscovery, 'discover'> = new GpuDiscovery()
    ) {}

    describe(): RequirementsHost {
        const systems: Record<string, string> = {
            darwin: 'macos',
            linux: 'linux',
            win32: 'windows',
        };
        return {
            os: systems[platform()] ?? platform(),
            arch: arch(),
            cpus: cpus().length,
            memoryBytes: totalmem(),
        };
    }

    gpus(): Promise<GpuInventory> {
        this.#gpus ??= this.discovery.discover();
        return this.#gpus;
    }
}
