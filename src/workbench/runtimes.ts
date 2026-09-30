import type {
    ResolvedWorkbench,
    SelectedRuntime,
    WorkbenchManifest,
    WorkbenchRequirements,
    WorkbenchRuntimeConfig,
} from '../types.js';

/** Providers a manifest can declare under `runtimes`. */
export const runtimeProviderNames = ['local', 'docker', 'e2b', 'daytona'] as const;

/**
 * The runtimes a manifest declares, in declaration order. Manifests built
 * before `runtimes` existed fall back to their singular `runtime` form.
 */
export function declaredRuntimes(
    manifest: WorkbenchManifest
): Record<string, WorkbenchRuntimeConfig> {
    if (manifest.runtimes) return manifest.runtimes;
    if (!manifest.runtime) {
        throw new Error('Workbench manifest declares no runtime');
    }
    return {
        [manifest.runtime]: {
            ...(manifest.image === undefined ? {} : { image: manifest.image }),
            ...(manifest.docker === undefined ? {} : { docker: manifest.docker }),
        },
    };
}

/** The declared runtime names in declaration order. */
export function declaredRuntimeNames(manifest: WorkbenchManifest): string[] {
    return Object.keys(declaredRuntimes(manifest));
}

/** The runtime this workbench will run on: the explicit selection, else the first declared. */
export function selectedRuntime(workbench: ResolvedWorkbench): SelectedRuntime {
    const declared = declaredRuntimes(workbench.manifest);
    const names = Object.keys(declared);
    const name = workbench.selectedRuntime ?? names[0];
    const config = name === undefined ? undefined : declared[name];
    if (name === undefined || config === undefined) {
        throw unknownRuntime(workbench.manifest, name ?? '');
    }
    return { name, ...config };
}

/**
 * Returns the workbench bound to a runtime. Without a name the current
 * selection is kept. A name the manifest does not declare is an error.
 */
export function withRuntime<T extends ResolvedWorkbench>(
    workbench: T,
    name?: string
): T {
    if (name === undefined) return workbench;
    if (!Object.hasOwn(declaredRuntimes(workbench.manifest), name)) {
        throw unknownRuntime(workbench.manifest, name);
    }
    return { ...workbench, selectedRuntime: name };
}

/** The requirements with defaults applied. Absent constraints stay absent. */
export function requirementsOf(manifest: WorkbenchManifest): WorkbenchRequirements {
    return manifest.requirements ?? { gpu: false };
}

function unknownRuntime(manifest: WorkbenchManifest, name: string): Error {
    return new Error(
        `Workbench ${manifest.name} does not declare runtime: ${name}. Declared runtimes: ${declaredRuntimeNames(manifest).join(', ')}`
    );
}
