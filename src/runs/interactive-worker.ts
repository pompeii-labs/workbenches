import type { CatalogRegistryReference } from '../catalog/index.js';
import type { NormalizedRunnerInput } from '../runners/session.js';
import { normalizeRunnerInput } from '../runners/session.js';
import { SessionStore } from '../sessions/index.js';
import type { ResolvedWorkbench } from '../types.js';
import { Workbench } from '../workbench/workbench.js';
import { RunAudience } from './audience.js';
import { RunControl, type RunControlRequest } from './control.js';
import { RunEvents } from './events.js';
import {
    InteractiveRun,
    type InteractiveRunDependencies,
    type InteractiveRunSession,
} from './interactive-run.js';
import { NativeRequests } from './native-requests.js';
import { RunStore } from './store.js';

export interface ExecuteInteractiveRunOptions {
    environment?: Record<string, string | undefined>;
    signal?: AbortSignal;
}

export interface InteractiveRunWorkerDependencies extends InteractiveRunDependencies {
    loadWorkbench?: (path: string) => Promise<ResolvedWorkbench>;
    reportLaunch?: (
        registry: CatalogRegistryReference,
        idempotencyKey: string
    ) => Promise<void>;
}

export class InteractiveRunWorker {
    private readonly store: RunStore;
    private readonly sessions: SessionStore;
    private readonly control: RunControl;
    private readonly receiveAbort = new AbortController();
    private readonly audience = new RunAudience();
    private readonly nativeRequests = new NativeRequests();
    private readonly queued: RunControlRequest[] = [];
    private session: InteractiveRunSession | undefined;
    private activeTurn: Promise<void> | undefined;
    private termination: Promise<void> | undefined;
    private pendingShutdown: { cancelled: boolean; reason?: string } | undefined;
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
        this.sessions = new SessionStore(home);
        this.control = new RunControl(home, runId);
        this.dependencies = dependencies;
    }

    async execute(options: ExecuteInteractiveRunOptions): Promise<number> {
        const metadata = await this.store.read(this.runId);
        let launchReport = Promise.resolve();
        let controls = Promise.resolve();
        let abortRequested = options.signal?.aborted ?? false;
        const abort = () => {
            abortRequested = true;
            if (this.session) {
                void this.finish(true, 'interrupted').catch(() => {});
            }
        };
        options.signal?.addEventListener('abort', abort, { once: true });
        try {
            const request = await this.store.takeRequest(this.runId);
            this.audience.initialize(
                metadata.mode === 'interactive',
                request.task.trim().length > 0
            );
            await this.store.update(this.runId, {
                status: 'running',
                started_at: new Date().toISOString(),
                pid: process.pid,
            });
            controls = this.controlLoop().catch((error) => this.fail(error));
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
                allowHostDocker: request.allow_host_docker ?? false,
                interactive: metadata.mode === 'interactive',
                ...(request.session_id
                    ? {
                          session: {
                              id: request.session_id,
                              directory: this.sessions.nativeDirectory(
                                  request.session_id
                              ),
                              ...(request.native_session_id
                                  ? { nativeSessionId: request.native_session_id }
                                  : {}),
                          },
                      }
                    : {}),
                onEvent: (event) => this.store.appendEvent(this.runId, event),
                onPermission: (permission) =>
                    this.nativeRequests.waitForPermission(permission),
                onQuestion: (question) => this.nativeRequests.waitForQuestion(question),
                dependencies: {
                    env: options.environment ?? process.env,
                    ...(this.dependencies.findExecutable
                        ? { findExecutable: this.dependencies.findExecutable }
                        : {}),
                    ...(this.dependencies.registry
                        ? { registry: this.dependencies.registry }
                        : {}),
                    ...(this.dependencies.runtimeRegistry
                        ? { runtimeRegistry: this.dependencies.runtimeRegistry }
                        : {}),
                    ...(this.dependencies.now ? { now: this.dependencies.now } : {}),
                },
            });
            if (
                metadata.registry &&
                metadata.registry_event_id &&
                this.dependencies.reportLaunch
            ) {
                launchReport = this.dependencies
                    .reportLaunch(metadata.registry, metadata.registry_event_id)
                    .catch(() => {});
            }
            if (request.session_id && !this.session.runnerSessionId) {
                throw new Error(
                    `${metadata.runner} did not expose a resumable native session ID`
                );
            }
            if (this.session.runnerSessionId) {
                if (request.session_id) {
                    await this.sessions.update(request.session_id, {
                        native_session_id: this.session.runnerSessionId,
                        latest_run_id: this.runId,
                    });
                }
                await this.store.update(this.runId, {
                    runner_session_id: this.session.runnerSessionId,
                });
            }
            if (this.pendingShutdown) {
                await this.finish(
                    this.pendingShutdown.cancelled,
                    this.pendingShutdown.reason
                );
            } else if (abortRequested) {
                await this.finish(true, 'interrupted');
            } else if (request.task.trim()) {
                await this.deliverTurn(this.initialRequest(request.task));
            }
            await this.finishIfUnattended();
            await controls;
            await this.termination;
            return this.exitCode;
        } catch (error) {
            await this.fail(error);
            return 1;
        } finally {
            await launchReport;
            options.signal?.removeEventListener('abort', abort);
            this.receiveAbort.abort();
            await controls.catch(() => {});
            this.nativeRequests.rejectAll();
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
            if (request.kind === 'attach_client') {
                return await this.updateClient(request, true);
            }
            if (request.kind === 'detach_client') {
                return await this.updateClient(request, false);
            }
            if (request.kind === 'send') return await this.send(request, false);
            if (request.kind === 'follow_up') return await this.send(request, true);
            if (request.kind === 'steer') return await this.steer(request);
            if (request.kind === 'cancel_turn') {
                return await this.cancelTurn(request);
            }
            if (request.kind === 'permission') {
                return await this.answerPermission(request);
            }
            if (request.kind === 'question') {
                return await this.answerQuestion(request);
            }
            if (request.kind === 'close') return await this.close(request, false);
            await this.close(request, true);
        } catch (error) {
            await this.reject(request, 'control_failed', errorMessage(error));
        }
    }

    private async updateClient(
        request: RunControlRequest,
        attached: boolean
    ): Promise<void> {
        if (!request.client_id?.trim()) {
            return this.reject(request, 'client_invalid', 'Client ID is missing');
        }
        if (attached) this.audience.attach(request.client_id);
        else this.audience.detach(request.client_id);
        await this.control.resolve(request, {
            outcome: 'accepted',
            disposition: attached ? 'attached' : 'detached',
        });
        if (!attached && this.session) await this.finishIfUnattended();
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
        if (!this.session) {
            return this.reject(
                request,
                'run_starting',
                'Workbench session is still starting'
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
                () =>
                    session.recordInput(
                        'input.delivered',
                        this.eventData(request, true)
                    ),
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
        const session = this.session;
        if (!session) {
            await this.accept(request);
            await this.control.resolve(request, {
                outcome: 'accepted',
                disposition: 'already_idle',
            });
            return;
        }
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
            this.nativeRequests.rejectQuestions();
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
        return this.answerNativeRequest(
            request,
            Boolean(
                permission &&
                    this.nativeRequests.answerPermission(
                        permission.id,
                        permission.decision
                    )
            ),
            'permission'
        );
    }

    private async answerQuestion(request: RunControlRequest): Promise<void> {
        const question = request.question;
        return this.answerNativeRequest(
            request,
            Boolean(
                question &&
                    this.nativeRequests.answerQuestion(question.id, question.response)
            ),
            'question'
        );
    }

    private async answerNativeRequest(
        request: RunControlRequest,
        available: boolean,
        kind: 'permission' | 'question'
    ): Promise<void> {
        if (!available) {
            return this.reject(
                request,
                `${kind}_unavailable`,
                `${kind === 'permission' ? 'Permission' : 'Question'} request is no longer active`
            );
        }
        await this.accept(request);
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
        if (!this.session) {
            this.pendingShutdown = {
                cancelled,
                ...(request.reason ? { reason: request.reason } : {}),
            };
            await this.control.resolve(request, {
                outcome: 'accepted',
                disposition: cancelled ? 'cancelled' : 'closed',
            });
            return;
        }
        await this.finish(cancelled, request.reason);
        await this.control.resolve(request, {
            outcome: 'accepted',
            disposition: cancelled ? 'cancelled' : 'closed',
        });
    }

    private async deliverTurn(request: RunControlRequest): Promise<void> {
        const session = this.requireSession();
        if (!request.input) throw new Error('Workbench input is missing');
        await session.recordInput('input.delivered', this.eventData(request, true));
        const turn = session.send(request.input, request.id);
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
        await this.finishIfUnattended();
    }

    private async deliverNext(): Promise<void> {
        if (this.terminal || this.activeTurn) return;
        const next = this.queued.shift();
        if (next) await this.deliverTurn(next);
    }

    private async finishIfUnattended(): Promise<void> {
        if (
            this.terminal ||
            this.audience.keepsRunOpen ||
            this.activeTurn ||
            this.queued.length > 0
        ) {
            return;
        }
        await this.finish(false);
    }

    private async finish(cancelled: boolean, reason?: string): Promise<void> {
        if (this.termination) return this.termination;
        if (this.terminal) return;
        const termination = this.finishNow(cancelled, reason);
        this.termination = termination;
        return termination;
    }

    private async finishNow(cancelled: boolean, reason?: string): Promise<void> {
        this.terminal = true;
        this.receiveAbort.abort();
        this.nativeRequests.rejectAll();
        await this.rejectQueued('run_terminal');
        try {
            if (cancelled) await this.session?.cancel(reason);
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
    }

    private initialRequest(task: string): RunControlRequest {
        return {
            version: 1,
            id: `input_${this.runId}`,
            kind: 'send',
            submitted_at_ns: '0',
            input: normalizeRunnerInput(task) satisfies NormalizedRunnerInput,
        };
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

    private async fail(error: unknown): Promise<void> {
        if (this.terminal) return;
        this.terminal = true;
        this.exitCode = 1;
        this.receiveAbort.abort();
        this.nativeRequests.rejectAll();
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

    private eventData(
        request: RunControlRequest,
        includeInput = false
    ): Record<string, unknown> {
        return {
            id: request.id,
            kind: request.kind,
            ...(includeInput && request.input
                ? {
                      text: request.input.text,
                      images: request.input.images.map((image) => ({
                          mime_type: image.mimeType,
                          ...(image.name ? { name: image.name } : {}),
                      })),
                  }
                : {}),
        };
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
