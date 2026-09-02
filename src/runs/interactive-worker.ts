import type {
    RunnerPermissionDecision,
    RunnerPermissionRequest,
} from '../runners/session.js';
import type { ResolvedWorkbench } from '../types.js';
import { Workbench } from '../workbench/workbench.js';
import { RunControl, type RunControlRequest } from './control.js';
import { RunEvents } from './events.js';
import {
    InteractiveRun,
    type InteractiveRunDependencies,
    type InteractiveRunSession,
} from './interactive-run.js';
import { RunStore } from './store.js';

export interface ExecuteInteractiveRunOptions {
    environment?: Record<string, string | undefined>;
}

export interface InteractiveRunWorkerDependencies extends InteractiveRunDependencies {
    loadWorkbench?: (path: string) => Promise<ResolvedWorkbench>;
}

export class InteractiveRunWorker {
    private readonly store: RunStore;
    private readonly control: RunControl;
    private readonly receiveAbort = new AbortController();
    private readonly permissions = new Map<
        string,
        (decision: RunnerPermissionDecision) => void
    >();
    private readonly queued: RunControlRequest[] = [];
    private session: InteractiveRunSession | undefined;
    private activeTurn: Promise<void> | undefined;
    private drainPaused = false;
    private terminal = false;
    private exitCode = 0;
    private readonly dependencies: InteractiveRunWorkerDependencies;

    constructor(
        private readonly home: string,
        private readonly runId: string,
        dependencies: InteractiveRunWorkerDependencies = {}
    ) {
        this.store = new RunStore(home);
        this.control = new RunControl(home, runId);
        this.dependencies = dependencies;
    }

    async execute(options: ExecuteInteractiveRunOptions): Promise<number> {
        const metadata = await this.store.read(this.runId);
        try {
            const request = await this.store.takeRequest(this.runId);
            await this.store.update(this.runId, {
                status: 'running',
                started_at: new Date().toISOString(),
                pid: process.pid,
            });
            const workbench = this.dependencies.loadWorkbench
                ? await this.dependencies.loadWorkbench(request.workbench_path)
                : await Workbench.load(request.workbench_path);
            this.session = await InteractiveRun.start({
                runId: this.runId,
                resolved: {
                    workbench,
                    workspaceDirectory: request.workspace,
                    cleanup: async () => {},
                    ...(metadata.registry ? { registry: metadata.registry } : {}),
                },
                reference: request.reference ?? metadata.workbench,
                home: this.home,
                workspaces: request.workspaces ?? [],
                onEvent: (event) => this.store.appendEvent(this.runId, event),
                onPermission: (permission) => this.waitForPermission(permission),
                dependencies: {
                    env: options.environment ?? process.env,
                    ...(this.dependencies.findExecutable
                        ? { findExecutable: this.dependencies.findExecutable }
                        : {}),
                    ...(this.dependencies.registry
                        ? { registry: this.dependencies.registry }
                        : {}),
                    ...(this.dependencies.now ? { now: this.dependencies.now } : {}),
                },
            });
            if (this.session.runnerSessionId) {
                await this.store.update(this.runId, {
                    runner_session_id: this.session.runnerSessionId,
                });
            }
            await this.controlLoop();
            return this.exitCode;
        } catch (error) {
            await this.fail(error);
            return 1;
        } finally {
            this.receiveAbort.abort();
            this.rejectPermissions();
            await this.control
                .rejectPending(
                    'run_terminal',
                    'Workbench run is no longer accepting input'
                )
                .catch(() => {});
        }
    }

    private async controlLoop(): Promise<void> {
        while (!this.terminal) {
            const request = await this.control.receive(this.receiveAbort.signal);
            if (!request) continue;
            await this.handle(request);
        }
    }

    private async handle(request: RunControlRequest): Promise<void> {
        try {
            if (request.kind === 'send') return await this.send(request, false);
            if (request.kind === 'follow_up') return await this.send(request, true);
            if (request.kind === 'steer') return await this.steer(request);
            if (request.kind === 'cancel_turn') {
                return await this.cancelTurn(request);
            }
            if (request.kind === 'permission') {
                return await this.answerPermission(request);
            }
            if (request.kind === 'close') return await this.close(request, false);
            await this.close(request, true);
        } catch (error) {
            await this.reject(request, 'control_failed', errorMessage(error));
        }
    }

    private async send(request: RunControlRequest, followUp: boolean): Promise<void> {
        if (!request.input) {
            return this.reject(request, 'input_invalid', 'Workbench input is missing');
        }
        if (this.terminal) {
            return this.reject(
                request,
                'run_terminal',
                'Workbench run is no longer accepting input'
            );
        }
        if (this.activeTurn) {
            if (!followUp) {
                return this.reject(
                    request,
                    'turn_active',
                    'Workbench is still responding'
                );
            }
            await this.accept(request);
            this.queued.push(request);
            await this.session?.recordInput('input.queued', this.eventData(request));
            await this.control.resolve(request, {
                outcome: 'accepted',
                disposition: 'queued',
            });
            return;
        }
        await this.accept(request);
        await this.deliverTurn(request);
        await this.control.resolve(request, {
            outcome: 'accepted',
            disposition: 'delivered',
        });
    }

    private async steer(request: RunControlRequest): Promise<void> {
        const session = this.requireSession();
        if (!request.input) {
            return this.reject(request, 'input_invalid', 'Workbench input is missing');
        }
        if (!this.activeTurn || !session.busy) {
            return this.reject(request, 'turn_idle', 'No Workbench turn is active');
        }
        await this.accept(request);
        const delivery = await session.steer(request.input);
        await session.recordInput('input.queued', this.eventData(request));
        await this.control.resolve(request, {
            outcome: 'accepted',
            disposition: 'queued',
        });
        void delivery.delivered
            .then(
                () => session.recordInput('input.delivered', this.eventData(request)),
                (error) =>
                    session.recordInput('input.rejected', {
                        ...this.eventData(request),
                        code: 'steering_not_delivered',
                        message: errorMessage(error),
                    })
            )
            .catch((error) => this.fail(error));
    }

    private async cancelTurn(request: RunControlRequest): Promise<void> {
        const session = this.requireSession();
        if (!this.activeTurn || !session.busy) {
            await this.accept(request);
            await this.control.resolve(request, {
                outcome: 'accepted',
                disposition: 'already_idle',
            });
            return;
        }
        await this.accept(request);
        this.drainPaused = true;
        try {
            await session.cancelTurn();
            await session.recordInput('input.delivered', this.eventData(request));
            await this.control.resolve(request, {
                outcome: 'accepted',
                disposition: 'cancelled',
            });
        } finally {
            this.drainPaused = false;
            if (!this.activeTurn) await this.deliverNext();
        }
    }

    private async answerPermission(request: RunControlRequest): Promise<void> {
        const permission = request.permission;
        const resolve = permission ? this.permissions.get(permission.id) : undefined;
        if (!permission || !resolve) {
            return this.reject(
                request,
                'permission_unavailable',
                'Permission request is no longer active'
            );
        }
        await this.accept(request);
        this.permissions.delete(permission.id);
        resolve(permission.decision);
        await this.session?.recordInput('input.delivered', this.eventData(request));
        await this.control.resolve(request, {
            outcome: 'accepted',
            disposition: 'delivered',
        });
    }

    private async close(request: RunControlRequest, cancelled: boolean): Promise<void> {
        if (this.terminal) {
            return this.reject(
                request,
                'run_terminal',
                'Workbench run is already terminal'
            );
        }
        await this.accept(request);
        this.terminal = true;
        this.receiveAbort.abort();
        this.rejectPermissions();
        await this.rejectQueued('run_terminal');
        try {
            if (cancelled) await this.session?.cancel(request.reason);
            else await this.session?.close();
        } catch (error) {
            this.exitCode = 1;
            await this.store.update(this.runId, {
                status: 'failed',
                exit_code: 1,
                finished_at: new Date().toISOString(),
            });
            throw error;
        }
        this.exitCode = cancelled ? 130 : 0;
        await this.store.update(this.runId, {
            status: cancelled ? 'cancelled' : 'completed',
            exit_code: this.exitCode,
            finished_at: new Date().toISOString(),
        });
        await this.control.resolve(request, {
            outcome: 'accepted',
            disposition: cancelled ? 'cancelled' : 'closed',
        });
    }

    private async deliverTurn(request: RunControlRequest): Promise<void> {
        const session = this.requireSession();
        if (!request.input) throw new Error('Workbench input is missing');
        await session.recordInput('input.delivered', this.eventData(request));
        const turn = session.send(request.input);
        this.activeTurn = turn;
        void turn
            .then(
                () => this.finishTurn(turn),
                (error) => this.fail(error)
            )
            .catch((error) => this.fail(error));
    }

    private async finishTurn(turn: Promise<void>): Promise<void> {
        if (this.activeTurn !== turn) return;
        this.activeTurn = undefined;
        if (this.terminal || this.drainPaused) return;
        await this.deliverNext();
    }

    private async deliverNext(): Promise<void> {
        if (this.terminal || this.activeTurn) return;
        const next = this.queued.shift();
        if (next) await this.deliverTurn(next);
    }

    private async accept(request: RunControlRequest): Promise<void> {
        await this.session?.recordInput('input.accepted', this.eventData(request));
    }

    private async reject(
        request: RunControlRequest,
        code: string,
        message: string
    ): Promise<void> {
        await this.session?.recordInput('input.rejected', {
            ...this.eventData(request),
            code,
        });
        await this.control.resolve(request, {
            outcome: 'rejected',
            code,
            message,
        });
    }

    private async rejectQueued(code: string): Promise<void> {
        for (const request of this.queued.splice(0)) {
            await this.session?.recordInput('input.rejected', {
                ...this.eventData(request),
                code,
            });
        }
    }

    private waitForPermission(
        request: RunnerPermissionRequest
    ): Promise<RunnerPermissionDecision> {
        return new Promise((resolve) => {
            this.permissions.get(request.id)?.('reject');
            this.permissions.set(request.id, resolve);
        });
    }

    private rejectPermissions(): void {
        for (const resolve of this.permissions.values()) resolve('reject');
        this.permissions.clear();
    }

    private async fail(error: unknown): Promise<void> {
        if (this.terminal) return;
        this.terminal = true;
        this.exitCode = 1;
        this.receiveAbort.abort();
        this.rejectPermissions();
        await this.rejectQueued('run_failed').catch(() => {});
        await this.session?.close().catch(() => {});
        await this.recordFailure(error).catch(() => {});
        await this.store
            .update(this.runId, {
                status: 'failed',
                exit_code: 1,
                finished_at: new Date().toISOString(),
            })
            .catch(() => {});
    }

    private async recordFailure(error: unknown): Promise<void> {
        const run = await this.store.read(this.runId);
        const events = await this.store.readEvents(this.runId);
        const last = events.at(-1);
        if (
            last?.type === 'run.completed' ||
            last?.type === 'run.failed' ||
            last?.type === 'run.cancelled'
        ) {
            return;
        }
        const emitter = new RunEvents({
            runId: this.runId,
            runner: run.runner,
            initialSequence: last?.sequence ?? 0,
            onEvent: (event) => this.store.appendEvent(this.runId, event),
        });
        await emitter.emit('run.failed', { message: errorMessage(error) });
    }

    private requireSession(): InteractiveRunSession {
        if (!this.session) throw new Error('Interactive Workbench is not ready');
        return this.session;
    }

    private eventData(request: RunControlRequest): Record<string, unknown> {
        return { id: request.id, kind: request.kind };
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
