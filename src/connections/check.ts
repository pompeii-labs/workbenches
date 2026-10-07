import { RunnerRegistry } from '../runners/registry.js';
import type { PreparedRunner } from '../runners/runner.js';
import type { PreparedRuntime } from '../runtimes/contracts.js';
import { RuntimeRegistry } from '../runtimes/registry.js';
import type { ResolvedWorkbench } from '../types.js';
import { selectedRuntime } from '../workbench/runtimes.js';
import { withHostRunnerCredentials } from './environmentcredentials.js';
import { ConnectionInspector, type RunnerAuthenticationStatus } from './inspector.js';
import { configureRunnerRuntime } from './preparation.js';
import type { ConnectionStore, RunnerConnectionSelection } from './store.js';

export interface ConnectionCheckOptions {
    /** The Workbench with the runtime to check already selected. */
    workbench: ResolvedWorkbench;
    workspaceDirectory: string;
    reference: string;
    environment: Record<string, string | undefined>;
    store?: ConnectionStore;
    runners?: Pick<RunnerRegistry, 'prepare'>;
    runtimes?: Pick<RuntimeRegistry, 'resolve'>;
}

/**
 * Prepares a Workbench's runner and runtime for connection work only: reading
 * authentication state with the same inspection smoke runs, and reaching the
 * runtime's credential store. It runs no tool or workspace preflight.
 */
export class ConnectionCheck {
    constructor(private readonly options: ConnectionCheckOptions) {}

    /** Runs `work` against the prepared runtime, then cleans both up. */
    async open<T>(
        work: (runtime: PreparedRuntime, runner: PreparedRunner) => Promise<T>
    ): Promise<T> {
        const { workbench } = this.options;
        let runner: PreparedRunner | undefined;
        let runtime: PreparedRuntime | undefined;
        try {
            const runtimeName = selectedRuntime(workbench).name;
            const environment = this.options.store
                ? await withHostRunnerCredentials(
                      this.options.store.home,
                      runtimeName,
                      workbench.manifest.runner,
                      this.options.environment
                  )
                : this.options.environment;
            runner = await (this.options.runners ?? RunnerRegistry.standard()).prepare(
                workbench,
                environment
            );
            runtime = await (this.options.runtimes ?? RuntimeRegistry.standard())
                .resolve(runtimeName)
                .prepare({
                    workbench,
                    runnerAuthentication: runtimeAuthentication(runner),
                    ...(runner.nativeCommand
                        ? { runnerCommand: runner.nativeCommand }
                        : {}),
                    ...(runner.nativeVersion
                        ? { runnerVersion: runner.nativeVersion }
                        : {}),
                    runnerCredentialStore: RunnerRegistry.standard()
                        .authentication(runner.name)
                        .nativeCredentialStore(runtimeName),
                    workspaceDirectory: this.options.workspaceDirectory,
                    environment,
                    assets: [
                        // Connection work never changes the workspace.
                        { path: this.options.workspaceDirectory, access: 'read-only' },
                        { path: workbench.packageDirectory, access: 'read-only' },
                        ...runner.assets,
                    ],
                    purpose: 'connect',
                    authorizations: { hostDocker: false },
                    // Connection work reads and writes credentials and runs no Workbench task.
                    allowUncheckedGpu: true,
                });
            await configureRunnerRuntime(runner, runtime);
            return await work(runtime, runner);
        } finally {
            await Promise.allSettled([runtime?.cleanup(), runner?.cleanup()]);
        }
    }

    /** Inspects the runtime's routes, after `before` has used the prepared runtime. */
    inspect(
        options: {
            selection?: RunnerConnectionSelection;
            before?: (runtime: PreparedRuntime) => Promise<void>;
        } = {}
    ): Promise<RunnerAuthenticationStatus> {
        return this.open(async (runtime, runner) => {
            await options.before?.(runtime);
            return new ConnectionInspector({
                workbench: this.options.workbench,
                runtime,
                runner,
                reference: this.options.reference,
                ...(this.options.store ? { store: this.options.store } : {}),
            }).inspect({
                discoverConnections: true,
                ...(options.selection
                    ? { preferredConnection: options.selection }
                    : {}),
            });
        });
    }
}

function runtimeAuthentication(runner: PreparedRunner) {
    const authentication =
        runner.authentication ?? RunnerRegistry.standard().authentication(runner.name);
    return {
        environmentNames: authentication.environmentNames,
        allowEnvironment: (name: string, runtime: string) =>
            authentication.allowEnvironment(name, runtime),
        ...(authentication.credentialEnvironment
            ? { credentialEnvironment: authentication.credentialEnvironment }
            : {}),
        ...(authentication.subprocessEnvironmentScrubbing
            ? {
                  subprocessEnvironmentScrubbing:
                      authentication.subprocessEnvironmentScrubbing,
              }
            : {}),
    };
}
