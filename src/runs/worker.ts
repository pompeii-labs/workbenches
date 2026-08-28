import { join } from 'node:path';

import type { CatalogRegistryReference } from '../catalog/index.js';
import { RegistryTelemetry } from '../registry/index.js';
import type { WorkbenchEvent } from './events.js';
import { RunStore, type StoredRun } from './store.js';
import { WorkbenchRun } from './workbench-run.js';

export interface ExecuteStoredRunOptions {
    id: string;
    environment?: Record<string, string | undefined>;
    render?: (event: WorkbenchEvent) => Promise<void> | void;
    signal?: AbortSignal;
}

export class RunWorker {
    private readonly store: RunStore;
    private readonly telemetry: RegistryTelemetry;

    constructor(private readonly home: string) {
        this.store = new RunStore(home);
        this.telemetry = new RegistryTelemetry({ home });
    }

    async execute(options: ExecuteStoredRunOptions): Promise<number> {
        const metadata = await this.store.read(options.id);
        const request = await this.store.takeRequest(options.id);
        const registry = metadata.registry;
        const registryEventId = metadata.registry_event_id;
        await this.store.update(options.id, {
            status: 'running',
            started_at: new Date().toISOString(),
            pid: process.pid,
        });
        try {
            const code = await WorkbenchRun.execute(
                {
                    workbenchPath: request.workbench_path,
                    workspaceDirectory: request.workspace,
                    task: request.task,
                    workspaces: request.workspaces ?? [],
                    allowHostDocker: request.allow_host_docker ?? false,
                    reference: request.reference ?? metadata.workbench,
                    home: this.home,
                    runId: options.id,
                    ...(options.signal ? { signal: options.signal } : {}),
                    onEvent: async (event) => {
                        await this.store.appendEvent(options.id, event);
                        await options.render?.(event);
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
            await this.store.update(options.id, {
                status:
                    code === 0 ? 'completed' : code === 130 ? 'cancelled' : 'failed',
                exit_code: code,
                finished_at: new Date().toISOString(),
            });
            return code;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const event = await this.appendFailure(metadata, message).catch(
                () => undefined
            );
            if (event) await options.render?.(event);
            await this.store
                .update(options.id, {
                    status: 'failed',
                    exit_code: 1,
                    finished_at: new Date().toISOString(),
                })
                .catch(() => {});
            return 1;
        }
    }

    async executeDetached(id: string): Promise<number> {
        const controller = new AbortController();
        const stopWatching = this.store.watchCancellation(id, () => controller.abort());
        try {
            return await this.execute({ id, signal: controller.signal });
        } finally {
            stopWatching();
            await this.store.clearCancellation(id);
        }
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
    ): Promise<WorkbenchEvent> {
        const events = await Bun.file(
            join(this.home, 'runs', run.id, 'events.ndjson')
        ).text();
        const event: WorkbenchEvent = {
            protocol: 0,
            run_id: run.id,
            sequence: events.split('\n').filter(Boolean).length + 1,
            timestamp: new Date().toISOString(),
            type: 'run.failed',
            runner: run.runner,
            data: { message },
        };
        await this.store.appendEvent(run.id, event);
        return event;
    }
}
