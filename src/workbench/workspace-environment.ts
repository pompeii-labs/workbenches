import type { WorkbenchWorkspaceBinding } from '../types.js';

/**
 * The `WORKBENCH_WORKSPACE_<NAME>` variables that tell a runner where each named
 * workspace lives. `pathFor` maps a host path to the path inside a sandbox. It
 * reads no filesystem, so any runtime can call it.
 */
export function workspaceEnvironment(
    bindings: WorkbenchWorkspaceBinding[],
    pathFor: (path: string) => string = (path) => path
): Record<string, string> {
    return Object.fromEntries(
        bindings.map((binding) => [
            `WORKBENCH_WORKSPACE_${binding.name.toUpperCase().replaceAll('-', '_')}`,
            pathFor(binding.path),
        ])
    );
}
