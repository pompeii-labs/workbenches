import type { PreparedRunner } from '../runners/runner.js';
import type { PreparedRuntime } from '../runtimes/contracts.js';
import { applyRuntimeCredentials } from './environmentcredentials.js';

/** Applies the runner's credential environment before it stages runtime config. */
export async function configureRunnerRuntime(
    runner: PreparedRunner,
    runtime: PreparedRuntime
): Promise<void> {
    await applyRuntimeCredentials(runtime, runner.name);
    await runner.configureRuntime?.(runtime);
}
