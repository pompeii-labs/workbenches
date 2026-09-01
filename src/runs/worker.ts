import type { CatalogRegistryReference } from '../catalog/index.js';
import { RegistryTelemetry } from '../registry/index.js';
import { RunControl, type RunControlRequest } from './control.js';
import { RunEvents, type WorkbenchEvent } from './events.js';
import { InteractiveRunWorker } from './interactive-worker.js';
import { RunStore, type StoredRun } from './store.js';
import {
    WorkbenchRun,
    type WorkbenchRunDependencies,
    type WorkbenchRunOptions,
} from './workbench-run.js';

export interface ExecuteStoredRunOptions {
    id: string;
    environment?: Record<string, string | undefined>;
    signal?: AbortSignal;
}

interface RunWorkerDependencies {
    executeRun?: (
        options: WorkbenchRunOptions,
        dependencies?: WorkbenchRunDependencies
    ) => Promise<number>;
}

export class RunWorker {
    private readonly store: RunStore;
    private readonly telemetry: RegistryTelemetry;
    private readonly executeRun: NonNullable<RunWorkerDependencies['executeRun']>;

    constructor(
        private readonly home: string,
        dependencies: RunWorkerDependencies = {}
    ) {
        this.store = new RunStore(home);
        this.telemetry = new RegistryTelemetry({ home });
        this.executeRun = dependencies.executeRun ?? WorkbenchRun.execute;
    }

    async executeDispatched(id: string): Promise<number> {
        const run = await this.store.read(id);
        if (run.mode === 'interactive') {
            return new InteractiveRunWorker(this.home, id).execute({});
        }
        return this.executeDetached(id);
    }

    async execute(options: ExecuteStoredRunOptions): Promise<number> {
        const metadata = await this.store.read(options.id);
        const request = await this.store
            .takeRequest(options.id)
            .catch(async (error) => {
                await this.appendFailure(metadata, errorMessage(error)).catch(() => {});
                await this.store.update(options.id, {
                    status: 'failed',
                    exit_code: 1,
                    finished_at: new Date().toISOString(),
                });
                return undefined;
            });
        if (!request) return 1;
        const controller = new AbortController();
        const stopExternalSignal = this.forwardAbort(options.signal, controller);
        const stopWatching = this.store.watchCancellation(options.id, () =>
            controller.abort()
        );
        const controlAbort = new AbortController();
        const state = { terminal: false };
        const controls = this.processControls(
            options.id,
            controller,
            controlAbort.signal,
            state
        );
        const registry = metadata.registry;
        const registryEventId = metadata.registry_event_id;
        await this.store.update(options.id, {
            status: 'running',
            started_at: new Date().toISOString(),
            pid: process.pid,
        });
        try {
            const code = await this.executeRun(
                {
                    workbenchPath: request.workbench_path,
                    workspaceDirectory: request.workspace,
                    task: request.task,
                    workspaces: request.workspaces ?? [],
                    allowHostDocker: request.allow_host_docker ?? false,
                    reference: request.reference ?? metadata.workbench,
                    home: this.home,
                    runId: options.id,
                    signal: controller.signal,
                    onEvent: async (event) => {
                        await this.store.appendEvent(options.id, event);
                    },
                    ...(registry && registryEventId
                        ? {
                              onLaunch: () =>
                                  this.reportLaunch(registry, registryEventId),
                          }
                        : {}),
                },
                options.environment ? { env: options.environment } : {}
            );
            state.terminal = true;
            await this.store.update(options.id, {
                status:
                    code === 0 ? 'completed' : code === 130 ? 'cancelled' : 'failed',
                exit_code: code,
                finished_at: new Date().toISOString(),
            });
            return code;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await this.appendFailure(metadata, message).catch(() => undefined);
            state.terminal = true;
            await this.store
                .update(options.id, {
                    status: 'failed',
                    exit_code: 1,
                    finished_at: new Date().toISOString(),
                })
                .catch(() => {});
            return 1;
        } finally {
            state.terminal = true;
            controlAbort.abort();
            await controls.catch(() => {});
            await new RunControl(this.home, options.id)
                .rejectPending(
                    'run_terminal',
                    'Workbench run is no longer accepting input'
                )
                .catch(() => {});
            stopWatching();
            stopExternalSignal();
            await this.store.clearCancellation(options.id);
        }
    }

    async executeDetached(id: string): Promise<number> {
        return this.execute({ id });
    }

    private async reportLaunch(
        registry: CatalogRegistryReference,
        idempotencyKey: string
    ): Promise<void> {
        if (!(await this.telemetry.enabled())) return;
        await this.telemetry.report({
            registry,
            kind: 'run',
            idempotencyKey,
        });
    }

    private async appendFailure(
        run: StoredRun,
        message: string
    ): Promise<WorkbenchEvent | undefined> {
        const events = await this.store.readEvents(run.id);
        const last = events.at(-1);
        if (
            last?.type === 'run.completed' ||
            last?.type === 'run.failed' ||
            last?.type === 'run.cancelled'
        ) {
            return undefined;
        }
        return new RunEvents({
            runId: run.id,
            runner: run.runner,
            initialSequence: last?.sequence ?? 0,
            onEvent: (event) => this.store.appendEvent(run.id, event),
        }).emit('run.failed', { message });
    }

    private async processControls(
        id: string,
        controller: AbortController,
        signal: AbortSignal,
        state: { terminal: boolean }
    ): Promise<void> {
        const control = new RunControl(this.home, id);
        while (!signal.aborted) {
            const request = await control.receive(signal);
            if (!request) continue;
            if (state.terminal) {
                await this.rejectControl(control, request, 'run_terminal');
            } else if (request.kind === 'cancel') {
                controller.abort();
                await control.resolve(request, {
                    outcome: 'accepted',
                    disposition: 'cancellation_requested',
                });
            } else {
                await this.rejectControl(control, request, 'run_not_interactive');
            }
        }
    }

    private rejectControl(
        control: RunControl,
        request: RunControlRequest,
        code: string
    ): Promise<unknown> {
        return control.resolve(request, {
            outcome: 'rejected',
            code,
            message:
                code === 'run_terminal'
                    ? 'Workbench run is no longer accepting input'
                    : 'Workbench run is not interactive',
        });
    }

    private forwardAbort(
        signal: AbortSignal | undefined,
        controller: AbortController
    ): () => void {
        if (!signal) return () => {};
        const abort = () => controller.abort(signal.reason);
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
        return () => signal.removeEventListener('abort', abort);
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
