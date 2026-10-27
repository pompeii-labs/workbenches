import type { WorkbenchRequirements, WorkbenchRuntimeConfig } from '../types.js';
import type { GpuInventory, HostGpu } from './gpus.js';

export interface WorkbenchRuntimeView {
    name: string;
    image?: string;
    class?: string;
    docker_engine?: { mode: 'host'; authorization: 'explicit' };
}

/** What this host has for a Workbench that needs a GPU. */
export interface WorkbenchGpuView {
    /** The GPUs discovery found on this host. */
    host: HostGpu[];
    /** Why discovery found none. */
    reason?: string;
    /** Whether `gpu: true` passes on the local runtime here, when the Workbench declares it. */
    local?: 'passes' | 'refused';
}

export function describeGpu(
    inventory: GpuInventory,
    runtimes: WorkbenchRuntimeView[]
): WorkbenchGpuView {
    const local: WorkbenchGpuView['local'] = inventory.gpus.length
        ? 'passes'
        : 'refused';
    return {
        host: inventory.gpus,
        ...(inventory.reason ? { reason: inventory.reason } : {}),
        ...(runtimes.some((runtime) => runtime.name === 'local') ? { local } : {}),
    };
}

export function renderGpu(gpu: WorkbenchGpuView): string {
    const found = gpu.host.length
        ? gpu.host
              .map((entry) =>
                  entry.memory_gb === undefined
                      ? entry.name
                      : `${entry.name} (${entry.memory_gb} GiB)`
              )
              .join(', ')
        : `none: ${gpu.reason ?? 'no GPU found'}`;
    return gpu.local ? `${found} · ${gpu.local} on local` : found;
}

/** The runtime facts the Workbench summary renders as labelled fields. */
interface RuntimeSummary {
    runtime: string;
    image?: string;
    docker_engine?: WorkbenchRuntimeView['docker_engine'];
    runtimes: WorkbenchRuntimeView[];
}

export function describeRuntime(
    name: string,
    runtime: WorkbenchRuntimeConfig
): WorkbenchRuntimeView {
    const image = runtime.image;
    return {
        name,
        ...(image
            ? {
                  image:
                      typeof image === 'string'
                          ? image
                          : `${image.build} (build context ${image.context ?? '.'})`,
              }
            : {}),
        ...(runtime.class ? { class: runtime.class } : {}),
        ...(runtime.docker?.engine
            ? {
                  docker_engine: {
                      mode: runtime.docker.engine.mode,
                      authorization: 'explicit' as const,
                  },
              }
            : {}),
    };
}

/** Labelled fields for the summary: one runtime in full, several by name. */
export function renderRuntimeFields(
    summary: RuntimeSummary
): Array<[label: string, value: string]> {
    if (summary.runtimes.length === 1) {
        return [
            ['Runtime', summary.runtime],
            ['Image', summary.image ?? 'none'],
            [
                'Docker engine',
                summary.docker_engine
                    ? `${summary.docker_engine.mode} · explicit authorization required`
                    : 'none',
            ],
        ];
    }
    return [
        [
            'Runtimes',
            summary.runtimes
                .map((runtime, index) =>
                    index === 0 ? `${runtime.name} (default)` : runtime.name
                )
                .join(', '),
        ],
    ];
}

/** The per-runtime detail section. Empty unless several runtimes are declared. */
export function renderRuntimeDetails(runtimes: WorkbenchRuntimeView[]): string[] {
    if (runtimes.length <= 1) return [];
    return [
        '',
        'Runtimes',
        ...runtimes.map((runtime) => {
            const details = [
                ...(runtime.class ? [`class ${runtime.class}`] : []),
                ...(runtime.image ? [`image ${runtime.image}`] : []),
                ...(runtime.docker_engine
                    ? [
                          `docker engine ${runtime.docker_engine.mode} (explicit authorization required)`,
                      ]
                    : []),
            ];
            return `  ${[runtime.name, ...details].join(' · ')}`;
        }),
    ];
}

export function renderRequirements(requirements: WorkbenchRequirements): string {
    const parts = [
        ...(requirements.os ? [`os ${requirements.os.join(' or ')}`] : []),
        ...(requirements.arch ? [`arch ${requirements.arch.join(' or ')}`] : []),
        ...(requirements.cpu === undefined ? [] : [`${requirements.cpu}+ CPUs`]),
        ...(requirements.memory_gb === undefined
            ? []
            : [`${requirements.memory_gb}+ GiB memory`]),
        ...(requirements.disk_gb === undefined
            ? []
            : [`${requirements.disk_gb}+ GiB disk`]),
        ...(requirements.gpu ? ['gpu'] : []),
    ];
    return parts.join(' · ') || 'none';
}
