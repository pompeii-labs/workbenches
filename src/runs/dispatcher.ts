import { basename } from 'node:path';

import { modelLabel } from '../models/index.js';
import type { WorkbenchWorkspaceBinding } from '../types.js';
import type { ResolvedWorkbenchReference } from '../workbench/index.js';
import { type RunHandle, StoredRunHandle } from './handle.js';
import { RunStore, type StoredRun } from './store.js';

export interface PrepareRunOptions {
    resolved: ResolvedWorkbenchReference;
    task?: string;
    mode: 'foreground' | 'detached' | 'interactive';
    workspaces?: WorkbenchWorkspaceBinding[];
    allowHostDocker?: boolean;
    reference?: string;
}

export interface DispatchRunOptions {
    id: string;
    cwd: string;
    environment?: Record<string, string | undefined>;
}

export class RunDispatcher {
    private readonly store: RunStore;

    constructor(private readonly home: string) {
        this.store = new RunStore(home);
    }

    prepare(options: PrepareRunOptions): Promise<StoredRun> {
        const workbench = options.resolved.workbench;
        return this.store.create({
            metadata: {
                workbench: workbench.manifest.name,
                workbench_version: workbench.manifest.version,
                runner: workbench.manifest.runner,
                model: modelLabel(workbench.manifest.model),
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
                task: options.task ?? '',
                workspaces: options.workspaces ?? [],
                allow_host_docker: options.allowHostDocker ?? false,
                reference: options.reference ?? workbench.manifest.name,
            },
        });
    }

    handle(id: string): RunHandle {
        return new StoredRunHandle(this.home, id);
    }

    async dispatch(options: DispatchRunOptions): Promise<number> {
        try {
            const child = Bun.spawn(this.workerCommand(options.id), {
                cwd: options.cwd,
                env: {
                    ...process.env,
                    ...options.environment,
                    WORKBENCH_HOME: this.home,
                },
                stdin: 'ignore',
                stdout: 'ignore',
                stderr: 'ignore',
                detached: true,
            });
            child.unref();
            await this.store.update(options.id, { pid: child.pid });
            return child.pid;
        } catch (error) {
            await this.store
                .update(options.id, {
                    status: 'failed',
                    exit_code: 1,
                    finished_at: new Date().toISOString(),
                })
                .catch(() => {});
            throw error;
        }
    }

    private workerCommand(id: string): string[] {
        const executable = process.execPath;
        const runningThroughBun = basename(executable).startsWith('bun');
        return runningThroughBun
            ? [executable, Bun.main, '__worker', this.home, id]
            : [executable, '__worker', this.home, id];
    }
}
