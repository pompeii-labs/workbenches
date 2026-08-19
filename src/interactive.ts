import type {
    WorkbenchEvent,
    WorkbenchEventDraft,
    WorkbenchEventType,
} from './execution.js';
import { OpenCodeSessionAdapter } from './opencode-session.js';
import { preflightWorkbench } from './preflight.js';
import type { ResolvedReference } from './references.js';
import { createRunId } from './run-store.js';
import {
    type RunnerPermissionDecision,
    type RunnerPermissionRequest,
    type RunnerSession,
    RunnerSessionRegistry,
} from './runner-session.js';

export interface InteractiveWorkbenchSession {
    readonly runId: string;
    readonly runnerSessionId: string | undefined;
    send(task: string): Promise<void>;
    cancelTurn(): Promise<void>;
    close(): Promise<void>;
}

export interface InteractiveDependencies {
    env?: Record<string, string | undefined>;
    findExecutable?: (name: string) => string | null;
    registry?: RunnerSessionRegistry;
    now?: () => Date;
}

export async function startInteractiveWorkbench(options: {
    resolved: ResolvedReference;
    onEvent: (event: WorkbenchEvent) => Promise<void> | void;
    onPermission?: (
        request: RunnerPermissionRequest
    ) => Promise<RunnerPermissionDecision> | RunnerPermissionDecision;
    dependencies?: InteractiveDependencies;
}): Promise<InteractiveWorkbenchSession> {
    const { workbench } = options.resolved;
    const dependencies = options.dependencies ?? {};
    const environment = dependencies.env ?? process.env;
    const preflight = preflightWorkbench(workbench, {
        env: environment,
        findExecutable: dependencies.findExecutable ?? Bun.which,
    });
    const registry =
        dependencies.registry ??
        new RunnerSessionRegistry([new OpenCodeSessionAdapter()]);
    const adapter = registry.resolve(workbench.manifest.runner);
    const emitter = new InteractiveEventEmitter({
        runId: createRunId(),
        runner: workbench.manifest.runner,
        onEvent: options.onEvent,
        ...(dependencies.now ? { now: dependencies.now } : {}),
    });
    let session: RunnerSession | undefined;
    try {
        await emitter.emit('run.started', {
            workbench: workbench.manifest.name,
            workbench_version: workbench.manifest.version,
            model: workbench.manifest.model,
            runtime: workbench.manifest.runtime,
            workspace: options.resolved.workspaceDirectory,
            interactive: true,
        });
        session = await adapter.start({
            workbench,
            workspaceDirectory: options.resolved.workspaceDirectory,
            environment,
            host: {
                emit: (event) => emitter.emitDraft(event),
                requestPermission: async (request) => {
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
                    return options.onPermission
                        ? await options.onPermission(request)
                        : 'reject';
                },
            },
        });
        await emitter.emit('run.ready', {
            runner: preflight.runner.name,
            tools: preflight.tools.map((tool) => tool.name),
            enabled_mcps: preflight.enabledMcps,
            disabled_mcps: preflight.disabledMcps,
        });
        return new HostedInteractiveSession(session, emitter);
    } catch (error) {
        await session?.close().catch(() => {});
        await emitter.emit('run.failed', { message: message(error) }).catch(() => {});
        throw error;
    }
}

class HostedInteractiveSession implements InteractiveWorkbenchSession {
    readonly runId: string;
    private readonly runner: RunnerSession;
    private readonly emitter: InteractiveEventEmitter;
    private turn = 0;
    private busy = false;
    private closed = false;
    private terminal = false;
    private cancellationRequested = false;
    private activeTurn: Promise<void> | undefined;

    constructor(runner: RunnerSession, emitter: InteractiveEventEmitter) {
        this.runner = runner;
        this.emitter = emitter;
        this.runId = emitter.runId;
    }

    get runnerSessionId(): string | undefined {
        return this.runner.id;
    }

    send(task: string): Promise<void> {
        const normalized = task.trim();
        if (!normalized) return Promise.reject(new Error('input must not be empty'));
        if (this.closed || this.terminal) {
            return Promise.reject(new Error('session is closed'));
        }
        if (this.busy) {
            return Promise.reject(new Error('Workbench is still responding'));
        }
        this.busy = true;
        this.cancellationRequested = false;
        this.turn += 1;
        const turn = this.turn;
        const active = this.executeTurn(normalized, turn);
        this.activeTurn = active;
        return active.finally(() => {
            if (this.activeTurn === active) this.activeTurn = undefined;
            this.busy = false;
        });
    }

    async cancelTurn(): Promise<void> {
        if (this.closed || !this.busy) return;
        this.cancellationRequested = true;
        await this.runner.cancelTurn();
        await this.activeTurn?.catch(() => {});
    }

    async close(): Promise<void> {
        if (this.closed) return;
        if (this.busy) await this.cancelTurn();
        this.closed = true;
        try {
            await this.runner.close();
            if (!this.terminal) {
                this.terminal = true;
                await this.emitter.emit('run.completed', { interactive: true });
            }
        } catch (error) {
            if (!this.terminal) {
                this.terminal = true;
                await this.emitter.emit('run.failed', { message: message(error) });
            }
            throw error;
        }
    }

    private async executeTurn(task: string, turn: number): Promise<void> {
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
            await this.runner.close().catch(() => {});
            await this.emitter.emit('run.failed', { message: message(error) });
            throw error;
        }
    }
}

class InteractiveEventEmitter {
    readonly runId: string;
    private readonly runner: string;
    private readonly onEvent: (event: WorkbenchEvent) => Promise<void> | void;
    private readonly now: () => Date;
    private sequence = 0;

    constructor(options: {
        runId: string;
        runner: string;
        onEvent: (event: WorkbenchEvent) => Promise<void> | void;
        now?: () => Date;
    }) {
        this.runId = options.runId;
        this.runner = options.runner;
        this.onEvent = options.onEvent;
        this.now = options.now ?? (() => new Date());
    }

    emitDraft(draft: WorkbenchEventDraft): Promise<void> {
        return this.emit(draft.type, draft.data);
    }

    async emit(type: WorkbenchEventType, data: unknown): Promise<void> {
        this.sequence += 1;
        await this.onEvent({
            protocol: 0,
            run_id: this.runId,
            sequence: this.sequence,
            timestamp: this.now().toISOString(),
            type,
            runner: this.runner,
            data,
        });
    }
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
