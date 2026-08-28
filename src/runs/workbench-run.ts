import { ConnectionInspector } from '../connections/inspector.js';
import { ConnectionStore } from '../connections/store.js';
import type { ResolvedRunnerConfiguration } from '../models/index.js';
import { RunnerRegistry } from '../runners/registry.js';
import type { PreparedRunner } from '../runners/runner.js';
import {
    type PreparedRuntime,
    type RuntimeAsset,
    RuntimeRegistry,
} from '../runtimes/index.js';
import type {
    ResolvedWorkbench,
    RunnerInvocation,
    SpawnedRunner,
    WorkbenchWorkspaceBinding,
} from '../types.js';
import { Workbench, WorkbenchWorkspaces } from '../workbench/index.js';
import { RunEvents, type WorkbenchEvent } from './events.js';
import { RunnerOutput } from './runner-output.js';
import { RunStore } from './store.js';

export interface WorkbenchRunOptions {
    workbenchPath: string;
    task: string;
    dryRun?: boolean;
    workspaceDirectory?: string;
    workspaces?: WorkbenchWorkspaceBinding[];
    allowHostDocker?: boolean;
    runId?: string;
    signal?: AbortSignal;
    onEvent?: (event: WorkbenchEvent) => Promise<void> | void;
    onLaunch?: () => Promise<void> | void;
    reference?: string;
    home?: string;
}

export interface WorkbenchRunDependencies {
    env?: Record<string, string | undefined>;
    findExecutable?: (name: string) => string | null;
    spawn?: (
        command: string[],
        options: {
            cwd: string;
            env: Record<string, string | undefined>;
            stdin: 'ignore';
            stdout: 'pipe';
            stderr: 'pipe';
        }
    ) => SpawnedRunner;
    write?: (value: string) => void;
    now?: () => Date;
    runtimeRegistry?: RuntimeRegistry;
}

export class WorkbenchRun {
    private readonly environment: Record<string, string | undefined>;
    private readonly write: (value: string) => void;
    private readonly runtimeRegistry: RuntimeRegistry;
    private startedAt = 0;

    constructor(
        private readonly options: WorkbenchRunOptions,
        private readonly dependencies: WorkbenchRunDependencies = {}
    ) {
        this.environment = dependencies.env ?? process.env;
        const findExecutable = dependencies.findExecutable ?? Bun.which;
        this.write =
            dependencies.write ?? ((value: string) => process.stdout.write(value));
        this.runtimeRegistry =
            dependencies.runtimeRegistry ??
            RuntimeRegistry.standard({
                findExecutable,
                ...(dependencies.spawn ? { spawn: dependencies.spawn } : {}),
            });
    }

    static execute(
        options: WorkbenchRunOptions,
        dependencies: WorkbenchRunDependencies = {}
    ): Promise<number> {
        return new WorkbenchRun(options, dependencies).execute();
    }

    async execute(): Promise<number> {
        const workbench = await Workbench.load(this.options.workbenchPath);
        const workspaces = this.options.workspaces ?? [];
        await new WorkbenchWorkspaces().validate(workbench, workspaces);
        this.validateHostDockerAuthorization(workbench);
        this.startedAt = Date.now();

        const events = new RunEvents({
            runId: this.options.runId ?? RunStore.createId(),
            runner: workbench.manifest.runner,
            ...(this.options.onEvent ? { onEvent: this.options.onEvent } : {}),
            ...(this.dependencies.now ? { now: this.dependencies.now } : {}),
        });
        let runner: PreparedRunner | undefined;
        let runtime: PreparedRuntime | undefined;
        try {
            runner = await RunnerRegistry.standard().prepare(
                workbench,
                this.environment
            );
            runtime = await this.runtimeRegistry
                .resolve(workbench.manifest.runtime)
                .prepare(this.runtimeRequest(workbench, runner.assets, workspaces));
            const preflight = await runtime.preflight();
            const configuration = await new ConnectionInspector({
                workbench,
                runtime,
                runner,
                reference: this.options.reference ?? workbench.manifest.name,
                ...(this.options.home
                    ? { store: new ConnectionStore(this.options.home) }
                    : {}),
            }).require();
            const invocation = runner.build(runtime, this.options.task, configuration);

            if (this.options.dryRun) {
                this.writeDryRun(workbench, runner, runtime, invocation, configuration);
                return 0;
            }

            await events.emit('run.started', {
                workbench: workbench.manifest.name,
                workbench_version: workbench.manifest.version,
                model: configuration.model,
                model_route: {
                    canonical: configuration.canonicalModel,
                    provider: configuration.provider,
                    ...(configuration.catalogVersion
                        ? { catalog_version: configuration.catalogVersion }
                        : {}),
                },
                runtime: workbench.manifest.runtime,
                workspace:
                    this.options.workspaceDirectory ?? workbench.repositoryDirectory,
                workspaces,
                ...(workbench.manifest.docker?.engine
                    ? {
                          docker_engine: workbench.manifest.docker.engine.mode,
                          host_docker_authorized: this.options.allowHostDocker ?? false,
                      }
                    : {}),
            });
            if (this.options.signal?.aborted) {
                await this.emitCancellation(events);
                return 130;
            }

            await events.emit('run.ready', {
                runner: preflight.runner.name,
                tools: preflight.tools.map((tool) => tool.name),
                enabled_mcps: preflight.enabledMcps,
                disabled_mcps: preflight.disabledMcps,
                workspaces: runtime.workspaces,
                ...(preflight.dockerEngine
                    ? { docker_engine: preflight.dockerEngine }
                    : {}),
            });
            await events.emit('turn.started', { index: 1 });

            return await this.launch(workbench, runner, runtime, events, invocation);
        } catch (error) {
            if (this.options.signal?.aborted) {
                await this.emitCancellation(events);
                return 130;
            }
            const message = error instanceof Error ? error.message : String(error);
            await events.emit('run.failed', {
                message: RunnerOutput.redact(message, workbench, this.environment),
                duration_ms: this.duration(),
            });
            return 1;
        } finally {
            await this.cleanup(runtime, runner);
        }
    }

    private async launch(
        workbench: ResolvedWorkbench,
        runner: PreparedRunner,
        runtime: PreparedRuntime,
        events: RunEvents,
        invocation: RunnerInvocation
    ): Promise<number> {
        const [command, ...args] = invocation.command;
        if (!command) throw new Error('Runner command is empty');
        const child = runtime.launch({
            ...invocation,
            command: [command, ...args],
        });
        const launchCompletion = Promise.resolve()
            .then(() => this.options.onLaunch?.())
            .catch(() => {});
        const abortRunner = () => runtime.cancel(child);
        this.options.signal?.addEventListener('abort', abortRunner, { once: true });
        if (this.options.signal?.aborted) abortRunner();

        const output = new RunnerOutput(runner.events(), events);
        try {
            const result = await output.consume(child, () => runtime.cancel(child));
            if (this.options.signal?.aborted) {
                await this.emitCancellation(events);
                return 130;
            }
            if (result.code !== 0) {
                const detail = RunnerOutput.failureDetail(
                    result.summary.failureMessage ?? result.stderr,
                    workbench,
                    this.environment
                );
                await events.emit('run.failed', {
                    message: `${runner.failureLabel} exited with code ${result.code}${detail ? `: ${detail}` : ''}`,
                    exit_code: result.code,
                    duration_ms: this.duration(),
                });
                return result.code;
            }
            if (!result.summary.turnCompleted) {
                await events.emit('turn.completed', { reason: 'process-exit' });
            }
            await events.emit('run.completed', {
                exit_code: 0,
                duration_ms: this.duration(),
            });
            return 0;
        } finally {
            this.options.signal?.removeEventListener('abort', abortRunner);
            await launchCompletion;
        }
    }

    private writeDryRun(
        workbench: ResolvedWorkbench,
        runner: PreparedRunner,
        runtime: PreparedRuntime,
        invocation: RunnerInvocation,
        configuration: ResolvedRunnerConfiguration
    ): void {
        this.write(
            `${JSON.stringify(
                {
                    ...runner.publicInvocation(invocation),
                    model_route: {
                        canonical: configuration.canonicalModel,
                        provider: configuration.provider,
                        model: configuration.model,
                        ...(configuration.catalogVersion
                            ? { catalog_version: configuration.catalogVersion }
                            : {}),
                    },
                    skills: workbench.skills.map((skill) => skill.name),
                    workspaces: runtime.workspaces,
                    ...(workbench.manifest.docker?.engine
                        ? { docker_engine: workbench.manifest.docker.engine.mode }
                        : {}),
                },
                null,
                2
            )}\n`
        );
    }

    private runtimeRequest(
        workbench: ResolvedWorkbench,
        runnerAssets: RuntimeAsset[],
        workspaces: WorkbenchWorkspaceBinding[]
    ) {
        const workspace =
            this.options.workspaceDirectory ?? workbench.repositoryDirectory;
        return {
            workbench,
            workspaceDirectory: workspace,
            environment: this.environment,
            assets: [
                { path: workspace, access: 'read-write' as const },
                {
                    path: workbench.packageDirectory,
                    access: 'read-only' as const,
                },
                ...workspaces.map((binding) => ({
                    path: binding.path,
                    access: binding.access,
                    workspace: binding.name,
                })),
                ...runnerAssets,
            ],
            authorizations: {
                hostDocker: this.options.allowHostDocker ?? false,
            },
        };
    }

    private validateHostDockerAuthorization(workbench: ResolvedWorkbench): void {
        const declared = workbench.manifest.docker?.engine !== undefined;
        if (this.options.allowHostDocker && !declared) {
            throw new Error(
                'Host Docker authorization was supplied to a Workbench that does not declare docker.engine'
            );
        }
    }

    private async emitCancellation(events: RunEvents): Promise<void> {
        await events.emit('run.cancelled', {
            reason: 'requested',
            duration_ms: this.duration(),
        });
    }

    private duration(): number {
        return Date.now() - this.startedAt;
    }

    private async cleanup(
        runtime: PreparedRuntime | undefined,
        runner: PreparedRunner | undefined
    ): Promise<void> {
        const results = await Promise.allSettled([
            runtime?.cleanup(),
            runner?.cleanup(),
        ]);
        const failure = results.find(
            (result): result is PromiseRejectedResult => result.status === 'rejected'
        );
        if (failure) throw failure.reason;
    }
}
