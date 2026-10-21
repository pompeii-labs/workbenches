import type { requirementsOf } from '../../workbench/runtimes.js';
import type { DaytonaResources } from './contracts.js';

/**
 * What a sandbox gets for a requirement the Workbench does not declare. Daytona's
 * own default of 1 vCPU and 1 GiB is too small for a runner server plus tools. A
 * declared value always wins, including a smaller one.
 */
const daytonaDefaultResources = { cpu: 2, memoryGb: 4 } as const;

/** Sandbox resources for a Workbench's requirements. Daytona allocates whole units. */
export function daytonaResources(
    requirements: ReturnType<typeof requirementsOf>
): DaytonaResources {
    return {
        cpu: requirements.cpu ?? daytonaDefaultResources.cpu,
        memoryGb:
            requirements.memory_gb === undefined
                ? daytonaDefaultResources.memoryGb
                : Math.ceil(requirements.memory_gb),
        ...(requirements.disk_gb === undefined
            ? {}
            : { diskGb: Math.ceil(requirements.disk_gb) }),
    };
}
