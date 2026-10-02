/** Labels every remote sandbox carries so a run's sandboxes can be found again. */
export const managedMetadata = 'dev.workbenches.managed';
export const runMetadata = 'dev.workbenches.run';
export const scopeMetadata = 'dev.workbenches.scope';

/** The labels for a run's sandbox. `provider` names the runtime in messages. */
export function runLabels(
    run: { id: string; scope: string },
    provider: string
): Record<string, string> {
    if (!/^wb_[a-z0-9]{20,64}$/.test(run.id)) {
        throw new Error(`Invalid Workbench run ID for ${provider}: ${run.id}`);
    }
    if (!/^[a-f0-9]{24}$/.test(run.scope)) {
        throw new Error(`Invalid Workbench ${provider} scope: ${run.scope}`);
    }
    return {
        [managedMetadata]: 'true',
        [runMetadata]: run.id,
        [scopeMetadata]: run.scope,
    };
}
