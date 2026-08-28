import {
    ConnectionInspector,
    type RunnerAuthenticationStatus,
} from '../connections/inspector.js';
import { ConnectionStore } from '../connections/store.js';
import { RunnerRegistry } from '../runners/registry.js';
import type { ResolvedWorkbench, WorkbenchWorkspaceBinding } from '../types.js';
import { type PreflightResult, WorkbenchWorkspaces } from '../workbench/index.js';
import type { PreparedRuntime } from './contracts.js';
import { RuntimeRegistry } from './registry.js';

export interface WorkbenchSmokeResult extends PreflightResult {
    authentication: RunnerAuthenticationStatus;
}

export interface RuntimeSmokeOptions {
    workbench: ResolvedWorkbench;
    workspaceDirectory?: string;
    environment?: Record<string, string | undefined>;
    workspaces?: WorkbenchWorkspaceBinding[];
    allowHostDocker?: boolean;
    registry?: RuntimeRegistry;
    reference?: string;
    home?: string;
}

export class RuntimeSmoke {
    private readonly workspaceBindings = new WorkbenchWorkspaces();

    constructor(private readonly options: RuntimeSmokeOptions) {}

    async check(): Promise<WorkbenchSmokeResult> {
        const environment = this.options.environment ?? process.env;
        const workspaceDirectory =
            this.options.workspaceDirectory ??
            this.options.workbench.repositoryDirectory;
        const workspaces = this.options.workspaces ?? [];
        await this.workspaceBindings.validate(this.options.workbench, workspaces);
        if (
            this.options.allowHostDocker &&
            !this.options.workbench.manifest.docker?.engine
        ) {
            throw new Error(
                'Host Docker authorization was supplied to a Workbench that does not declare docker.engine'
            );
        }
        const registry = this.options.registry ?? RuntimeRegistry.standard();
        const runner = await RunnerRegistry.standard().prepare(
            this.options.workbench,
            environment
        );
        let runtime: PreparedRuntime | undefined;
        let result: WorkbenchSmokeResult | undefined;
        let operationError: unknown;
        try {
            runtime = await registry
                .resolve(this.options.workbench.manifest.runtime)
                .prepare({
                    workbench: this.options.workbench,
                    workspaceDirectory,
                    environment,
                    assets: [
                        { path: workspaceDirectory, access: 'read-write' },
                        {
                            path: this.options.workbench.packageDirectory,
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
                });
            const preflight = await runtime.preflight();
            const authentication = await new ConnectionInspector({
                workbench: this.options.workbench,
                runtime,
                runner,
                ...(this.options.reference
                    ? { reference: this.options.reference }
                    : {}),
                ...(this.options.home
                    ? { store: new ConnectionStore(this.options.home) }
                    : {}),
            }).inspect();
            result = { ...preflight, authentication };
        } catch (error) {
            operationError = error;
        }
        const cleanup = await Promise.allSettled([
            runtime?.cleanup(),
            runner.cleanup(),
        ]);
        if (operationError) throw operationError;
        const cleanupFailure = cleanup.find(
            (entry): entry is PromiseRejectedResult => entry.status === 'rejected'
        );
        if (cleanupFailure) throw cleanupFailure.reason;
        if (!result) throw new Error('Workbench smoke did not produce a result');
        return result;
    }
}
