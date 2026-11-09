import type { requirementsOf } from '../../workbench/runtimes.js';
import type { E2BTemplateResources } from './contracts.js';

/** Template size from `cpu` and `memory_gb`, or undefined when neither is declared. */
export function e2bResources(
    requirements: ReturnType<typeof requirementsOf>
): E2BTemplateResources | undefined {
    const { cpu, memory_gb } = requirements;
    if (cpu === undefined && memory_gb === undefined) return undefined;
    // E2B allocates an even number of MiB.
    const memory = memory_gb === undefined ? undefined : Math.ceil(memory_gb * 1_024);
    return {
        ...(cpu === undefined ? {} : { cpuCount: cpu }),
        ...(memory === undefined ? {} : { memoryMB: memory + (memory % 2) }),
    };
}
