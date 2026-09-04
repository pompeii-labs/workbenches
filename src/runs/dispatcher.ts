import { basename } from 'node:path';

import { modelLabel } from '../models/index.js';
import { SessionStore, type StoredSession } from '../sessions/index.js';
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
    session?: StoredSession;
}

export interface DispatchRunOptions {
    id: string;
    cwd: string;
    environment?: Record<string, string | undefined>;
}

export class RunDispatcher {
    private readonly store: RunStore;
    private readonly sessions: SessionStore;

    constructor(private readonly home: string) {
        this.store = new RunStore(home);
        this.sessions = new SessionStore(home);
    }

    async prepare(options: PrepareRunOptions): Promise<StoredRun> {
        const workbench = options.resolved.workbench;
        const id = RunStore.createId();
        const reference =
            options.session?.reference ?? options.reference ?? workbench.manifest.name;
        const workspaces = options.session?.workspaces ?? options.workspaces ?? [];
        if (options.session) this.assertCompatible(options, options.session);
        const session =
            options.session ??
            (await this.sessions.create({
                id,
                workbench: workbench.manifest.name,
                workbench_version: workbench.manifest.version,
                runner: workbench.manifest.runner,
                model: modelLabel(workbench.manifest.model),
                reference,
                workbench_path: workbench.packageDirectory,
                workspace: options.resolved.workspaceDirectory,
                workspaces,
                ...(options.resolved.registry
                    ? { registry: options.resolved.registry }
                    : {}),
                latest_run_id: id,
            }));
        let stored: StoredRun;
        try {
            stored = await this.store.create({
                id,
                metadata: {
                    workbench: workbench.manifest.name,
                    workbench_version: workbench.manifest.version,
                    runner: workbench.manifest.runner,
                    model: modelLabel(workbench.manifest.model),
                    workspace: options.resolved.workspaceDirectory,
                    mode: options.mode,
                    workspaces,
                    allow_host_docker: options.allowHostDocker ?? false,
                    session_id: session.id,
                    ...(options.session ? { resumed_from: session.latest_run_id } : {}),
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
                    workspaces,
                    allow_host_docker: options.allowHostDocker ?? false,
                    reference,
                    session_id: session.id,
                    ...(session.native_session_id
                        ? { native_session_id: session.native_session_id }
                        : {}),
                },
            });
        } catch (error) {
            if (!options.session) await this.sessions.remove(session.id);
            throw error;
        }
        if (options.session) {
            await this.sessions.update(session.id, { latest_run_id: stored.id });
        }
        return stored;
    }

    private assertCompatible(options: PrepareRunOptions, session: StoredSession): void {
        const workbench = options.resolved.workbench;
        const compatible =
            session.workbench === workbench.manifest.name &&
            session.workbench_version === workbench.manifest.version &&
            session.runner === workbench.manifest.runner &&
            session.model === modelLabel(workbench.manifest.model) &&
            session.workbench_path === workbench.packageDirectory &&
            session.workspace === options.resolved.workspaceDirectory;
        if (!compatible) {
            throw new Error(
                `Session ${session.id} does not match the resolved Workbench package`
            );
        }
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
