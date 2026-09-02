import { ConnectionInspector } from '../connections/inspector.js';
import { ConnectionStore } from '../connections/store.js';
import { ModelRouter, type ResolvedRunnerConfiguration } from '../models/index.js';
import { RunnerRegistry } from '../runners/registry.js';
import type { PreparedRunner } from '../runners/runner.js';
import {
    normalizeRunnerInput,
    type RunnerInput,
    type RunnerInputDelivery,
    type RunnerPermissionDecision,
    type RunnerPermissionRequest,
    type RunnerSession,
} from '../runners/session.js';
import { type PreparedRuntime, RuntimeRegistry } from '../runtimes/index.js';
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
    send(task: RunnerInput): Promise<void>;
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
    dependencies?: InteractiveRunDependencies;
    workspaces?: WorkbenchWorkspaceBinding[];
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
        if (workbench.manifest.runtime !== 'local') {
            throw new Error('Interactive mode currently requires runtime: local');
        }
        const registry = this.dependencies.registry ?? RunnerRegistry.standard();
        const emitter = new RunEvents({
            runId: this.options.runId ?? RunStore.createId(),
            runner: workbench.manifest.runner,
            onEvent: this.options.onEvent,
            ...(this.dependencies.now ? { now: this.dependencies.now } : {}),
        });
        let session: RunnerSession | undefined;
        try {
            const preparedRunner = await registry.prepare(workbench, environment);
            const { configuration, preflight } = await this.prepare(
                preparedRunner,
                environment
            );
            const adapter = registry.session(workbench.manifest.runner);
            await emitter.emit('run.started', {
                workbench: workbench.manifest.name,
                workbench_version: workbench.manifest.version,
                model: configuration.model,
                model_route: {
                    canonical: configuration.canonicalModel,
                    provider: configuration.provider,
                    ...(configuration.catalogVersion
                        ? { catalog_version: configuration.catalogVersion }
                        : {}),
                },
                runtime: workbench.manifest.runtime,
                workspace: this.options.resolved.workspaceDirectory,
                interactive: true,
                workspaces: this.options.workspaces ?? [],
            });
            session = await adapter.start({
                workbench,
                workspaceDirectory: this.options.resolved.workspaceDirectory,
                environment: new ModelRouter().environmentForRoute(
                    workbench,
                    configuration,
                    environment
                ),
                configuration,
                host: {
                    emit: async (event) => {
                        await emitter.emitDraft(event);
                    },
                    requestPermission: (request) =>
                        this.requestPermission(emitter, request),
                },
            });
            await emitter.emit('run.ready', {
                runner: preflight.runner.name,
                tools: preflight.tools.map((tool) => tool.name),
                enabled_mcps: preflight.enabledMcps,
                disabled_mcps: preflight.disabledMcps,
                workspaces: this.options.workspaces ?? [],
            });
            return new HostedInteractiveSession(session, emitter);
        } catch (error) {
            await session?.close().catch(() => undefined);
            await emitter
                .emit('run.failed', { message: InteractiveRun.errorMessage(error) })
                .catch(() => undefined);
            throw error;
        }
    }

    private async prepare(
        preparedRunner: PreparedRunner,
        environment: Record<string, string | undefined>
    ): Promise<{
        configuration: ResolvedRunnerConfiguration;
        preflight: PreflightResult;
    }> {
        const { workbench } = this.options.resolved;
        let preparedRuntime: PreparedRuntime | undefined;
        let configuration: ResolvedRunnerConfiguration | undefined;
        let preflight: PreflightResult | undefined;
        let preparationError: unknown;
        try {
            preparedRuntime = await RuntimeRegistry.standard({
                findExecutable: this.dependencies.findExecutable ?? Bun.which,
            })
                .resolve('local')
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
                    ],
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
        const cleanup = await Promise.allSettled([
            preparedRuntime?.cleanup(),
            preparedRunner.cleanup(),
        ]);
        if (preparationError) throw preparationError;
        const cleanupFailure = cleanup.find(
            (result): result is PromiseRejectedResult => result.status === 'rejected'
        );
        if (cleanupFailure) throw cleanupFailure.reason;
        if (!configuration || !preflight) {
            throw new Error('Interactive Workbench preparation did not complete');
        }
        return { configuration, preflight };
    }

    private async requestPermission(
        emitter: RunEvents,
        request: RunnerPermissionRequest
    ): Promise<RunnerPermissionDecision> {
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
        return this.options.onPermission
            ? await this.options.onPermission(request)
            : 'reject';
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

    constructor(runner: RunnerSession, emitter: RunEvents) {
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

    send(task: RunnerInput): Promise<void> {
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
        const active = this.executeTurn(normalized, turn);
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
        await this.finish('run.completed', { interactive: true });
    }

    async cancel(reason?: string): Promise<void> {
        await this.finish('run.cancelled', {
            ...(reason?.trim() ? { reason: reason.trim() } : {}),
        });
    }

    private async executeTurn(task: RunnerInput, turn: number): Promise<void> {
        await this.emitter.emit('turn.started', { index: turn });
        try {
            const result = await this.runner.prompt(task);
            await this.emitter.emit('turn.completed', {
                index: turn,
                reason: this.cancellationRequested
                    ? 'cancelled'
                    : (result.reason ?? 'completed'),
            });
        } catch (error) {
            if (this.cancellationRequested) {
                await this.emitter.emit('turn.completed', {
                    index: turn,
                    reason: 'cancelled',
                });
                return;
            }
            this.terminal = true;
            this.closed = true;
            await this.runner.close().catch(() => undefined);
            await this.emitter.emit('run.failed', {
                message: error instanceof Error ? error.message : String(error),
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
            await this.runner.close();
            if (!this.terminal) {
                this.terminal = true;
                await this.emitter.emit(type, data);
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
}
