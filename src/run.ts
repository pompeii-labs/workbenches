import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
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
import { preflightWorkbench } from './preflight.js';
import { createRunId } from './run-store.js';
import type { ResolvedWorkbench } from './types.js';

export interface RunOptions {
    workbenchPath: string;
    task: string;
    dryRun?: boolean;
    workspaceDirectory?: string;
    runId?: string;
    signal?: AbortSignal;
    onEvent?: (event: WorkbenchEvent) => Promise<void> | void;
}

interface SpawnedRunner {
    exited: Promise<number>;
    stdout?: ReadableStream<Uint8Array>;
    stderr?: ReadableStream<Uint8Array>;
    kill?: () => void;
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
}

export async function runWorkbench(
    options: RunOptions,
    dependencies: RunDependencies = {}
): Promise<number> {
    const workbench = await resolveWorkbench(options.workbenchPath);
    const environment = dependencies.env ?? process.env;
    const findExecutable = dependencies.findExecutable ?? Bun.which;
    const spawn = dependencies.spawn ?? defaultSpawn;
    const write =
        dependencies.write ?? ((value: string) => process.stdout.write(value));

    if (options.dryRun) {
        preflightWorkbench(workbench, { env: environment, findExecutable });
        const staged = await stageOpenCodeSkills(workbench);
        try {
            const invocation = buildOpenCodeInvocation(
                workbench,
                options.task,
                environment,
                staged?.directory,
                options.workspaceDirectory
            );
            write(
                `${JSON.stringify(
                    {
                        ...publicInvocation(invocation),
                        skills: workbench.skills.map((skill) => skill.name),
                    },
                    null,
                    2
                )}\n`
            );
            return 0;
        } finally {
            await staged?.cleanup();
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
    });
    if (options.signal?.aborted) {
        await emitCancellation(emitter, started);
        return 130;
    }

    try {
        const preflight = preflightWorkbench(workbench, {
            env: environment,
            findExecutable,
        });
        const staged = await stageOpenCodeSkills(workbench);
        let code = 1;
        let stderr = '';
        let summary = { finalText: '', turnCompleted: false };
        try {
            if (options.signal?.aborted) {
                await emitCancellation(emitter, started);
                return 130;
            }
            const invocation = buildOpenCodeInvocation(
                workbench,
                options.task,
                environment,
                staged?.directory,
                options.workspaceDirectory
            );
            await emitter.emit('run.ready', {
                runner: preflight.runner.name,
                tools: preflight.tools.map((tool) => tool.name),
                enabled_mcps: preflight.enabledMcps,
                disabled_mcps: preflight.disabledMcps,
            });
            await emitter.emit('turn.started', { index: 1 });

            const [command, ...args] = invocation.command;
            if (!command) throw new Error('Runner command is empty');
            const child = spawn([command, ...args], {
                cwd: invocation.cwd,
                env: invocation.env,
                stdin: 'ignore',
                stdout: 'pipe',
                stderr: 'pipe',
            });
            const abortRunner = () => child.kill?.();
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
                child.kill?.();
                await Promise.allSettled([child.exited, stderrPromise]);
                throw error;
            } finally {
                options.signal?.removeEventListener('abort', abortRunner);
            }
        } finally {
            await staged?.cleanup();
        }
        if (options.signal?.aborted) {
            await emitCancellation(emitter, started);
            return 130;
        }
        if (code !== 0) {
            const detail = firstLine(redact(stderr, workbench, environment));
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

async function emitCancellation(
    emitter: RunEventEmitter,
    started: number
): Promise<void> {
    await emitter.emit('run.cancelled', {
        reason: 'requested',
        duration_ms: Date.now() - started,
    });
}

function defaultSpawn(
    command: string[],
    options: {
        cwd: string;
        env: Record<string, string | undefined>;
        stdin: 'ignore';
        stdout: 'pipe';
        stderr: 'pipe';
    }
): SpawnedRunner {
    return Bun.spawn(command, options);
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
        value
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find(Boolean)
            ?.slice(0, 500) ?? ''
    );
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
                symlink(skill.directory, join(skillsDirectory, skill.name), 'dir')
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
