import { join } from 'node:path';
import { RunnerCredentialStore } from '../connections/credentials.js';
import { ConnectionInspector } from '../connections/inspector.js';
import {
    ConnectionStore,
    type RunnerConnectionSelection,
} from '../connections/store.js';
import type { ResolvedRunnerConfiguration } from '../models/index.js';
import { OutcomeApplier } from '../outcomes/apply.js';
import type { OutcomeCompleteness, RunOutcome } from '../outcomes/contracts.js';
import { OutcomeLifecycle } from '../outcomes/lifecycle.js';
import { OutcomeStore } from '../outcomes/store.js';
import {
    type RepositoryBinding,
    RepositoryCredentials,
    RepositoryWorkspace,
} from '../repositories/index.js';
import { RepositoryRetention } from '../repositories/retention.js';
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
    repository?: RepositoryBinding;
}

interface ExecutionPreparationDependencies {
    environment: Record<string, string | undefined>;
    runners?: RunnerRegistry;
    runtimes: RuntimeRegistry;
    now?: () => Date;
    repositories?: (
        home: string,
        binding: RepositoryBinding,
        environment: Record<string, string | undefined>
    ) => RepositoryWorkspace;
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
    private repository: RepositoryWorkspace | undefined;
    private collection: Promise<RunOutcome | undefined> | undefined;

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
        this.collection ??= this.collectOnce(completeness).catch((error) => {
            this.collection = undefined;
            throw error;
        });
        return this.collection;
    }

    private async collectOnce(
        completeness: OutcomeCompleteness
    ): Promise<RunOutcome | undefined> {
        const outcome = await this.outcomes?.collect(this.runtime, completeness);
        const { home, repository, events } = this.options;
        if (!outcome || !home || !repository || !this.repository) return outcome;
        const store = new OutcomeStore(home);
        try {
            if ((await store.receipt(outcome.id)).state === 'pending') {
                await new OutcomeApplier(store).apply(outcome, {
                    primary: this.repository.directory,
                });
                await publishRunOutcome(home, events, outcome, 'applied');
            }
            return outcome;
        } finally {
            await store.close();
        }
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
        let workspaceDirectory = this.options.workspaceDirectory;
        let environment = this.dependencies.environment;
        if (this.options.repository) {
            if (this.options.captureOutcomes === false)
                throw new Error(
                    'Repository execution requires durable outcome capture'
                );
            if (!home)
                throw new Error(
                    'Repository execution requires a persistent Workbench home'
                );
            if (this.options.workspaces?.length || this.options.allowHostDocker)
                throw new Error(
                    'Repository execution cannot bind host workspaces or Docker'
                );
            this.repository = (
                this.dependencies.repositories ??
                ((home, binding, environment) =>
                    new RepositoryWorkspace(home, binding, environment))
            )(home, this.options.repository, environment);
            this.repository.assertCredentialsOwnedByEngine(workbench);
            await this.options.events.emit('repository.preparing', {
                repository: `${this.options.repository.owner}/${this.options.repository.name}`,
                revision: this.options.repository.revision,
            });
            const identity = await this.repository.prepare(workbench.manifest.runtime);
            await new RepositoryRetention(home, this.options.repository).restore(
                this.options.events.runId,
                this.repository.directory
            );
            workspaceDirectory = this.repository.directory;
            const credentials = new RepositoryCredentials(environment);
            const token =
                this.options.repository.delivery === 'pr'
                    ? await credentials.token(true)
                    : undefined;
            environment = {
                ...new RepositoryCredentials(environment).runnerEnvironment(),
                WORKBENCH_REPOSITORY: `${this.options.repository.owner}/${this.options.repository.name}`,
                WORKBENCH_REPOSITORY_REVISION: this.options.repository.revision,
                ...(token
                    ? {
                          GH_TOKEN: token,
                          GIT_TERMINAL_PROMPT: '0',
                          GIT_CONFIG_COUNT: '4',
                          GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
                          GIT_CONFIG_VALUE_0: '',
                          GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
                          GIT_CONFIG_VALUE_1: '!gh auth git-credential',
                          GIT_CONFIG_KEY_2: 'user.name',
                          GIT_CONFIG_VALUE_2: identity?.name,
                          GIT_CONFIG_KEY_3: 'user.email',
                          GIT_CONFIG_VALUE_3: identity?.email,
                      }
                    : {}),
            };
            await this.options.events.emit('repository.ready', {
                repository: environment.WORKBENCH_REPOSITORY,
                revision: this.options.repository.revision,
            });
        }
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
        ).prepare(workbench, environment);
        this.runtime = await this.dependencies.runtimes
            .resolve(workbench.manifest.runtime)
            .prepare({
                workbench,
                workspaceDirectory,
                environment,
                assets: [
                    { path: workspaceDirectory, access: 'read-write' },
                    ...(this.repository
                        ? [
                              {
                                  path:
                                      workbench.manifest.runtime === 'local'
                                          ? join(workspaceDirectory, '.git')
                                          : this.repository.agentGitDirectory,
                                  access: 'read-write' as const,
                                  git: true,
                              },
                          ]
                        : []),
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
                ...(this.options.repository
                    ? {
                          repository: {
                              name: `${this.options.repository.owner}/${this.options.repository.name}`,
                              revision: this.options.repository.revision,
                              delivery: this.options.repository.delivery,
                          },
                      }
                    : {}),
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
            Promise.resolve().then(async () => {
                await this.runtime?.cleanup();
            }),
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
