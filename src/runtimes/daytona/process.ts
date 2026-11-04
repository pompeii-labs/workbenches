import type { RuntimeCommandResult } from '../contracts.js';
import type { RemoteCommand, RemoteCommandOptions } from '../remote/process.js';
import { LogFollower } from './follow.js';
import type { StderrFile } from './stderr.js';
import { DaytonaApiError, type DaytonaTransport } from './transport.js';

/** The code a command reports when it was stopped, as a shell reports SIGTERM. */
const stoppedCode = 143;

/**
 * A command running in a toolbox session. Its output streams over the
 * toolbox's log WebSocket as it is written and goes to the caller's receivers
 * in order. Only a stream the caller does not receive is kept, so it can be
 * returned by `wait()`; a received stream is never held in memory. With a
 * stderr file, standard error arrives once the command exits, before `wait()`
 * resolves.
 */
export class SessionProcess implements RemoteCommand {
    readonly #stdout: CommandOutput;
    readonly #stderr: CommandOutput;
    readonly #follower: LogFollower;
    readonly #finished: Promise<RuntimeCommandResult>;
    /** Output handed to the receivers, one chunk after another. */
    #delivery: Promise<void> = Promise.resolve();
    #failure: unknown;
    #killed = false;

    constructor(
        private readonly transport: DaytonaTransport,
        private readonly session: string,
        private readonly command: string,
        options: RemoteCommandOptions,
        /** Where the command's standard error is kept apart, delivered when it exits. */
        private readonly stderrFile?: StderrFile
    ) {
        this.#stdout = new CommandOutput(options.onStdout);
        this.#stderr = new CommandOutput(options.onStderr);
        this.#follower = new LogFollower(
            transport,
            session,
            command,
            {
                stdout: (bytes) => this.receive(this.#stdout, bytes),
                stderr: (bytes) => this.receive(this.#stderr, bytes),
            },
            (error) => {
                this.#failure = error;
            }
        );
        this.#finished = this.finish();
    }

    wait(): Promise<RuntimeCommandResult> {
        return this.#finished;
    }

    /**
     * Writes to the command's standard input. A write to a command that has
     * exited is dropped, as a local pipe drops it, so the runner fails on the
     * exit and the standard error `wait()` delivers, not on the toolbox
     * refusing input to a command it has already cleaned up.
     */
    async sendStdin(data: string | Uint8Array): Promise<void> {
        try {
            await this.transport.request(
                'POST',
                `${this.session}/command/${this.command}/input`,
                {
                    absolute: true,
                    json: {
                        data:
                            typeof data === 'string'
                                ? data
                                : new TextDecoder().decode(data),
                    },
                }
            );
        } catch (error) {
            // The follower learns of an exit only after its log stream closes,
            // which can trail the refused write, and waiting on `exit()` would
            // last as long as a running command. One status read through the
            // follower answers now, bounded by the transport's request timeout.
            const exited = await this.#follower.hasExited().catch(() => false);
            if (!exited) throw error;
        }
    }

    async closeStdin(): Promise<void> {
        // The toolbox has no end-of-input operation. Runners that read input
        // finish a turn on their own result and end a session by being
        // stopped, so they never wait for EOF.
    }

    async kill(): Promise<void> {
        this.#killed = true;
        await this.#follower.stop();
    }

    /**
     * Resolves once the command has exited and every byte of its output has
     * reached its receiver. A known exit code is kept even when the output
     * after it could not be read, and the session is always ended.
     */
    private async finish(): Promise<RuntimeCommandResult> {
        try {
            const code = await this.#follower.exit();
            this.receive(this.#stdout);
            this.receive(this.#stderr);
            if (code !== undefined && !this.#killed && this.stderrFile) {
                const text = await this.stderrFile.collect();
                if (text)
                    this.#delivery = this.#delivery.then(() =>
                        this.#stderr.deliver(text)
                    );
            }
            await this.#delivery;
            if (this.#killed) return { code: stoppedCode, stdout: '', stderr: '' };
            if (code === undefined) {
                throw (
                    this.#failure ??
                    new DaytonaApiError(
                        'The Daytona log stream ended before the command exited'
                    )
                );
            }
            return {
                code,
                stdout: this.#stdout.kept,
                stderr: this.#stderr.kept,
            };
        } finally {
            // A kill has already ended the session.
            if (!this.#killed) await this.#follower.stop();
            await this.stderrFile?.discard();
        }
    }

    /** Queues new output for its receiver. Without bytes, ends the stream. */
    private receive(output: CommandOutput, bytes?: Uint8Array): void {
        const text = output.decode(bytes);
        if (text) this.#delivery = this.#delivery.then(() => output.deliver(text));
    }
}

/**
 * One stream of a command's output. It decodes bytes as they arrive, keeping
 * a character split across chunks whole, and hands the text to its receiver,
 * or keeps it when there is none.
 */
class CommandOutput {
    readonly #decoder = new TextDecoder();
    #kept = '';

    constructor(
        private readonly receiver: ((data: string) => void | Promise<void>) | undefined
    ) {}

    get kept(): string {
        return this.#kept;
    }

    decode(bytes: Uint8Array | undefined): string {
        return bytes
            ? this.#decoder.decode(bytes, { stream: true })
            : this.#decoder.decode();
    }

    async deliver(text: string): Promise<void> {
        if (this.receiver) await this.receiver(text);
        else this.#kept += text;
    }
}
