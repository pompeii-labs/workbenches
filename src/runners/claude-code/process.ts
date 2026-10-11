import type { RuntimeCommandResult } from '../../runtimes/contracts.js';
import type { RunnerInvocation } from '../../types.js';

export interface ClaudeCodeChild {
    exited: Promise<number>;
    stdin: {
        write(value: string): unknown;
        flush?(): unknown;
        end?(): unknown;
    };
    stdout?: ReadableStream<Uint8Array>;
    stderr?: ReadableStream<Uint8Array>;
    kill(signal?: NodeJS.Signals): void;
}

export type ClaudeCodeSpawn = (
    command: string[],
    options: {
        cwd: string;
        env: Record<string, string | undefined>;
        stdin: 'pipe';
        stdout: 'pipe';
        stderr: 'pipe';
    }
) => ClaudeCodeChild;

/** Why the child stopped serving the session: its exit code, or a broken output stream. */
export type ClaudeCodeExit = { code: number } | { error: Error };

const MAXIMUM_LINE_BYTES = 16 * 1024 * 1024;
const STDERR_TAIL_BYTES = 64 * 1024;
/** The standard error lines that explain an exit without an `error:` line. */
const EXIT_DETAIL_LINES = 3;

/**
 * One long-lived `claude` child. It writes JSON lines to standard input, hands
 * each standard output line to the consumer in order, keeps a bounded tail of
 * standard error, and stops the child with SIGTERM and, after a bounded wait,
 * SIGKILL. Every timer it starts is cleared on every path.
 */
export class ClaudeCodeProcess {
    private child: ClaudeCodeChild | undefined;
    private readonly readers: Array<{ cancel(): Promise<void> }> = [];
    private stderrTail = '';
    private exitCode: number | undefined;
    private stopping: Promise<void> | undefined;
    /** Settles once the child exited and both output streams ended. */
    private finished: Promise<unknown> = Promise.resolve();

    constructor(
        private readonly invocation: RunnerInvocation,
        private readonly spawn: ClaudeCodeSpawn,
        private readonly stopTimeoutMs: number
    ) {}

    /**
     * Spawns the child and hands each output line to `consume` in order. The
     * returned promise settles when the output stream breaks, or when the child
     * exited and its remaining output was consumed.
     */
    start(consume: (line: string) => Promise<void>): Promise<ClaudeCodeExit> {
        if (this.child) throw new Error('Claude Code is already running');
        const child = this.spawn(this.invocation.command, {
            cwd: this.invocation.cwd,
            env: this.invocation.env,
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'pipe',
        });
        this.child = child;
        const reading = this.readLines(child.stdout, consume);
        const diagnostics = this.readStderr(child.stderr);
        const exited = child.exited.then((code) => {
            this.exitCode = code;
            return code;
        });
        this.finished = Promise.allSettled([reading, exited, diagnostics]);
        return Promise.race([
            reading.then(
                () => new Promise<never>(() => {}),
                (error: unknown) => ({ error: asError(error) })
            ),
            exited.then(async (code) => {
                // The exit can arrive before the last output, and a failure
                // is explained by the end of standard error.
                await settlesWithin(
                    Promise.allSettled([reading, diagnostics]),
                    this.stopTimeoutMs
                );
                return { code };
            }),
        ]);
    }

    /** Whether the child exited. Its reason settles `start` once its output ends. */
    get exited(): boolean {
        return this.exitCode !== undefined;
    }

    async write(line: string): Promise<void> {
        const child = this.child;
        if (!child || this.stopping || this.exitCode !== undefined) {
            throw new Error('Claude Code is not running');
        }
        await child.stdin.write(`${line}\n`);
        await child.stdin.flush?.();
    }

    /** The first standard error line Claude Code reported as an error. */
    errorLine(): string | undefined {
        return this.stderrTail
            .split('\n')
            .map((line) => line.trim())
            .find((line) => /^error:/iu.test(line));
    }

    /**
     * Why the child stopped, from standard error: its error line, or else its
     * last lines, such as a shell or runtime failure before Claude Code ran.
     * Callers redact it.
     */
    exitDetail(): string | undefined {
        return (
            this.errorLine() ??
            (this.stderrTail
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean)
                .slice(-EXIT_DETAIL_LINES)
                .join(' ') ||
                undefined)
        );
    }

    stop(): Promise<void> {
        this.stopping ??= this.terminate();
        return this.stopping;
    }

    private async terminate(): Promise<void> {
        const child = this.child;
        if (!child) return;
        try {
            await child.stdin.end?.();
        } catch {
            // The child may already have closed its input.
        }
        if (this.exitCode === undefined) child.kill('SIGTERM');
        if (!(await settlesWithin(child.exited, this.stopTimeoutMs))) {
            child.kill('SIGKILL');
            await child.exited;
        }
        // A tool's own subprocess can hold the output pipes open after the
        // child exits, so reading gets a bounded wait before it is cancelled.
        if (!(await settlesWithin(this.finished, this.stopTimeoutMs))) {
            await Promise.allSettled(this.readers.map((reader) => reader.cancel()));
        }
        await this.finished;
    }

    private async readLines(
        stream: ReadableStream<Uint8Array> | undefined,
        consume: (line: string) => Promise<void>
    ): Promise<void> {
        if (!stream) return;
        const reader = stream.getReader();
        this.readers.push(reader);
        const decoder = new TextDecoder();
        let pending = '';
        for (;;) {
            const next = await reader.read();
            if (next.done) break;
            pending += decoder.decode(next.value, { stream: true });
            if (pending.length > MAXIMUM_LINE_BYTES) {
                throw new Error('Claude Code emitted an oversized JSON event');
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

    private async readStderr(stream: ReadableStream<Uint8Array> | undefined) {
        if (!stream) return;
        const reader = stream.getReader();
        this.readers.push(reader);
        const decoder = new TextDecoder();
        try {
            for (;;) {
                const next = await reader.read();
                if (next.done) break;
                this.stderrTail = (
                    this.stderrTail + decoder.decode(next.value, { stream: true })
                ).slice(-STDERR_TAIL_BYTES);
            }
        } catch {
            // Standard error is diagnostic only.
        }
    }
}

/** Whether a promise settles before the timeout. The timer is always cleared. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise.then(
                () => true,
                () => true
            ),
            new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(false), ms);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

/** Runs a short command on this host and collects its output. */
export async function executeOnHost(
    invocation: RunnerInvocation
): Promise<RuntimeCommandResult> {
    const child = Bun.spawn(invocation.command, {
        cwd: invocation.cwd,
        env: invocation.env,
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    return { code, stdout, stderr };
}
