import { ConnectionInspector } from '../connections/inspector.js';
import { ConnectionStore } from '../connections/store.js';
import type { ResolvedRunnerConfiguration } from '../models/index.js';
import { RunnerRegistry } from '../runners/registry.js';
import type { PreparedRunner } from '../runners/runner.js';
import {
    normalizeRunnerInput,
    type RunnerInput,
    type RunnerInputDelivery,
    type RunnerPermissionDecision,
    type RunnerPermissionRequest,
    type RunnerQuestionRequest,
    type RunnerQuestionResponse,
    type RunnerSession,
    type RunnerSessionContext,
} from '../runners/session.js';
import {
    type PreparedRuntime,
    type RuntimeInfrastructureMetadata,
    RuntimeRegistry,
} from '../runtimes/index.js';
import type { WorkbenchWorkspaceBinding } from '../types.js';
import type {
    PreflightResult,
    ResolvedWorkbenchReference,
} from '../workbench/index.js';
import { RunEvents, type WorkbenchEvent } from './events.js';
import { RunStore } from './store.js';

export interface InteractiveRunSession {
    readonly runId: string;
    readonly runnerSessionId: string | undefined;
    readonly busy: boolean;
    send(task: RunnerInput, inputId?: string): Promise<void>;
    steer(task: RunnerInput): Promise<RunnerInputDelivery>;
    cancelTurn(): Promise<void>;
    recordInput(
        type: 'input.accepted' | 'input.queued' | 'input.delivered' | 'input.rejected',
        data: Record<string, unknown>
    ): Promise<void>;
    close(): Promise<void>;
    cancel(reason?: string): Promise<void>;
}

export interface InteractiveRunDependencies {
    env?: Record<string, string | undefined>;
    findExecutable?: (name: string) => string | null;
    registry?: RunnerRegistry;
    runtimeRegistry?: RuntimeRegistry;
    now?: () => Date;
}

export interface InteractiveRunOptions {
    runId?: string;
    resolved: ResolvedWorkbenchReference;
    reference?: string;
    home?: string;
    onEvent: (event: WorkbenchEvent) => Promise<void> | void;
    onPermission?: (
        request: RunnerPermissionRequest
    ) => Promise<RunnerPermissionDecision> | RunnerPermissionDecision;
    onQuestion?: (
        request: RunnerQuestionRequest
    ) => Promise<RunnerQuestionResponse> | RunnerQuestionResponse;
    dependencies?: InteractiveRunDependencies;
    workspaces?: WorkbenchWorkspaceBinding[];
    allowHostDocker?: boolean;
    session?: RunnerSessionContext;
    interactive?: boolean;
}

export class InteractiveRun {
    private readonly dependencies: InteractiveRunDependencies;

    private constructor(private readonly options: InteractiveRunOptions) {
        this.dependencies = options.dependencies ?? {};
    }

    static start(options: InteractiveRunOptions): Promise<InteractiveRunSession> {
        return new InteractiveRun(options).start();
    }

    private async start(): Promise<InteractiveRunSession> {
        const { workbench } = this.options.resolved;
        const environment = this.dependencies.env ?? process.env;
        const registry = this.dependencies.registry ?? RunnerRegistry.standard();
        const emitter = new RunEvents({
            runId: this.options.runId ?? RunStore.createId(),
            runner: workbench.manifest.runner,
            onEvent: this.options.onEvent,
            ...(this.dependencies.now ? { now: this.dependencies.now } : {}),
        });
        let session: RunnerSession | undefined;
        let preparedRunner: PreparedRunner | undefined;
        let preparedRuntime: PreparedRuntime | undefined;
        try {
            preparedRunner = await registry.prepare(workbench, environment);
            const prepared = await this.prepare(
                preparedRunner,
                environment,
                emitter.runId
            );
            preparedRuntime = prepared.runtime;
            await emitter.emit('run.started', {
                workbench: workbench.manifest.name,
                workbench_version: workbench.manifest.version,
                model: prepared.configuration.model,
                model_route: {
                    canonical: prepared.configuration.canonicalModel,
                    provider: prepared.configuration.provider,
                    ...(prepared.configuration.catalogVersion
                        ? { catalog_version: prepared.configuration.catalogVersion }
                        : {}),
                },
                runtime: workbench.manifest.runtime,
                workspace: this.options.resolved.workspaceDirectory,
                ...(this.options.interactive ? { interactive: true } : {}),
                workspaces: this.options.workspaces ?? [],
                ...(workbench.manifest.docker?.engine
                    ? {
                          docker_engine: workbench.manifest.docker.engine.mode,
                          host_docker_authorized: this.options.allowHostDocker ?? false,
                      }
                    : {}),
            });
            session = await preparedRunner.startSession(preparedRuntime, {
                configuration: prepared.configuration,
                host: {
                    emit: async (event) => {
                        await emitter.emitDraft(event);
                    },
                    requestPermission: (request) =>
                        this.requestPermission(emitter, request),
                    requestQuestion: (request) =>
                        this.requestQuestion(emitter, request),
                },
                ...(this.options.session
                    ? {
                          session: {
                              ...this.options.session,
                              directory: preparedRuntime.pathFor(
                                  this.options.session.directory
                              ),
                          },
                      }
                    : {}),
            });
            await emitter.emit('run.ready', {
                runner: prepared.preflight.runner.name,
                tools: prepared.preflight.tools.map((tool) => tool.name),
                enabled_mcps: prepared.preflight.enabledMcps,
                disabled_mcps: prepared.preflight.disabledMcps,
                workspaces: preparedRuntime.workspaces,
                ...(prepared.preflight.dockerEngine
                    ? { docker_engine: prepared.preflight.dockerEngine }
                    : {}),
            });
            return new HostedInteractiveSession(
                session,
                emitter,
                this.options.interactive ?? false,
                () => this.cleanup(preparedRuntime, preparedRunner)
            );
        } catch (error) {
            await session?.close().catch(() => undefined);
            const infrastructure = await this.cleanup(
                preparedRuntime,
                preparedRunner
            ).catch(() => undefined);
            await emitter
                .emit('run.failed', {
                    message: InteractiveRun.errorMessage(error),
                    ...(infrastructure ? { infrastructure } : {}),
                })
                .catch(() => undefined);
            throw error;
        }
    }

    private async prepare(
        preparedRunner: PreparedRunner,
        environment: Record<string, string | undefined>,
        runId: string
    ): Promise<{
        configuration: ResolvedRunnerConfiguration;
        preflight: PreflightResult;
        runtime: PreparedRuntime;
    }> {
        const { workbench } = this.options.resolved;
        let preparedRuntime: PreparedRuntime | undefined;
        let configuration: ResolvedRunnerConfiguration | undefined;
        let preflight: PreflightResult | undefined;
        let preparationError: unknown;
        try {
            const runtimes =
                this.dependencies.runtimeRegistry ??
                RuntimeRegistry.standard({
                    findExecutable: this.dependencies.findExecutable ?? Bun.which,
                });
            preparedRuntime = await runtimes
                .resolve(workbench.manifest.runtime)
                .prepare({
                    workbench,
                    workspaceDirectory: this.options.resolved.workspaceDirectory,
                    environment,
                    assets: [
                        {
                            path: this.options.resolved.workspaceDirectory,
                            access: 'read-write',
                        },
                        {
                            path: workbench.packageDirectory,
                            access: 'read-only',
                        },
                        ...(this.options.workspaces ?? []).map((workspace) => ({
                            path: workspace.path,
                            access: workspace.access,
                            workspace: workspace.name,
                        })),
                        ...preparedRunner.assets,
                        ...(this.options.session
                            ? [
                                  {
                                      path: this.options.session.directory,
                                      access: 'read-write' as const,
                                  },
                              ]
                            : []),
                    ],
                    authorizations: {
                        hostDocker: this.options.allowHostDocker ?? false,
                    },
                    purpose: 'run',
                    ...(this.options.home
                        ? {
                              run: {
                                  id: runId,
                                  scope: RunStore.scope(this.options.home),
                              },
                          }
                        : {}),
                });
            preflight = await preparedRuntime.preflight();
            configuration = await new ConnectionInspector({
                workbench,
                runtime: preparedRuntime,
                runner: preparedRunner,
                reference: this.options.reference ?? workbench.manifest.name,
                ...(this.options.home
                    ? { store: new ConnectionStore(this.options.home) }
                    : {}),
            }).require();
        } catch (error) {
            preparationError = error;
        }
        if (preparationError) {
            await preparedRuntime?.cleanup().catch(() => undefined);
            throw preparationError;
        }
        if (!preparedRuntime || !configuration || !preflight) {
            throw new Error('Interactive Workbench preparation did not complete');
        }
        return {
            configuration,
            preflight,
            runtime: preparedRuntime,
        };
    }

    private async cleanup(
        runtime: PreparedRuntime | undefined,
        runner: PreparedRunner | undefined
    ): Promise<RuntimeInfrastructureMetadata | undefined> {
        const results = await Promise.allSettled([
            runtime?.cleanup(),
            runner?.cleanup(),
        ]);
        const infrastructure = await runtime?.infrastructure?.().catch(() => undefined);
        const failure = results.find(
            (result): result is PromiseRejectedResult => result.status === 'rejected'
        );
        if (failure) throw failure.reason;
        return infrastructure;
    }

    private async requestPermission(
        emitter: RunEvents,
        request: RunnerPermissionRequest
    ): Promise<RunnerPermissionDecision> {
        const decision = this.options.onPermission
            ? this.options.onPermission(request)
            : Promise.resolve('reject' as const);
        await emitter.emit('input.requested', {
            id: request.id,
            kind: 'permission',
            action: request.action,
            resources: request.resources,
            message: request.message,
            options: [
                'allow_once',
                ...(request.allowAlways ? ['allow_always'] : []),
                'reject',
            ],
        });
        return decision;
    }

    private async requestQuestion(
        emitter: RunEvents,
        request: RunnerQuestionRequest
    ): Promise<RunnerQuestionResponse> {
        const response = this.options.onQuestion
            ? this.options.onQuestion(request)
            : Promise.resolve({ outcome: 'rejected' as const });
        await emitter.emit('question.requested', {
            id: request.id,
            questions: request.questions.map((question) => ({
                question: question.question,
                ...(question.header ? { header: question.header } : {}),
                options: question.options.map((option) => ({
                    label: option.label,
                    ...(option.description ? { description: option.description } : {}),
                })),
                multiple: question.multiple,
                custom: question.custom,
            })),
        });
        const resolved = await response;
        await emitter.emit(
            resolved.outcome === 'answered' ? 'question.answered' : 'question.rejected',
            resolved.outcome === 'answered'
                ? { id: request.id, answer_count: resolved.answers.length }
                : { id: request.id }
        );
        return resolved;
    }

    private static errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}

class HostedInteractiveSession implements InteractiveRunSession {
    readonly runId: string;
    private readonly runner: RunnerSession;
    private readonly emitter: RunEvents;
    private turn = 0;
    private working = false;
    private closed = false;
    private terminal = false;
    private cancellationRequested = false;
    private activeTurn: Promise<void> | undefined;
    private releasePromise:
        | Promise<RuntimeInfrastructureMetadata | undefined>
        | undefined;

    constructor(
        runner: RunnerSession,
        emitter: RunEvents,
        private readonly interactive: boolean,
        private readonly cleanup: () => Promise<
            RuntimeInfrastructureMetadata | undefined
        >
    ) {
        this.runner = runner;
        this.emitter = emitter;
        this.runId = emitter.runId;
    }

    get runnerSessionId(): string | undefined {
        return this.runner.id;
    }

    get busy(): boolean {
        return this.working;
    }

    send(task: RunnerInput, inputId?: string): Promise<void> {
        let normalized: ReturnType<typeof normalizeRunnerInput>;
        try {
            normalized = normalizeRunnerInput(task);
        } catch (error) {
            return Promise.reject(error);
        }
        if (this.closed || this.terminal) {
            return Promise.reject(new Error('session is closed'));
        }
        if (this.working) {
            return Promise.reject(new Error('Workbench is still responding'));
        }
        this.working = true;
        this.cancellationRequested = false;
        this.turn += 1;
        const turn = this.turn;
        const active = this.executeTurn(normalized, turn, inputId);
        this.activeTurn = active;
        return active.finally(() => {
            if (this.activeTurn === active) this.activeTurn = undefined;
            this.working = false;
        });
    }

    async cancelTurn(): Promise<void> {
        if (this.closed || !this.working) return;
        this.cancellationRequested = true;
        await this.runner.cancelTurn();
        await this.activeTurn?.catch(() => {});
    }

    async steer(task: RunnerInput): Promise<RunnerInputDelivery> {
        const normalized = normalizeRunnerInput(task);
        if (!this.busy || !this.runner.steer) {
            throw new Error('Runner does not accept steering for this turn');
        }
        return this.runner.steer(normalized);
    }

    async recordInput(
        type: 'input.accepted' | 'input.queued' | 'input.delivered' | 'input.rejected',
        data: Record<string, unknown>
    ): Promise<void> {
        await this.emitter.emit(type, data);
    }

    async close(): Promise<void> {
        await this.finish('run.completed', {
            ...(this.interactive ? { interactive: true } : {}),
        });
    }

    async cancel(reason?: string): Promise<void> {
        await this.finish('run.cancelled', {
            ...(reason?.trim() ? { reason: reason.trim() } : {}),
        });
    }

    private async executeTurn(
        task: RunnerInput,
        turn: number,
        inputId?: string
    ): Promise<void> {
        await this.emitter.emit('turn.started', {
            index: turn,
            ...(inputId ? { input_id: inputId } : {}),
        });
        try {
            const result = await this.runner.prompt(task);
            await this.emitter.emit('turn.completed', {
                index: turn,
                reason: this.cancellationRequested
                    ? 'cancelled'
                    : (result.reason ?? 'completed'),
                ...(inputId ? { input_id: inputId } : {}),
            });
        } catch (error) {
            if (this.cancellationRequested) {
                await this.emitter.emit('turn.completed', {
                    index: turn,
                    reason: 'cancelled',
                    ...(inputId ? { input_id: inputId } : {}),
                });
                return;
            }
            this.terminal = true;
            this.closed = true;
            const infrastructure = await this.releaseResources().catch(() => undefined);
            await this.emitter.emit('run.failed', {
                message: error instanceof Error ? error.message : String(error),
                ...(infrastructure ? { infrastructure } : {}),
            });
            throw error;
        }
    }

    private async finish(
        type: 'run.completed' | 'run.cancelled',
        data: Record<string, unknown>
    ): Promise<void> {
        if (this.closed) return;
        if (this.working) await this.cancelTurn();
        this.closed = true;
        try {
            const infrastructure = await this.releaseResources();
            if (!this.terminal) {
                this.terminal = true;
                await this.emitter.emit(type, {
                    ...data,
                    ...(infrastructure ? { infrastructure } : {}),
                });
            }
        } catch (error) {
            if (!this.terminal) {
                this.terminal = true;
                await this.emitter.emit('run.failed', {
                    message: error instanceof Error ? error.message : String(error),
                });
            }
            throw error;
        }
    }

    private releaseResources(): Promise<RuntimeInfrastructureMetadata | undefined> {
        if (this.releasePromise) return this.releasePromise;
        this.releasePromise = (async () => {
            let failure: unknown;
            try {
                await this.runner.close();
            } catch (error) {
                failure = error;
            }
            let infrastructure: RuntimeInfrastructureMetadata | undefined;
            try {
                infrastructure = await this.cleanup();
            } catch (error) {
                failure ??= error;
            }
            if (failure) throw failure;
            return infrastructure;
        })();
        return this.releasePromise;
    }
}
