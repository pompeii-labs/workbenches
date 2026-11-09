import type { requirementsOf } from '../../workbench/runtimes.js';
import type { E2BTemplateResources } from './contracts.js';

/**
 * Template resources for a Workbench's requirements. E2B sizes a sandbox from
 * its template, so `cpu` and `memory_gb` are applied when the template is
 * built. E2B allocates an even number of MiB, so memory rounds up to one.
 * An undeclared value is left to E2B's own default.
 */
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
