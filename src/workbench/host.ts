import { arch, cpus, platform, totalmem } from 'node:os';

import type { RequirementsHost } from './requirements.js';

/** Describes the machine a local or Docker runtime runs on. */
export interface HostDescriber {
    describe(): RequirementsHost;
}

/**
 * Describes the machine the engine runs on. It reads `node:os` each time
 * `describe` is called, so only a Node compatible host imports this module.
 * Remote runtimes never need it.
 */
export class NodeHost implements HostDescriber {
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
}
