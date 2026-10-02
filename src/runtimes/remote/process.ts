import type { SpawnedRunner } from '../../types.js';
import type { RuntimeCommandResult } from '../contracts.js';

/** A command started inside a remote sandbox. */
export interface RemoteCommand {
    wait(): Promise<RuntimeCommandResult>;
    sendStdin(data: string | Uint8Array): Promise<void>;
    closeStdin(): Promise<void>;
    kill(): Promise<void>;
}

/** How a sandbox starts a command in the background. */
export interface RemoteCommandOptions {
    cwd?: string;
    env?: Record<string, string>;
    /** Keep standard input open so the engine can write to the command. */
    stdin?: boolean;
    onStdout?: (data: string) => void | Promise<void>;
    onStderr?: (data: string) => void | Promise<void>;
}

/** Where a sandbox delivers a command's output as it arrives. */
export interface RemoteOutput {
    onStdout(data: string): void;
    onStderr(data: string): void;
}

/** Starts a command whose output goes to `output`. */
export interface RemoteLauncher {
    start(output: RemoteOutput): Promise<RemoteCommand>;
}

/**
 * Adapts a remote command to the runner's process contract: output arrives as
 * web streams, input goes to the command, and `spawned.exited` settles with its
 * exit code. Output the sandbox only reports at the end is still delivered.
 */
export class RemoteProcess {
    readonly spawned: SpawnedRunner;
    private readonly command: Promise<RemoteCommand>;
    private stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
    private stderrController: ReadableStreamDefaultController<Uint8Array> | undefined;
    private streamedStdout = false;
    private streamedStderr = false;
    private readonly encoder = new TextEncoder();

    constructor(launcher: RemoteLauncher, stdin: boolean) {
        const stdout = new ReadableStream<Uint8Array>({
            start: (controller) => {
                this.stdoutController = controller;
            },
        });
        const stderr = new ReadableStream<Uint8Array>({
            start: (controller) => {
                this.stderrController = controller;
            },
        });
        this.command = launcher.start({
            onStdout: (data) => {
                this.streamedStdout = true;
                this.stdoutController = this.enqueue(this.stdoutController, data);
            },
            onStderr: (data) => {
                this.streamedStderr = true;
                this.stderrController = this.enqueue(this.stderrController, data);
            },
        });
        const exited = this.command
            .then((handle) => handle.wait())
            .then((result) => {
                if (!this.streamedStdout && result.stdout) {
                    this.stdoutController = this.enqueue(
                        this.stdoutController,
                        result.stdout
                    );
                }
                if (!this.streamedStderr && result.stderr) {
                    this.stderrController = this.enqueue(
                        this.stderrController,
                        result.stderr
                    );
                }
                return result.code;
            })
            .finally(() => {
                this.stdoutController = this.close(this.stdoutController);
                this.stderrController = this.close(this.stderrController);
            });
        this.spawned = {
            stdout,
            stderr,
            exited,
            ...(stdin
                ? {
                      stdin: {
                          write: (value: string | Uint8Array) =>
                              this.command.then((handle) => handle.sendStdin(value)),
                          flush: () => Promise.resolve(),
                          end: () => this.command.then((handle) => handle.closeStdin()),
                      },
                  }
                : {}),
            kill: () => {
                void this.kill();
            },
        };
    }

    /** Stops the command. A command that never started or already ended is left alone. */
    async kill(): Promise<void> {
        await this.command.then((handle) => handle.kill()).catch(() => {});
    }

    /** Writes to a stream, or returns undefined once it has closed. */
    private enqueue(
        controller: ReadableStreamDefaultController<Uint8Array> | undefined,
        data: string
    ): ReadableStreamDefaultController<Uint8Array> | undefined {
        if (!controller) return undefined;
        try {
            controller.enqueue(this.encoder.encode(data));
            return controller;
        } catch {
            return undefined;
        }
    }

    private close(
        controller: ReadableStreamDefaultController<Uint8Array> | undefined
    ): undefined {
        try {
            controller?.close();
        } catch {}
        return undefined;
    }
}
