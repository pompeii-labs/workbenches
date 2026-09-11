import { basename } from 'node:path';

import { WorkbenchPackage } from '../catalog/index.js';
import { modelLabel } from '../models/index.js';
import { RunnerRegistry } from '../runners/index.js';
import {
    SessionIdentity,
    SessionStore,
    type StoredSession,
} from '../sessions/index.js';
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
    private readonly identity = new SessionIdentity();

    constructor(private readonly home: string) {
        this.store = new RunStore(home);
        this.sessions = new SessionStore(home);
    }

    async prepare(options: PrepareRunOptions): Promise<StoredRun> {
        const workbench = options.resolved.workbench;
        const id = RunStore.createId();
        const execution = this.executionFor(workbench.manifest.runner);
        const reference =
            options.session?.reference ?? options.reference ?? workbench.manifest.name;
        const workspaces = options.session?.workspaces ?? options.workspaces ?? [];
        const digest = WorkbenchPackage.digest(
            await new WorkbenchPackage(workbench).files()
        );
        const suggestedName = options.task
            ? this.identity.fromPrompt(options.task)
            : undefined;
        if (options.session) this.assertCompatible(options, options.session, digest);
        const session =
            options.session ??
            (await this.sessions.create({
                id,
                ...(suggestedName ? { name: suggestedName } : {}),
                workbench: workbench.manifest.name,
                workbench_version: workbench.manifest.version,
                runner: workbench.manifest.runner,
                model: modelLabel(workbench.manifest.model),
                runtime: workbench.manifest.runtime,
                reference,
                workbench_path: workbench.packageDirectory,
                ...(options.resolved.source === 'local'
                    ? { source_workbench_path: workbench.packageDirectory }
                    : {}),
                workbench_digest: digest,
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
                    runtime: workbench.manifest.runtime,
                    workspace: options.resolved.workspaceDirectory,
                    mode: options.mode,
                    execution,
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

    private executionFor(runner: string): 'one_shot' | 'session' {
        const resume =
            RunnerRegistry.standard().session(runner).declaration.capabilities
                .session_resume;
        return resume.status === 'unsupported' ? 'one_shot' : 'session';
    }

    private assertCompatible(
        options: PrepareRunOptions,
        session: StoredSession,
        digest: string
    ): void {
        const workbench = options.resolved.workbench;
        const compatible =
            session.workbench === workbench.manifest.name &&
            session.workbench_version === workbench.manifest.version &&
            session.runner === workbench.manifest.runner &&
            session.model === modelLabel(workbench.manifest.model) &&
            session.runtime === workbench.manifest.runtime &&
            session.workbench_path === workbench.packageDirectory &&
            (!session.workbench_digest || session.workbench_digest === digest) &&
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
        let pid: number;
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
            pid = child.pid;
            await this.store.update(options.id, { pid });
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
        try {
            await this.waitUntilStarted(options.id);
            return pid;
        } catch (error) {
            await this.store
                .read(options.id)
                .then((run) => this.store.reconcile(run))
                .catch(() => {});
            throw error;
        }
    }

    private async waitUntilStarted(id: string): Promise<void> {
        const started = Date.now();
        let startupTimeout = 15_000;
        while (Date.now() - started < startupTimeout) {
            const run = await this.store.read(id);
            startupTimeout =
                run.runtime === 'docker' || run.runtime === 'e2b' ? 5 * 60_000 : 15_000;
            if (RunStore.isTerminal(run.status)) {
                if (run.status === 'completed') return;
                const events = await this.store.readEvents(id);
                const message = events
                    .toReversed()
                    .find((event) => event.type === 'run.failed')?.data;
                throw new Error(
                    typeof message === 'object' &&
                        message !== null &&
                        typeof Reflect.get(message, 'message') === 'string'
                        ? String(Reflect.get(message, 'message'))
                        : `Workbench session failed to start: ${id}`
                );
            }
            if (
                run.status === 'running' &&
                (run.mode === 'interactive' ||
                    run.execution !== 'session' ||
                    Boolean(run.runner_session_id))
            ) {
                return;
            }
            this.store.assertWorkerAlive(run);
            await Bun.sleep(25);
        }
        throw new Error(`Workbench session did not start in time: ${id}`);
    }

    private workerCommand(id: string): string[] {
        const executable = process.execPath;
        const runningThroughBun = basename(executable).startsWith('bun');
        return runningThroughBun
            ? [executable, Bun.main, '__worker', this.home, id]
            : [executable, '__worker', this.home, id];
    }
}
