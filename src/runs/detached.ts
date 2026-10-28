import { AuthenticationRequiredError } from '../connections/error.js';
import { ModelCatalog } from '../models/catalog.js';
import { connectAdvice } from '../models/index.js';
import type { RepositoryRequest } from '../repositories/contracts.js';
import { RuntimeRegistry, RuntimeSmoke } from '../runtimes/index.js';
import {
    type EnvironmentOverrides,
    selectedRuntime,
    WorkbenchEnvironment,
    WorkbenchResolver,
    WorkbenchWorkspaces,
    withRuntime,
} from '../workbench/index.js';
import type { RunDispatcher } from './dispatcher.js';
import type { StoredRun } from './store.js';

export interface StartDetachedRunOptions {
    workbench: string;
    task: string;
    cwd?: string;
    directory?: string;
    repository?: RepositoryRequest;
    runtime?: string;
    rawArgs: string[];
    environmentOverrides: EnvironmentOverrides;
    allowHostDocker: boolean;
    allowUncheckedGpu: boolean;
    connection?: string;
    project?: string;
    /** The host environment the run inherits instead of this process's own. */
    environment?: Record<string, string | undefined>;
}

/** Owns resolution, preflight, persistence, and startup for a detached run. */
export class DetachedRunLauncher {
    constructor(
        private readonly home: string,
        private readonly dispatcher: Pick<RunDispatcher, 'prepare' | 'dispatch'>
    ) {}

    async start(options: StartDetachedRunOptions): Promise<StoredRun> {
        await new ModelCatalog({ home: this.home }).refresh();
        const resolved = await new WorkbenchResolver().resolve(options.workbench, {
            home: this.home,
            savedOnly: true,
            ...(options.cwd ? { cwd: options.cwd } : {}),
            ...(options.directory ? { workspaceDirectory: options.directory } : {}),
        });
        if (options.repository) resolved.repository = options.repository;
        try {
            resolved.workbench = withRuntime(resolved.workbench, options.runtime);
            const runtimes = RuntimeRegistry.standard();
            await runtimes.requirements.verify(resolved.workbench, {
                ...(options.allowUncheckedGpu ? { allowUncheckedGpu: true } : {}),
            });
            const workspaces = await new WorkbenchWorkspaces().bind({
                workbench: resolved.workbench,
                rawArgs: options.rawArgs,
            });
            validateHostDockerAuthorization(
                selectedRuntime(resolved.workbench).docker?.engine !== undefined,
                options.allowHostDocker
            );
            const inherited = options.environment ?? process.env;
            const environment = {
                ...inherited,
                ...new WorkbenchEnvironment().bind(
                    resolved.workbench,
                    options.environmentOverrides,
                    inherited
                ),
            };
            if (
                !options.repository &&
                runtimes.resolve(selectedRuntime(resolved.workbench).name).placement !==
                    'sandbox'
            ) {
                const smoke = await new RuntimeSmoke({
                    workbench: resolved.workbench,
                    allowUncheckedGpu: options.allowUncheckedGpu,
                    registry: runtimes,
                    workspaceDirectory: resolved.workspaceDirectory,
                    environment,
                    workspaces,
                    allowHostDocker: options.allowHostDocker,
                    reference: options.workbench,
                    home: this.home,
                    ...(options.connection ? { connection: options.connection } : {}),
                }).check();
                if (!smoke.authentication.ready) {
                    throw new AuthenticationRequiredError(
                        `No authenticated route is available for ${smoke.authentication.model}. ${connectAdvice(smoke.authentication.connectCommand)}.`
                    );
                }
            }
            const run = await this.dispatcher.prepare({
                resolved,
                task: options.task,
                mode: 'detached',
                reference: options.workbench,
                workspaces,
                allowHostDocker: options.allowHostDocker,
                ...(options.allowUncheckedGpu ? { allowUncheckedGpu: true } : {}),
                ...(options.connection ? { connection: options.connection } : {}),
                ...(options.project ? { project: options.project } : {}),
                ...(options.environment ? { environment: options.environment } : {}),
            });
            await this.dispatcher.dispatch({
                id: run.id,
                cwd: resolved.workspaceDirectory,
                environment,
                waitForInitialTurn: true,
            });
            return run;
        } finally {
            await resolved.cleanup();
        }
    }
}

function validateHostDockerAuthorization(declared: boolean, authorized: boolean): void {
    if (authorized && !declared) {
        throw new Error(
            '--allow-host-docker requires a Workbench that declares docker.engine'
        );
    }
}
