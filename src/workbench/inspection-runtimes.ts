import type { WorkbenchRequirements, WorkbenchRuntimeConfig } from '../types.js';

export interface WorkbenchRuntimeView {
    name: string;
    image?: string;
    class?: string;
    docker_engine?: { mode: 'host'; authorization: 'explicit' };
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
