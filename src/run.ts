import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
    WorkbenchEvent,
    WorkbenchEventDraft,
    WorkbenchEventType,
} from './execution.js';
import { resolveWorkbench } from './manifest.js';
import { buildOpenCodeInvocation, publicInvocation } from './opencode.js';
import { OpenCodeEventAdapter } from './opencode-events.js';
import { createRunId } from './run-store.js';
import {
    createRuntimeProviderRegistry,
    type PreparedRuntime,
    type RuntimeProviderRegistry,
} from './runtime.js';
import type {
    ResolvedWorkbench,
    SpawnedRunner,
    WorkbenchWorkspaceBinding,
} from './types.js';
import { validateWorkbenchWorkspaceBindings } from './workspaces.js';

export interface RunOptions {
    workbenchPath: string;
    task: string;
    dryRun?: boolean;
    workspaceDirectory?: string;
    workspaces?: WorkbenchWorkspaceBinding[];
    allowHostDocker?: boolean;
    runId?: string;
    signal?: AbortSignal;
    onEvent?: (event: WorkbenchEvent) => Promise<void> | void;
}

export interface RunDependencies {
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
    runtimeRegistry?: RuntimeProviderRegistry;
}

export async function runWorkbench(
    options: RunOptions,
    dependencies: RunDependencies = {}
): Promise<number> {
    const workbench = await resolveWorkbench(options.workbenchPath);
    const workspaces = options.workspaces ?? [];
    await validateWorkbenchWorkspaceBindings(workbench, workspaces);
    validateHostDockerAuthorization(workbench, options.allowHostDocker ?? false);
    const environment = dependencies.env ?? process.env;
    const findExecutable = dependencies.findExecutable ?? Bun.which;
    const write =
        dependencies.write ?? ((value: string) => process.stdout.write(value));
    const runtimeRegistry =
        dependencies.runtimeRegistry ??
        createRuntimeProviderRegistry({
            findExecutable,
            ...(dependencies.spawn ? { spawn: dependencies.spawn } : {}),
        });

    if (options.dryRun) {
        const staged = await stageOpenCodeSkills(workbench);
        let runtime: PreparedRuntime | undefined;
        try {
            runtime = await runtimeRegistry
                .resolve(workbench.manifest.runtime)
                .prepare(
                    runtimeRequest(
                        workbench,
                        options.workspaceDirectory,
                        environment,
                        staged?.directory,
                        workspaces,
                        options.allowHostDocker
                    )
                );
            await runtime.preflight();
            const invocation = buildOpenCodeInvocation(
                runtime.workbench,
                options.task,
                runtime.environment,
                staged ? runtime.pathFor(staged.directory) : undefined,
                runtime.workspaceDirectory
            );
            write(
                `${JSON.stringify(
                    {
                        ...publicInvocation(invocation),
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
            return 0;
        } finally {
            await cleanupRuntimeAndAssets(runtime, staged);
        }
    }

    const started = Date.now();
    const emitter = new RunEventEmitter({
        runId: options.runId ?? createRunId(),
        runner: workbench.manifest.runner,
        ...(options.onEvent ? { onEvent: options.onEvent } : {}),
        ...(dependencies.now ? { now: dependencies.now } : {}),
    });
    await emitter.emit('run.started', {
        workbench: workbench.manifest.name,
        workbench_version: workbench.manifest.version,
        model: workbench.manifest.model,
        runtime: workbench.manifest.runtime,
        workspace: options.workspaceDirectory ?? workbench.repositoryDirectory,
        workspaces,
        ...(workbench.manifest.docker?.engine
            ? {
                  docker_engine: workbench.manifest.docker.engine.mode,
                  host_docker_authorized: options.allowHostDocker ?? false,
              }
            : {}),
    });
    if (options.signal?.aborted) {
        await emitCancellation(emitter, started);
        return 130;
    }

    try {
        const staged = await stageOpenCodeSkills(workbench);
        let runtime: PreparedRuntime | undefined;
        let code = 1;
        let stderr = '';
        let summary: {
            finalText: string;
            turnCompleted: boolean;
            failureMessage?: string;
        } = { finalText: '', turnCompleted: false };
        try {
            runtime = await runtimeRegistry
                .resolve(workbench.manifest.runtime)
                .prepare(
                    runtimeRequest(
                        workbench,
                        options.workspaceDirectory,
                        environment,
                        staged?.directory,
                        workspaces,
                        options.allowHostDocker
                    )
                );
            const preflight = await runtime.preflight();
            if (options.signal?.aborted) {
                await emitCancellation(emitter, started);
                return 130;
            }
            const invocation = buildOpenCodeInvocation(
                runtime.workbench,
                options.task,
                runtime.environment,
                staged ? runtime.pathFor(staged.directory) : undefined,
                runtime.workspaceDirectory
            );
            await emitter.emit('run.ready', {
                runner: preflight.runner.name,
                tools: preflight.tools.map((tool) => tool.name),
                enabled_mcps: preflight.enabledMcps,
                disabled_mcps: preflight.disabledMcps,
                workspaces: runtime.workspaces,
                ...(preflight.dockerEngine
                    ? { docker_engine: preflight.dockerEngine }
                    : {}),
            });
            await emitter.emit('turn.started', { index: 1 });

            const [command, ...args] = invocation.command;
            if (!command) throw new Error('Runner command is empty');
            const child = runtime.launch({
                ...invocation,
                command: [command, ...args],
            });
            const abortRunner = () => runtime?.cancel(child);
            options.signal?.addEventListener('abort', abortRunner, { once: true });
            if (options.signal?.aborted) abortRunner();
            const adapter = new OpenCodeEventAdapter();
            const stderrPromise = readLimitedText(child.stderr, 64 * 1024);
            try {
                await Promise.all([
                    consumeLines(child.stdout, async (line) => {
                        let native: unknown;
                        try {
                            native = JSON.parse(line);
                        } catch {
                            native = null;
                        }
                        const result = adapter.consume(native);
                        for (const event of result.events) {
                            await emitter.emitDraft(event);
                        }
                    }),
                    child.exited,
                ]);
                [code, stderr] = await Promise.all([child.exited, stderrPromise]);
                summary = adapter.summary();
            } catch (error) {
                runtime.cancel(child);
                await Promise.allSettled([child.exited, stderrPromise]);
                throw error;
            } finally {
                options.signal?.removeEventListener('abort', abortRunner);
            }
        } finally {
            await cleanupRuntimeAndAssets(runtime, staged);
        }
        if (options.signal?.aborted) {
            await emitCancellation(emitter, started);
            return 130;
        }
        if (code !== 0) {
            const nativeDetail = summary.failureMessage ?? firstLine(stderr);
            const detail = firstLine(redact(nativeDetail, workbench, environment));
            await emitter.emit('run.failed', {
                message: `OpenCode exited with code ${code}${detail ? `: ${detail}` : ''}`,
                exit_code: code,
                duration_ms: Date.now() - started,
            });
            return code;
        }
        if (!summary.turnCompleted) {
            await emitter.emit('turn.completed', { reason: 'process-exit' });
        }
        await emitter.emit('run.completed', {
            exit_code: 0,
            duration_ms: Date.now() - started,
        });
        return 0;
    } catch (error) {
        if (options.signal?.aborted) {
            await emitCancellation(emitter, started);
            return 130;
        }
        const message = error instanceof Error ? error.message : String(error);
        await emitter.emit('run.failed', {
            message: redact(message, workbench, environment),
            duration_ms: Date.now() - started,
        });
        return 1;
    }
}

function validateHostDockerAuthorization(
    workbench: ResolvedWorkbench,
    authorized: boolean
): void {
    const declared = workbench.manifest.docker?.engine !== undefined;
    if (authorized && !declared) {
        throw new Error(
            'Host Docker authorization was supplied to a Workbench that does not declare docker.engine'
        );
    }
}

async function emitCancellation(
    emitter: RunEventEmitter,
    started: number
): Promise<void> {
    await emitter.emit('run.cancelled', {
        reason: 'requested',
        duration_ms: Date.now() - started,
    });
}

class RunEventEmitter {
    private sequence = 0;
    private readonly runId: string;
    private readonly runner: string;
    private readonly onEvent: NonNullable<RunOptions['onEvent']>;
    private readonly now: () => Date;

    constructor(options: {
        runId: string;
        runner: string;
        onEvent?: RunOptions['onEvent'];
        now?: () => Date;
    }) {
        this.runId = options.runId;
        this.runner = options.runner;
        this.onEvent = options.onEvent ?? (() => {});
        this.now = options.now ?? (() => new Date());
    }

    emitDraft(event: WorkbenchEventDraft): Promise<void> {
        return this.emit(event.type, event.data);
    }

    async emit(type: WorkbenchEventType, data: unknown): Promise<void> {
        this.sequence += 1;
        await this.onEvent({
            protocol: 0,
            run_id: this.runId,
            sequence: this.sequence,
            timestamp: this.now().toISOString(),
            type,
            runner: this.runner,
            data,
        });
    }
}

function runtimeRequest(
    workbench: ResolvedWorkbench,
    workspaceDirectory: string | undefined,
    environment: Record<string, string | undefined>,
    runnerConfigDirectory: string | undefined,
    workspaces: WorkbenchWorkspaceBinding[] = [],
    allowHostDocker = false
) {
    const workspace = workspaceDirectory ?? workbench.repositoryDirectory;
    return {
        workbench,
        workspaceDirectory: workspace,
        environment,
        assets: [
            { path: workspace, access: 'read-write' as const },
            { path: workbench.packageDirectory, access: 'read-only' as const },
            ...workspaces.map((binding) => ({
                path: binding.path,
                access: binding.access,
                workspace: binding.name,
            })),
            ...(runnerConfigDirectory
                ? [
                      {
                          path: runnerConfigDirectory,
                          access: 'read-write' as const,
                      },
                  ]
                : []),
        ],
        authorizations: { hostDocker: allowHostDocker },
    };
}

async function cleanupRuntimeAndAssets(
    runtime: PreparedRuntime | undefined,
    staged: { cleanup: () => Promise<void> } | undefined
): Promise<void> {
    const results = await Promise.allSettled([runtime?.cleanup(), staged?.cleanup()]);
    const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (failure) throw failure.reason;
}

async function consumeLines(
    stream: ReadableStream<Uint8Array> | undefined,
    consume: (line: string) => Promise<void>
): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    while (true) {
        const result = await reader.read();
        if (result.done) break;
        pending += decoder.decode(result.value, { stream: true });
        if (pending.length > 16 * 1024 * 1024) {
            throw new Error('OpenCode emitted an oversized JSON event');
        }
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
            const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
            if (normalized.trim()) await consume(normalized);
        }
    }
    pending += decoder.decode();
    if (pending.trim()) await consume(pending);
}

async function readLimitedText(
    stream: ReadableStream<Uint8Array> | undefined,
    limit: number
): Promise<string> {
    if (!stream) return '';
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let result = '';
    while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (result.length < limit) {
            result += decoder.decode(next.value, { stream: true });
            if (result.length > limit) result = result.slice(0, limit);
        }
    }
    return result + decoder.decode();
}

function redact(
    source: string,
    workbench: ResolvedWorkbench,
    environment: Record<string, string | undefined>
): string {
    let result = source;
    const values = Object.keys(workbench.manifest.env)
        .flatMap((name) => {
            const value = environment[name];
            return value && value.length >= 4 ? [value] : [];
        })
        .toSorted((left, right) => right.length - left.length);
    for (const value of values) result = result.replaceAll(value, '[REDACTED]');
    return result;
}

function firstLine(value: string): string {
    return (
        stripTerminalControl(value)
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find(Boolean)
            ?.slice(0, 500) ?? ''
    );
}

function stripTerminalControl(value: string): string {
    let result = '';
    for (let index = 0; index < value.length; index += 1) {
        if (value.charCodeAt(index) !== 27) {
            result += value[index];
            continue;
        }
        if (value[index + 1] !== '[') {
            index += 1;
            continue;
        }
        index += 2;
        while (index < value.length) {
            const code = value.charCodeAt(index);
            if (code >= 0x40 && code <= 0x7e) break;
            index += 1;
        }
    }
    return result;
}

export async function stageOpenCodeSkills(
    workbench: ResolvedWorkbench
): Promise<{ directory: string; cleanup: () => Promise<void> } | undefined> {
    if (workbench.skills.length === 0) return undefined;
    const directory = await mkdtemp(join(tmpdir(), 'workbench-opencode-'));
    const skillsDirectory = join(directory, 'skills');
    await mkdir(skillsDirectory);
    try {
        await Promise.all(
            workbench.skills.map((skill) =>
                cp(skill.directory, join(skillsDirectory, skill.name), {
                    recursive: true,
                    preserveTimestamps: true,
                })
            )
        );
    } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
    }
    return {
        directory,
        cleanup: () => rm(directory, { recursive: true, force: true }),
    };
}
