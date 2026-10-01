import { arch, cpus, platform, totalmem } from 'node:os';

import type {
    ResolvedWorkbench,
    WorkbenchArch,
    WorkbenchDaytonaClass,
    WorkbenchOs,
} from '../types.js';
import { requirementsOf, selectedRuntime } from './runtimes.js';

export interface RequirementsHost {
    os: WorkbenchOs | string;
    arch: WorkbenchArch | string;
    cpus: number;
    memoryBytes: number;
}

export interface RequirementsReport {
    /** Requirements verified against the environment. */
    checked: string[];
    /** Requirements the runtime enforces itself, for example container limits. */
    applied: string[];
    /** Requirements this engine could not verify for the selected runtime. */
    unchecked: string[];
}

export interface RequirementsCheckOptions {
    /** Accept a GPU requirement on a runtime that cannot verify it. */
    allowUncheckedGpu?: boolean;
}

const bytesPerGibibyte = 1024 ** 3;

const daytonaClassOs: Record<WorkbenchDaytonaClass, WorkbenchOs> = {
    linux: 'linux',
    gpu: 'linux',
    macos: 'macos',
    windows: 'windows',
};

/**
 * Checks what a Workbench requires of its environment against the runtime it
 * selected, before anything is prepared or launched.
 */
export class RequirementsPreflight {
    private readonly host: RequirementsHost;

    constructor(host: RequirementsHost = RequirementsPreflight.currentHost()) {
        this.host = host;
    }

    static currentHost(): RequirementsHost {
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

    check(
        workbench: ResolvedWorkbench,
        options: RequirementsCheckOptions = {}
    ): RequirementsReport {
        const requirements = requirementsOf(workbench.manifest);
        const runtime = selectedRuntime(workbench);
        const report: RequirementsReport = { checked: [], applied: [], unchecked: [] };
        const fail: (message: string) => never = (message) => {
            throw new Error(
                `Workbench ${workbench.manifest.name} cannot run on the ${runtime.name} runtime: ${message}`
            );
        };
        const list = (values: readonly string[]) => values.join(' or ');
        const { os, arch: architectures } = requirements;

        if (runtime.name === 'daytona') {
            const daytonaClass = runtime.class;
            if (!daytonaClass) return fail('the daytona runtime declares no class');
            const provided = daytonaClassOs[daytonaClass];
            if (os && !os.includes(provided)) {
                fail(
                    `the ${daytonaClass} class provides ${provided} but the Workbench requires ${list(os)}`
                );
            }
            if (daytonaClass === 'gpu' && !requirements.gpu) {
                fail('the gpu class requires gpu: true in requirements');
            }
            if (requirements.gpu && daytonaClass !== 'gpu') {
                fail(
                    `requirements.gpu is true but the ${daytonaClass} class has no GPU. Use the gpu class.`
                );
            }
            report.checked.push(`class ${daytonaClass} provides ${provided}`);
            this.pending(requirements, report, 'daytona', ['arch', 'cpu', 'memory']);
            return report;
        }

        if (runtime.name === 'local') {
            if (os) {
                if (!os.includes(this.host.os as WorkbenchOs)) {
                    fail(`requires os ${list(os)} but this host is ${this.host.os}`);
                }
                report.checked.push(`os ${this.host.os}`);
            }
            if (architectures) {
                if (!architectures.includes(this.host.arch as WorkbenchArch)) {
                    fail(
                        `requires arch ${list(architectures)} but this host is ${this.host.arch}`
                    );
                }
                report.checked.push(`arch ${this.host.arch}`);
            }
            if (requirements.cpu !== undefined) {
                if (this.host.cpus < requirements.cpu) {
                    fail(
                        `requires ${requirements.cpu} CPUs but this host has ${this.host.cpus}`
                    );
                }
                report.checked.push(`cpu ${this.host.cpus}`);
            }
            if (requirements.memory_gb !== undefined) {
                const available = nearestGibibytes(this.host.memoryBytes);
                if (available < requirements.memory_gb) {
                    fail(
                        `requires ${requirements.memory_gb} GiB of memory but this host has ${available} GiB`
                    );
                }
                report.checked.push(`memory ${available} GiB`);
            }
            if (requirements.gpu) {
                if (!options.allowUncheckedGpu) {
                    fail(
                        'GPU requirements are not checked on the local runtime. Pass --allow-unchecked-gpu to run anyway.'
                    );
                }
                report.unchecked.push('gpu is not checked on the local runtime');
            }
            if (requirements.disk_gb !== undefined) {
                report.unchecked.push('disk_gb is not checked on the local runtime');
            }
            return report;
        }

        // docker, e2b, and any other Linux container or sandbox provider
        if (os && !os.includes('linux')) {
            fail(
                `requires os ${list(os)} but the ${runtime.name} runtime provides linux`
            );
        }
        if (requirements.gpu) {
            fail(`GPU requirements are not supported on the ${runtime.name} runtime`);
        }
        if (runtime.name === 'docker') {
            if (architectures) {
                if (!architectures.includes(this.host.arch as WorkbenchArch)) {
                    fail(
                        `requires arch ${list(architectures)} but the docker runtime runs on ${this.host.arch}`
                    );
                }
                report.checked.push(`arch ${this.host.arch}`);
            }
            if (requirements.cpu !== undefined) {
                report.applied.push(`cpu limit ${requirements.cpu}`);
            }
            if (requirements.memory_gb !== undefined) {
                report.applied.push(`memory limit ${requirements.memory_gb} GiB`);
            }
            this.pending(requirements, report, 'docker', ['disk']);
        } else {
            this.pending(requirements, report, runtime.name, [
                'arch',
                'cpu',
                'memory',
                'disk',
            ]);
        }
        return report;
    }

    private pending(
        requirements: ReturnType<typeof requirementsOf>,
        report: RequirementsReport,
        runtime: string,
        fields: Array<'arch' | 'cpu' | 'memory' | 'disk'>
    ): void {
        const declared: Record<string, boolean> = {
            arch: requirements.arch !== undefined,
            cpu: requirements.cpu !== undefined,
            memory: requirements.memory_gb !== undefined,
            disk: requirements.disk_gb !== undefined,
        };
        const names: Record<string, string> = {
            arch: 'arch',
            cpu: 'cpu',
            memory: 'memory_gb',
            disk: 'disk_gb',
        };
        for (const field of fields) {
            if (declared[field]) {
                report.unchecked.push(
                    `${names[field]} is not checked on the ${runtime} runtime`
                );
            }
        }
    }
}

/**
 * Throws when a container daemon cannot give a container the declared cpu or
 * memory. The runtime applies both as limits, which fail late with the
 * daemon's own error when the daemon has less.
 */
export function assertDaemonCapacity(
    workbench: ResolvedWorkbench,
    daemon: { cpus: number; memoryBytes: number }
): void {
    const requirements = requirementsOf(workbench.manifest);
    const runtime = selectedRuntime(workbench).name;
    const fail = (message: string): never => {
        throw new Error(
            `Workbench ${workbench.manifest.name} cannot run on the ${runtime} runtime: ${message}`
        );
    };
    if (requirements.cpu !== undefined && daemon.cpus < requirements.cpu) {
        fail(
            `requires ${requirements.cpu} CPUs but the Docker daemon has ${daemon.cpus}`
        );
    }
    if (requirements.memory_gb !== undefined) {
        const available = nearestGibibytes(daemon.memoryBytes);
        if (available < requirements.memory_gb) {
            fail(
                `requires ${requirements.memory_gb} GiB of memory but the Docker daemon has ${available} GiB`
            );
        }
    }
}

/** Hosts report slightly below nominal (a 16 GB Linux host shows about 15.6 GiB). */
function nearestGibibytes(bytes: number): number {
    return Math.round(bytes / bytesPerGibibyte);
}

/** Throws unless the selected runtime can satisfy the Workbench requirements. */
export function assertRequirements(
    workbench: ResolvedWorkbench,
    options: RequirementsCheckOptions = {},
    host?: RequirementsHost
): RequirementsReport {
    return new RequirementsPreflight(host).check(workbench, options);
}
