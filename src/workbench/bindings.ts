import type { WorkbenchWorkspaceBinding } from '../types.js';

/**
 * The `WORKBENCH_WORKSPACE_<NAME>` variables that tell a runner where each named
 * workspace lives. It reads no filesystem, so every runtime and every host can
 * call it.
 */
export function workspaceEnvironment(
    bindings: WorkbenchWorkspaceBinding[]
): Record<string, string> {
    return Object.fromEntries(
        bindings.map((binding) => [
            `WORKBENCH_WORKSPACE_${binding.name.toUpperCase().replaceAll('-', '_')}`,
            binding.path,
        ])
    );
}
