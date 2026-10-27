import type {
    ResolvedWorkbench,
    SelectedRuntime,
    WorkbenchArch,
    WorkbenchDaytonaClass,
    WorkbenchOs,
    WorkbenchRequirements,
} from '../types.js';
import type { GpuInventory } from './gpus.js';
import type { HostDescriber } from './host.js';
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
    /** Accept a GPU requirement on the local runtime when discovery found no GPU. */
    allowUncheckedGpu?: boolean;
    /**
     * The host's GPUs, as discovered. A local GPU requirement passes only when
     * they include one; `verify` discovers them itself.
     */
    gpus?: GpuInventory;
}

/** One check in flight: what is required, where, and what has been learned. */
interface RequirementsCheck {
    requirements: WorkbenchRequirements;
    runtime: SelectedRuntime;
    options: RequirementsCheckOptions;
    report: RequirementsReport;
    fail: (message: string) => never;
}

type PendingField = 'arch' | 'cpu' | 'memory' | 'disk';

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
    private described: RequirementsHost | undefined;

    /**
     * `describer` describes the machine a local or Docker runtime runs on, and is
     * asked only when a check needs it. A runtime that provides its own machine,
     * such as a remote sandbox, never asks, so a host on another JavaScript
     * runtime passes nothing. `NodeHost` in `workbench/host.ts` describes the
     * local machine.
     */
    constructor(private readonly describer?: HostDescriber) {}

    private get host(): RequirementsHost {
        if (!this.describer) {
            throw new Error(
                'Checking requirements on this runtime needs a host description'
            );
        }
        this.described ??= this.describer.describe();
        return this.described;
    }

    /**
     * `check`, after discovering the host's GPUs when the Workbench needs one
     * on the local runtime. A describer that cannot discover GPUs finds none.
     */
    async verify(
        workbench: ResolvedWorkbench,
        options: RequirementsCheckOptions = {}
    ): Promise<RequirementsReport> {
        const discover =
            !options.gpus &&
            selectedRuntime(workbench).name === 'local' &&
            requirementsOf(workbench.manifest).gpu;
        if (!discover) return this.check(workbench, options);
        const gpus = (await this.describer?.gpus?.()) ?? {
            gpus: [],
            reason: 'this host cannot discover GPUs',
        };
        return this.check(workbench, { ...options, gpus });
    }

    check(
        workbench: ResolvedWorkbench,
        options: RequirementsCheckOptions = {}
    ): RequirementsReport {
        const runtime = selectedRuntime(workbench);
        const check: RequirementsCheck = {
            requirements: requirementsOf(workbench.manifest),
            runtime,
            options,
            report: { checked: [], applied: [], unchecked: [] },
            fail: this.refusal(workbench),
        };
        if (runtime.name === 'daytona') this.checkDaytona(check);
        else if (runtime.name === 'local') this.checkLocal(check);
        else this.checkContainer(check);
        return check.report;
    }

    private checkDaytona(check: RequirementsCheck): void {
        const { requirements, runtime, report, fail } = check;
        const daytonaClass = runtime.class;
        if (!daytonaClass) {
            fail('the daytona runtime declares no class');
            return;
        }
        const provided = daytonaClassOs[daytonaClass];
        const { os } = requirements;
        if (os && !os.includes(provided)) {
            fail(
                `the ${daytonaClass} class provides ${provided} but the Workbench requires ${this.list(os)}`
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
        // The sandbox is created with these as its resources.
        if (requirements.cpu !== undefined) {
            report.applied.push(`cpu allocation ${requirements.cpu}`);
        }
        if (requirements.memory_gb !== undefined) {
            report.applied.push(
                `memory allocation ${Math.ceil(requirements.memory_gb)} GiB`
            );
        }
        if (requirements.disk_gb !== undefined) {
            report.applied.push(
                `disk allocation ${Math.ceil(requirements.disk_gb)} GiB`
            );
        }
        this.pending(check, ['arch']);
    }

    private checkLocal(check: RequirementsCheck): void {
        const { requirements, options, report, fail } = check;
        const { os, arch: architectures } = requirements;
        if (os) {
            if (!os.includes(this.host.os as WorkbenchOs)) {
                fail(`requires os ${this.list(os)} but this host is ${this.host.os}`);
            }
            report.checked.push(`os ${this.host.os}`);
        }
        if (architectures) {
            if (!architectures.includes(this.host.arch as WorkbenchArch)) {
                fail(
                    `requires arch ${this.list(architectures)} but this host is ${this.host.arch}`
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
            const found = options.gpus?.gpus ?? [];
            if (found.length > 0) {
                report.checked.push(`gpu ${found.map((gpu) => gpu.name).join(', ')}`);
            } else {
                const reason = options.gpus?.reason ?? 'no GPU discovery ran';
                if (!options.allowUncheckedGpu) {
                    fail(
                        `requires a GPU but none was found: ${reason}. Pass --allow-unchecked-gpu to run on a GPU discovery cannot see.`
                    );
                }
                report.unchecked.push(`gpu was not found: ${reason}`);
            }
        }
        if (requirements.disk_gb !== undefined) {
            report.unchecked.push('disk_gb is not checked on the local runtime');
        }
    }

    /** docker, e2b, and any other Linux container or sandbox provider. */
    private checkContainer(check: RequirementsCheck): void {
        const { requirements, runtime, report, fail } = check;
        const { os, arch: architectures } = requirements;
        if (os && !os.includes('linux')) {
            fail(
                `requires os ${this.list(os)} but the ${runtime.name} runtime provides linux`
            );
        }
        if (requirements.gpu && runtime.name !== 'docker') {
            fail(`GPU requirements are not supported on the ${runtime.name} runtime`);
        }
        if (runtime.name !== 'docker') {
            this.pending(check, ['arch', 'cpu', 'memory', 'disk']);
            return;
        }
        if (requirements.gpu) {
            // Docker Desktop runs containers in a Linux virtual machine with no GPU.
            if (this.host.os === 'macos') {
                fail(
                    'Docker on macOS cannot give a container a GPU. Use the local runtime.'
                );
            }
            report.applied.push('gpu: all GPUs through the NVIDIA container runtime');
        }
        if (architectures) {
            if (!architectures.includes(this.host.arch as WorkbenchArch)) {
                fail(
                    `requires arch ${this.list(architectures)} but the docker runtime runs on ${this.host.arch}`
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
        this.pending(check, ['disk']);
    }

    private list(values: readonly string[]): string {
        return values.join(' or ');
    }

    private pending(check: RequirementsCheck, fields: PendingField[]): void {
        const { requirements, runtime, report } = check;
        const declared: Record<PendingField, boolean> = {
            arch: requirements.arch !== undefined,
            cpu: requirements.cpu !== undefined,
            memory: requirements.memory_gb !== undefined,
            disk: requirements.disk_gb !== undefined,
        };
        const names: Record<PendingField, string> = {
            arch: 'arch',
            cpu: 'cpu',
            memory: 'memory_gb',
            disk: 'disk_gb',
        };
        for (const field of fields) {
            if (declared[field]) {
                report.unchecked.push(
                    `${names[field]} is not checked on the ${runtime.name} runtime`
                );
            }
        }
    }

    /**
     * Throws when a container daemon cannot give a container the declared cpu or
     * memory. The runtime applies both as limits, which fail late with the
     * daemon's own error when the daemon has less.
     */
    checkDaemon(
        workbench: ResolvedWorkbench,
        daemon: { cpus: number; memoryBytes: number }
    ): void {
        const requirements = requirementsOf(workbench.manifest);
        const fail = this.refusal(workbench);
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

    /**
     * Throws when a GPU Workbench meets a Docker daemon without the NVIDIA
     * container runtime, which is what gives `--gpus` its GPUs. `runtimes` are
     * the names `docker info` lists.
     */
    checkDaemonRuntimes(workbench: ResolvedWorkbench, runtimes: string[]): void {
        if (!requirementsOf(workbench.manifest).gpu) return;
        if (runtimes.some((name) => name.startsWith('nvidia'))) return;
        this.refusal(workbench)(
            `requires a GPU but the Docker daemon has no NVIDIA container runtime (it has ${runtimes.join(', ') || 'none'}). Install the NVIDIA Container Toolkit and run nvidia-ctk runtime configure --runtime=docker.`
        );
    }

    private refusal(workbench: ResolvedWorkbench): (message: string) => never {
        const runtime = selectedRuntime(workbench).name;
        return (message) => {
            throw new Error(
                `Workbench ${workbench.manifest.name} cannot run on the ${runtime} runtime: ${message}`
            );
        };
    }
}

/** Hosts report slightly below nominal (a 16 GB Linux host shows about 15.6 GiB). */
function nearestGibibytes(bytes: number): number {
    return Math.round(bytes / bytesPerGibibyte);
}
