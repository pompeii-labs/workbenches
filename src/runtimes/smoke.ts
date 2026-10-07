import { RunnerCredentialStore } from '../connections/credentials.js';
import { withHostRunnerCredentials } from '../connections/environmentcredentials.js';
import {
    ConnectionInspector,
    type RunnerAuthenticationStatus,
} from '../connections/inspector.js';
import { configureRunnerRuntime } from '../connections/preparation.js';
import { ConnectionStore } from '../connections/store.js';
import { RunnerRegistry } from '../runners/registry.js';
import type { PreparedRunner } from '../runners/runner.js';
import { RunStore } from '../runs/store.js';
import type { ResolvedWorkbench, WorkbenchWorkspaceBinding } from '../types.js';
import type { PreflightResult } from '../workbench/preflight.js';
import { selectedRuntime, withRuntime } from '../workbench/runtimes.js';
import { WorkbenchWorkspaces } from '../workbench/workspaces.js';
import type { PreparedRuntime } from './contracts.js';
import { RuntimeRegistry } from './registry.js';

export interface WorkbenchSmokeResult extends PreflightResult {
    authentication: RunnerAuthenticationStatus;
    warnings?: string[];
}

export interface RuntimeSmokeOptions {
    workbench: ResolvedWorkbench;
    workspaceDirectory?: string;
    environment?: Record<string, string | undefined>;
    workspaces?: WorkbenchWorkspaceBinding[];
    allowHostDocker?: boolean;
    /** Runtime to prepare. Defaults to the first declared runtime. */
    runtime?: string;
    /** Accept a GPU requirement on a runtime that cannot verify it. */
    allowUncheckedGpu?: boolean;
    registry?: RuntimeRegistry;
    reference?: string;
    home?: string;
    connection?: string;
}

export class RuntimeSmoke {
    private readonly workspaceBindings = new WorkbenchWorkspaces();

    constructor(private readonly options: RuntimeSmokeOptions) {}

    async check(): Promise<WorkbenchSmokeResult> {
        let environment = this.options.environment ?? process.env;
        const workbench = withRuntime(this.options.workbench, this.options.runtime);
        const selected = selectedRuntime(workbench);
        const workspaceDirectory =
            this.options.workspaceDirectory ?? workbench.repositoryDirectory;
        const workspaces = this.options.workspaces ?? [];
        await this.workspaceBindings.validate(workbench, workspaces);
        const registry = this.options.registry ?? RuntimeRegistry.standard();
        if (this.options.home) {
            environment = await withHostRunnerCredentials(
                this.options.home,
                selected.name,
                workbench.manifest.runner,
                environment
            );
        }
        registry.requirements.check(workbench, {
            ...(this.options.allowUncheckedGpu ? { allowUncheckedGpu: true } : {}),
        });
        if (this.options.allowHostDocker && !selected.docker?.engine) {
            throw new Error(
                'Host Docker authorization was supplied to a Workbench that does not declare docker.engine'
            );
        }
        const runner = await RunnerRegistry.standard().prepare(workbench, environment, {
            workspaceDirectory,
        });
        let runtime: PreparedRuntime | undefined;
        let result: WorkbenchSmokeResult | undefined;
        let operationError: unknown;
        try {
            runtime = await registry.resolve(selected.name).prepare({
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
                    .nativeCredentialStore(selected.name),
                workspaceDirectory,
                environment,
                assets: [
                    { path: workspaceDirectory, access: 'read-write' },
                    {
                        path: workbench.packageDirectory,
                        access: 'read-only',
                    },
                    ...workspaces.map((workspace) => ({
                        path: workspace.path,
                        access: workspace.access,
                        workspace: workspace.name,
                    })),
                    ...runner.assets,
                ],
                authorizations: {
                    hostDocker: this.options.allowHostDocker ?? false,
                },
                allowUncheckedGpu: this.options.allowUncheckedGpu ?? false,
                ...(selected.name === 'e2b' &&
                this.options.home &&
                RunnerRegistry.standard()
                    .authentication(runner.name)
                    .nativeCredentialStore(selected.name)
                    ? {
                          credentials: await new RunnerCredentialStore(
                              this.options.home
                          ).prepare(selected.name, workbench.manifest.runner),
                      }
                    : {}),
                ...(this.options.home
                    ? {
                          run: {
                              id: RunStore.createId(),
                              scope: RunStore.scope(this.options.home),
                          },
                      }
                    : {}),
            });
            await configureRunnerRuntime(runner, runtime);
            const preflight = await runtime.preflight();
            const authentication = await new ConnectionInspector({
                workbench,
                runtime,
                runner,
                ...(this.options.reference
                    ? { reference: this.options.reference }
                    : {}),
                ...(this.options.home
                    ? { store: new ConnectionStore(this.options.home) }
                    : {}),
            }).inspect({
                ...(this.options.connection ? { discoverConnections: true } : {}),
                ...(this.options.connection
                    ? { connection: this.options.connection }
                    : {}),
            });
            result = {
                ...preflight,
                authentication,
                ...(runner.warnings ? { warnings: runner.warnings } : {}),
            };
        } catch (error) {
            operationError = error;
        }
        const runtimeCleanup = await Promise.allSettled([runtime?.cleanup()]);
        const cleanup = [
            ...runtimeCleanup,
            ...(await Promise.allSettled([runner.cleanup()])),
        ];
        if (operationError) throw operationError;
        const cleanupFailure = cleanup.find(
            (entry): entry is PromiseRejectedResult => entry.status === 'rejected'
        );
        if (cleanupFailure) throw cleanupFailure.reason;
        if (!result) throw new Error('Workbench smoke did not produce a result');
        return result;
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
