import { basename, join } from 'node:path';

import type { CatalogRegistryReference } from './catalog.js';
import type { WorkbenchEvent } from './execution.js';
import type { ResolvedReference } from './references.js';
import { runWorkbench } from './run.js';
import {
    appendRunEvent,
    clearStoredRunCancellation,
    createStoredRun,
    readStoredRun,
    type StoredRun,
    takeStoredRunRequest,
    updateStoredRun,
    watchStoredRunCancellation,
} from './run-store.js';
import { reportRegistryEvent, runTelemetryEnabled } from './telemetry.js';
import type { WorkbenchWorkspaceBinding } from './types.js';

export async function prepareStoredRun(options: {
    home: string;
    resolved: ResolvedReference;
    task: string;
    mode: 'foreground' | 'detached';
    workspaces?: WorkbenchWorkspaceBinding[];
    allowHostDocker?: boolean;
}): Promise<StoredRun> {
    const workbench = options.resolved.workbench;
    return createStoredRun({
        home: options.home,
        metadata: {
            workbench: workbench.manifest.name,
            workbench_version: workbench.manifest.version,
            runner: workbench.manifest.runner,
            model: workbench.manifest.model,
            workspace: options.resolved.workspaceDirectory,
            mode: options.mode,
            workspaces: options.workspaces ?? [],
            allow_host_docker: options.allowHostDocker ?? false,
            ...(options.resolved.registry
                ? {
                      registry: options.resolved.registry,
                      registry_event_id: crypto.randomUUID(),
                  }
                : {}),
        },
        request: {
            workbench_path: workbench.packageDirectory,
            workspace: options.resolved.workspaceDirectory,
            task: options.task,
            workspaces: options.workspaces ?? [],
            allow_host_docker: options.allowHostDocker ?? false,
        },
    });
}

export async function executeStoredRun(options: {
    home: string;
    id: string;
    environment?: Record<string, string | undefined>;
    render?: (event: WorkbenchEvent) => Promise<void> | void;
    signal?: AbortSignal;
}): Promise<number> {
    const metadata = await readStoredRun(options.home, options.id);
    const request = await takeStoredRunRequest(options.home, options.id);
    const registry = metadata.registry;
    const registryEventId = metadata.registry_event_id;
    await updateStoredRun(options.home, options.id, {
        status: 'running',
        started_at: new Date().toISOString(),
        pid: process.pid,
    });
    try {
        const code = await runWorkbench(
            {
                workbenchPath: request.workbench_path,
                workspaceDirectory: request.workspace,
                task: request.task,
                workspaces: request.workspaces ?? [],
                allowHostDocker: request.allow_host_docker ?? false,
                runId: options.id,
                ...(options.signal ? { signal: options.signal } : {}),
                onEvent: async (event) => {
                    await appendRunEvent(options.home, options.id, event);
                    await options.render?.(event);
                },
                ...(registry && registryEventId
                    ? {
                          onLaunch: () => {
                              return reportRunLaunch(
                                  options.home,
                                  registry,
                                  registryEventId
                              );
                          },
                      }
                    : {}),
            },
            options.environment ? { env: options.environment } : {}
        );
        await updateStoredRun(options.home, options.id, {
            status: code === 0 ? 'completed' : code === 130 ? 'cancelled' : 'failed',
            exit_code: code,
            finished_at: new Date().toISOString(),
        });
        return code;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const event = await appendSyntheticFailure(
            options.home,
            metadata,
            message
        ).catch(() => undefined);
        if (event) await options.render?.(event);
        await updateStoredRun(options.home, options.id, {
            status: 'failed',
            exit_code: 1,
            finished_at: new Date().toISOString(),
        }).catch(() => {});
        return 1;
    }
}

async function reportRunLaunch(
    home: string,
    registry: CatalogRegistryReference,
    idempotencyKey: string
): Promise<void> {
    if (!(await runTelemetryEnabled(home))) return;
    await reportRegistryEvent({
        registry,
        kind: 'run',
        idempotencyKey,
    });
}

export async function executeDetachedStoredRun(options: {
    home: string;
    id: string;
}): Promise<number> {
    const controller = new AbortController();
    const stopWatching = watchStoredRunCancellation(options.home, options.id, () =>
        controller.abort()
    );
    try {
        return await executeStoredRun({
            home: options.home,
            id: options.id,
            signal: controller.signal,
        });
    } finally {
        stopWatching();
        await clearStoredRunCancellation(options.home, options.id);
    }
}

export async function dispatchStoredRun(options: {
    home: string;
    id: string;
    cwd: string;
    environment?: Record<string, string | undefined>;
}): Promise<number> {
    const child = Bun.spawn(workerCommand(options.home, options.id), {
        cwd: options.cwd,
        env: {
            ...process.env,
            ...options.environment,
            WORKBENCH_HOME: options.home,
        },
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
        detached: true,
    });
    child.unref();
    await updateStoredRun(options.home, options.id, { pid: child.pid });
    return child.pid;
}

export function workerCommand(home: string, id: string): string[] {
    const executable = process.execPath;
    const runningThroughBun = basename(executable).startsWith('bun');
    return runningThroughBun
        ? [executable, Bun.main, '__worker', home, id]
        : [executable, '__worker', home, id];
}

async function appendSyntheticFailure(
    home: string,
    run: StoredRun,
    message: string
): Promise<WorkbenchEvent> {
    const events = await Bun.file(join(home, 'runs', run.id, 'events.ndjson')).text();
    const sequence = events.split('\n').filter(Boolean).length + 1;
    const event: WorkbenchEvent = {
        protocol: 0,
        run_id: run.id,
        sequence,
        timestamp: new Date().toISOString(),
        type: 'run.failed',
        runner: run.runner,
        data: { message },
    };
    await appendRunEvent(home, run.id, event);
    return event;
}
