import type { SpawnedRunner } from '../types.js';
import type { RuntimeCommandResult } from './contracts.js';

/** A command started inside a remote sandbox. */
export interface RemoteCommand {
    wait(): Promise<RuntimeCommandResult>;
    sendStdin(data: string | Uint8Array): Promise<void>;
    closeStdin(): Promise<void>;
    kill(): Promise<void>;
}

export interface ActiveRemoteProcess {
    command: Promise<RemoteCommand>;
    process: SpawnedRunner;
}

/**
 * Adapts a remote command to the runner's process contract: output arrives as
 * web streams, input goes to the command, and `exited` settles with its code.
 * `start` receives the output callbacks to hand to the sandbox.
 */
export function launchRemoteProcess(options: {
    stdin: boolean;
    start(callbacks: {
        onStdout(data: string): void;
        onStderr(data: string): void;
    }): Promise<RemoteCommand>;
    /** Called once the command has ended, to forget it. */
    onExit(active: ActiveRemoteProcess): void;
}): ActiveRemoteProcess {
    let stdoutController: ReadableStreamDefaultController<Uint8Array>;
    let stderrController: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({
        start: (controller) => {
            stdoutController = controller;
        },
    });
    const stderr = new ReadableStream<Uint8Array>({
        start: (controller) => {
            stderrController = controller;
        },
    });
    const encoder = new TextEncoder();
    let streamedStdout = false;
    let streamedStderr = false;
    let stdoutOpen = true;
    let stderrOpen = true;
    const enqueueStdout = (data: string) => {
        if (!stdoutOpen) return;
        try {
            stdoutController.enqueue(encoder.encode(data));
        } catch {
            stdoutOpen = false;
        }
    };
    const enqueueStderr = (data: string) => {
        if (!stderrOpen) return;
        try {
            stderrController.enqueue(encoder.encode(data));
        } catch {
            stderrOpen = false;
        }
    };
    const command = options.start({
        onStdout: (data) => {
            streamedStdout = true;
            enqueueStdout(data);
        },
        onStderr: (data) => {
            streamedStderr = true;
            enqueueStderr(data);
        },
    });
    let active: ActiveRemoteProcess;
    const closeOutputs = () => {
        if (stdoutOpen) {
            stdoutOpen = false;
            try {
                stdoutController.close();
            } catch {}
        }
        if (stderrOpen) {
            stderrOpen = false;
            try {
                stderrController.close();
            } catch {}
        }
    };
    const exited = command
        .then((handle) => handle.wait())
        .then((result) => {
            if (!streamedStdout && result.stdout) {
                enqueueStdout(result.stdout);
            }
            if (!streamedStderr && result.stderr) {
                enqueueStderr(result.stderr);
            }
            return result.code;
        })
        .finally(() => {
            options.onExit(active);
            closeOutputs();
        });
    const process: SpawnedRunner = {
        stdout,
        stderr,
        exited,
        ...(options.stdin
            ? {
                  stdin: {
                      write: (value: string | Uint8Array) =>
                          command.then((handle) => handle.sendStdin(value)),
                      flush: () => Promise.resolve(),
                      end: () => command.then((handle) => handle.closeStdin()),
                  },
              }
            : {}),
        kill: () => {
            void command.then((handle) => handle.kill()).catch(() => {});
        },
    };
    active = { command, process };
    return active;
}
