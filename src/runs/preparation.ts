import { RunnerCredentialStore } from '../connections/credentials.js';
import { ConnectionInspector } from '../connections/inspector.js';
import {
    ConnectionStore,
    type RunnerConnectionSelection,
} from '../connections/store.js';
import type { ResolvedRunnerConfiguration } from '../models/index.js';
import type { OutcomeCompleteness, RunOutcome } from '../outcomes/contracts.js';
import { OutcomeLifecycle } from '../outcomes/lifecycle.js';
import { RunnerRegistry } from '../runners/registry.js';
import type { PreparedRunner } from '../runners/runner.js';
import type { RunnerSessionContext } from '../runners/session.js';
import type {
    PreparedRuntime,
    RuntimeInfrastructureMetadata,
} from '../runtimes/contracts.js';
import type { RuntimeRegistry } from '../runtimes/registry.js';
import type { ResolvedWorkbench, WorkbenchWorkspaceBinding } from '../types.js';
import type { PreflightResult } from '../workbench/preflight.js';
import type { RunEvents } from './events.js';
import { publishRunOutcome } from './outcomes.js';
import { RunStore } from './store.js';

interface ExecutionPreparationOptions {
    workbench: ResolvedWorkbench;
    workspaceDirectory: string;
    events: RunEvents;
    mode: 'one-shot' | 'session';
    home?: string;
    reference?: string;
    workspaces?: WorkbenchWorkspaceBinding[];
    session?: RunnerSessionContext;
    allowHostDocker?: boolean;
    captureOutcomes?: boolean;
    connection?: string;
    allowAuthentication?: boolean;
}

interface ExecutionPreparationDependencies {
    environment: Record<string, string | undefined>;
    runners?: RunnerRegistry;
    runtimes: RuntimeRegistry;
    now?: () => Date;
}

interface PreparedExecution {
    runner: PreparedRunner;
    runtime: PreparedRuntime;
    preflight: PreflightResult;
    configuration: ResolvedRunnerConfiguration;
    authentication?: RunnerConnectionSelection;
}

/** Owns preparation resources, including partially prepared resources on failure. */
export class ExecutionPreparation {
    private runner: PreparedRunner | undefined;
    private runtime: PreparedRuntime | undefined;
    private outcomes: OutcomeLifecycle | undefined;
    private preparation: Promise<PreparedExecution> | undefined;
    private release: Promise<void> | undefined;

    constructor(
        private readonly options: ExecutionPreparationOptions,
        private readonly dependencies: ExecutionPreparationDependencies
    ) {}

    prepare(): Promise<PreparedExecution> {
        if (this.release)
            return Promise.reject(new Error('Execution preparation is closed'));
        this.preparation ??= this.prepareOnce();
        return this.preparation;
    }

    collect(completeness: OutcomeCompleteness): Promise<RunOutcome | undefined> {
        return (
            this.outcomes?.collect(this.runtime, completeness) ??
            Promise.resolve(undefined)
        );
    }

    checkpoint(turn: number): Promise<RunOutcome | undefined> {
        return (
            this.outcomes?.checkpoint(this.runtime, turn) ?? Promise.resolve(undefined)
        );
    }

    infrastructure(): Promise<RuntimeInfrastructureMetadata | undefined> {
        return (
            this.runtime?.infrastructure?.().catch(() => undefined) ??
            Promise.resolve(undefined)
        );
    }

    cleanup(): Promise<void> {
        this.release ??= this.cleanupOnce();
        return this.release;
    }

    private async prepareOnce(): Promise<PreparedExecution> {
        const { workbench, home, session } = this.options;
        if (home && this.options.captureOutcomes !== false) {
            this.outcomes = await OutcomeLifecycle.create({
                home,
                runId: this.options.events.runId,
                ...(session?.nativeSessionId ? { resumeSessionId: session.id } : {}),
                ...(this.dependencies.now ? { now: this.dependencies.now } : {}),
                onAvailable: (outcome, state) =>
                    publishRunOutcome(home, this.options.events, outcome, state),
            });
        }
        this.runner = await (
            this.dependencies.runners ?? RunnerRegistry.standard()
        ).prepare(workbench, this.dependencies.environment);
        this.runtime = await this.dependencies.runtimes
            .resolve(workbench.manifest.runtime)
            .prepare({
                workbench,
                workspaceDirectory: this.options.workspaceDirectory,
                environment: this.dependencies.environment,
                assets: [
                    { path: this.options.workspaceDirectory, access: 'read-write' },
                    { path: workbench.packageDirectory, access: 'read-only' },
                    ...(this.options.workspaces ?? []).map((workspace) => ({
                        path: workspace.path,
                        access: workspace.access,
                        workspace: workspace.name,
                    })),
                    ...this.runner.assets,
                    ...(session
                        ? [
                              {
                                  path: session.directory,
                                  access: 'read-write' as const,
                                  state: true,
                              },
                          ]
                        : []),
                ],
                authorizations: { hostDocker: this.options.allowHostDocker ?? false },
                purpose: 'run',
                ...(workbench.manifest.runtime === 'e2b' && home
                    ? {
                          credentials: await new RunnerCredentialStore(home).prepare(
                              workbench.manifest.runtime,
                              workbench.manifest.runner
                          ),
                      }
                    : {}),
                ...(home
                    ? {
                          run: {
                              id: this.options.events.runId,
                              scope: RunStore.scope(home),
                          },
                      }
                    : {}),
                ...(this.outcomes
                    ? {
                          outcome: {
                              directory: this.outcomes.output.directory,
                              ...(home ? { home } : {}),
                          },
                      }
                    : {}),
            });
        const preflight = await this.runtime.preflight();
        const selection = await this.selectConnection(this.runner, this.runtime);
        return { runner: this.runner, runtime: this.runtime, preflight, ...selection };
    }

    private async selectConnection(
        runner: PreparedRunner,
        runtime: PreparedRuntime
    ): Promise<Pick<PreparedExecution, 'configuration' | 'authentication'>> {
        const { workbench, home, connection } = this.options;
        const store = home ? new ConnectionStore(home) : undefined;
        const inspector = new ConnectionInspector({
            workbench,
            runtime,
            runner,
            reference: this.options.reference ?? workbench.manifest.name,
            ...(store ? { store } : {}),
        });
        if (this.options.mode === 'one-shot') {
            return { configuration: await inspector.require(connection) };
        }
        const preferred = await store?.find(ConnectionStore.context(workbench));
        let status: Awaited<ReturnType<ConnectionInspector['inspect']>> | undefined;
        try {
            status = await inspector.inspect({
                ...(preferred ? { preferredConnection: preferred } : {}),
                ...(connection ? { discoverConnections: true } : {}),
            });
        } catch (error) {
            if (!preferred || !matchesRequestedConnection(preferred, connection))
                throw error;
        }
        const authenticated = connection
            ? status?.connections.find((candidate) =>
                  matchesRequestedConnection(candidate, connection)
              )
            : undefined;
        if (authenticated)
            return { configuration: inspector.configurationFor(authenticated) };
        if (!connection && status?.configuration)
            return { configuration: status.configuration };
        if (preferred && matchesRequestedConnection(preferred, connection)) {
            if (!this.options.allowAuthentication) {
                throw new Error(
                    `Authentication is required for ${preferred.provider}. Start this Workbench interactively once to finish ${preferred.nativeProvider} sign-in.`
                );
            }
            if (workbench.manifest.runner !== 'opencode') {
                throw new Error(
                    `First-run authentication for ${workbench.manifest.runner} is not available inside a Workbench run yet`
                );
            }
            return {
                configuration: inspector.configurationFor(preferred),
                authentication: preferred,
            };
        }
        const model = status?.model ?? workbench.manifest.model.id;
        const connect =
            status?.connectCommand ??
            `wb connect ${this.options.reference ?? workbench.manifest.name}`;
        if (connection) {
            throw new Error(
                `Connection ${connection} is not authenticated for ${model} with ${workbench.manifest.runner} in the ${runtime.name} runtime. Run ${connect}.`
            );
        }
        throw new Error(
            `No authenticated route is available for ${model}. Run ${connect}.`
        );
    }

    private async cleanupOnce(): Promise<void> {
        await this.preparation?.catch(() => undefined);
        const results = await Promise.allSettled([
            Promise.resolve().then(() => this.runtime?.cleanup()),
            Promise.resolve().then(() => this.runner?.cleanup()),
            Promise.resolve().then(() => this.outcomes?.cleanup()),
        ]);
        const failure = results.find(
            (result): result is PromiseRejectedResult => result.status === 'rejected'
        );
        if (failure) throw failure.reason;
    }
}

function matchesRequestedConnection(
    selection: RunnerConnectionSelection,
    requested: string | undefined
): boolean {
    if (!requested) return true;
    const normalized = requested.trim().toLowerCase();
    return (
        selection.provider.toLowerCase() === normalized ||
        selection.nativeProvider.toLowerCase() === normalized
    );
}
