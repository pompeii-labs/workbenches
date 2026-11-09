import type { requirementsOf } from '../../workbench/runtimes.js';
import type { E2BTemplateResources } from './contracts.js';

/** Template size from `cpu` and `memory_gb`; memory rounds up to an even MiB. */
export function e2bResources(
    requirements: ReturnType<typeof requirementsOf>
): E2BTemplateResources {
    const memory =
        requirements.memory_gb === undefined
            ? undefined
            : Math.ceil(requirements.memory_gb * 1_024);
    return {
        ...(requirements.cpu === undefined ? {} : { cpuCount: requirements.cpu }),
        ...(memory === undefined ? {} : { memoryMB: memory + (memory % 2) }),
    };
}
