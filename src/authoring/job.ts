import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { RunDispatcher } from '../runs/dispatcher.js';
import { StoredRunHandle } from '../runs/handle.js';
import { RunStore } from '../runs/store.js';
import type { AuthoringLaunch } from './authoring.js';
import {
    type AuthoringFinishOptions,
    AuthoringOperation,
    type AuthoringOperationResult,
} from './operation.js';

export interface AuthoringJobRecord {
    version: 1;
    operation_id: string;
    session_id: string;
    run_id: string;
    status: 'running' | 'completed' | 'unchanged' | 'failed';
    pid?: number;
    result?: {
        kind: string;
        packages: Array<{ selector: string; path: string }>;
        changed_files: string[];
        evidence_path?: string;
        error?: string;
        warnings?: string[];
    };
}

interface VerificationRequest {
    environment_overrides?: {
        file: Record<string, string>;
        explicit: Array<[string, string]>;
    };
    workspace_overrides?: Array<[string, string]>;
    workspaces?: AuthoringFinishOptions['workspaces'];
    workspace_directory?: string;
    allow_host_docker?: boolean;
}

/** Supervises creator verification outside the generic execution engine. */
export class AuthoringJob {
    constructor(private readonly home: string) {}

    async start(
        launch: AuthoringLaunch,
        task: string,
        options: { detached: boolean }
    ): Promise<AuthoringJobRecord> {
        const dispatcher = new RunDispatcher(this.home);
        const run = await dispatcher.prepare({
            resolved: launch.resolved,
            reference: launch.alias,
            task,
            mode: options.detached ? 'detached' : 'foreground',
        });
        const record: AuthoringJobRecord = {
            version: 1,
            operation_id: launch.operation.id,
            session_id: run.session_id ?? run.id,
            run_id: run.id,
            status: 'running',
        };
        try {
            await launch.operation.checkpoint();
            await this.write(record);
            const index = join(this.home, 'authoring', 'runs');
            await mkdir(index, { recursive: true, mode: 0o700 });
            await writeFile(
                join(index, `${run.id}.json`),
                JSON.stringify({ operation_id: record.operation_id }),
                { mode: 0o600 }
            );
            await dispatcher.dispatch({
                id: run.id,
                cwd: launch.resolved.workspaceDirectory,
                environment: launch.environment,
                waitForInitialTurn: true,
            });
            const verification = launch.operation.verification;
            const request: VerificationRequest = {
                ...(verification.environmentOverrides
                    ? {
                          environment_overrides: {
                              file: verification.environmentOverrides.file,
                              explicit: [...verification.environmentOverrides.explicit],
                          },
                      }
                    : {}),
                ...(verification.workspaceOverrides
                    ? { workspace_overrides: [...verification.workspaceOverrides] }
                    : {}),
                ...(verification.workspaces
                    ? { workspaces: verification.workspaces }
                    : {}),
                ...(verification.workspaceDirectory
                    ? { workspace_directory: verification.workspaceDirectory }
                    : {}),
                ...(verification.allowHostDocker !== undefined
                    ? { allow_host_docker: verification.allowHostDocker }
                    : {}),
            };
            // Credential-bearing verification bindings are consumed and removed by
            // the supervisor, just like the engine's ephemeral run request.
            await writeFile(
                this.requestPath(record.operation_id),
                JSON.stringify(request),
                { mode: 0o600 }
            );
            const executable = process.execPath;
            const command = basename(executable).startsWith('bun')
                ? [executable, Bun.main]
                : [executable];
            const worker = Bun.spawn(
                [...command, '__authoring', this.home, record.operation_id],
                {
                    cwd: launch.resolved.workspaceDirectory,
                    env: {
                        ...process.env,
                        ...verification.environment,
                        WORKBENCH_HOME: this.home,
                    },
                    stdin: 'ignore',
                    stdout: 'ignore',
                    stderr: 'ignore',
                    detached: true,
                }
            );
            worker.unref();
            record.pid = worker.pid;
            await this.write(record);
            return record;
        } catch (error) {
            const store = new RunStore(this.home);
            const current = await store.reconcile(await store.read(run.id));
            if (!RunStore.isTerminal(current.status)) {
                if (current.pid)
                    await new StoredRunHandle(this.home, run.id)
                        .cancel('Creator startup failed')
                        .catch(() => {});
                else
                    await store.update(run.id, {
                        status: 'failed',
                        exit_code: 1,
                        finished_at: new Date().toISOString(),
                    });
            }
            await store.takeRequest(run.id).catch(() => {});
            await rm(this.requestPath(record.operation_id), { force: true });
            const message = error instanceof Error ? error.message : String(error);
            const result = await launch.operation.fail(message);
            await this.write(this.finished(record, launch.operation, result));
            throw error;
        }
    }

    async execute(id: string): Promise<number> {
        let record = await this.read(id);
        let operation: AuthoringOperation | undefined;
        try {
            // Startup owns the record until the child PID is checkpointed.
            // Do not let a fast verification result be overwritten by startup.
            const started = performance.now();
            while (record.pid !== process.pid) {
                if (performance.now() - started > 5_000)
                    throw new Error(
                        'Authoring verification startup was not acknowledged'
                    );
                await Bun.sleep(25);
                record = await this.read(id);
            }
            const request = JSON.parse(
                await readFile(this.requestPath(id), 'utf8')
            ) as VerificationRequest;
            await rm(this.requestPath(id));
            operation = await AuthoringOperation.load(this.home, id, {
                environment: process.env,
                ...(request.environment_overrides
                    ? {
                          environmentOverrides: {
                              file: request.environment_overrides.file,
                              explicit: new Map(request.environment_overrides.explicit),
                          },
                      }
                    : {}),
                ...(request.workspace_overrides
                    ? { workspaceOverrides: new Map(request.workspace_overrides) }
                    : {}),
                ...(request.workspaces ? { workspaces: request.workspaces } : {}),
                ...(request.workspace_directory
                    ? { workspaceDirectory: request.workspace_directory }
                    : {}),
                ...(request.allow_host_docker !== undefined
                    ? { allowHostDocker: request.allow_host_docker }
                    : {}),
            });
            const run = await new StoredRunHandle(this.home, record.run_id).result;
            if (run.status !== 'completed')
                throw new Error(`Creator execution ${run.status}`);
            const result = await operation.finish();
            record = this.finished(record, operation, result);
            await this.write(record);
            return 0;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const result = await operation?.fail(message);
            await this.write(
                result && operation
                    ? this.finished(record, operation, result)
                    : {
                          ...record,
                          status: 'failed',
                          result: {
                              kind: 'unknown',
                              packages: [],
                              changed_files: [],
                              error: message,
                          },
                      }
            );
            return 1;
        } finally {
            await rm(this.requestPath(id), { force: true });
        }
    }

    async forRun(runId: string): Promise<AuthoringJobRecord | undefined> {
        RunStore.validateId(runId);
        const source = await readFile(
            join(this.home, 'authoring', 'runs', `${runId}.json`),
            'utf8'
        ).catch((error) => {
            if (error?.code === 'ENOENT') return undefined;
            throw error;
        });
        if (!source) return undefined;
        return this.read(String(JSON.parse(source).operation_id));
    }

    async wait(
        record: AuthoringJobRecord,
        options: { timeoutMilliseconds?: number; signal?: AbortSignal } = {}
    ): Promise<AuthoringJobRecord> {
        const started = performance.now();
        let current = record;
        while (current.status === 'running') {
            if (
                options.signal?.aborted ||
                (options.timeoutMilliseconds !== undefined &&
                    performance.now() - started >= options.timeoutMilliseconds)
            )
                return current;
            if (current.pid) {
                try {
                    process.kill(current.pid, 0);
                } catch (error) {
                    if (
                        error instanceof Error &&
                        'code' in error &&
                        error.code === 'ESRCH'
                    ) {
                        // The supervisor writes its result before exiting. An
                        // old poll must not turn that successful exit into failure.
                        current = await this.read(record.operation_id);
                        if (current.status !== 'running') return current;
                        return {
                            ...current,
                            status: 'failed',
                            result: {
                                kind: 'unknown',
                                packages: [],
                                changed_files: [],
                                error: 'Authoring verification worker exited unexpectedly; the package has not been verified',
                            },
                        };
                    }
                    throw error;
                }
            }
            await Bun.sleep(25);
            current = await this.read(record.operation_id);
        }
        return current;
    }

    private finished(
        record: AuthoringJobRecord,
        operation: AuthoringOperation,
        result: AuthoringOperationResult
    ): AuthoringJobRecord {
        return {
            ...record,
            status: result.status,
            result: {
                kind: result.kind,
                packages: result.packages.map((selector) => ({
                    selector,
                    path: join(operation.repository, '.workbenches', selector),
                })),
                changed_files: result.changedFiles,
                ...(result.warnings ? { warnings: result.warnings } : {}),
                ...(operation.evidencePath
                    ? { evidence_path: operation.evidencePath }
                    : {}),
                ...(result.error ? { error: result.error } : {}),
            },
        };
    }

    private async read(id: string): Promise<AuthoringJobRecord> {
        this.validateId(id);
        const record = JSON.parse(
            await readFile(this.path(id), 'utf8')
        ) as AuthoringJobRecord;
        if (
            record.version !== 1 ||
            record.operation_id !== id ||
            typeof record.run_id !== 'string'
        )
            throw new Error('Invalid authoring job record');
        return record;
    }

    private validateId(id: string): void {
        if (!/^author_[a-z0-9_]+$/.test(id))
            throw new Error('Invalid authoring operation ID');
    }

    private path(id: string): string {
        this.validateId(id);
        return join(this.home, 'authoring', id, 'job.json');
    }
    private requestPath(id: string): string {
        this.validateId(id);
        return join(this.home, 'authoring', id, 'verification.json');
    }
    private async write(record: AuthoringJobRecord): Promise<void> {
        const path = this.path(record.operation_id);
        const temporary = `${path}.${crypto.randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
        await rename(temporary, path);
    }
}
