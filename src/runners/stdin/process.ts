import type { PreparedRuntime } from '../../runtimes/contracts.js';
import type { RunnerInvocation } from '../../types.js';
import type { RunnerSessionProgress } from '../session.js';

/**
 * Opens a stdin runner's process in its runtime: a new command, or the running
 * one that saved progress names. Both expose the same input, output, and exit.
 */
export class StdinProcess {
    constructor(
        private readonly runtime: Pick<
            PreparedRuntime,
            'launchSession' | 'attachSession' | 'cancel'
        >
    ) {}

    open(invocation: RunnerInvocation, progress?: RunnerSessionProgress) {
        if (progress && (!progress.handle || !this.runtime.attachSession)) {
            throw new Error(
                'Saved session progress requires a process handle and runtime attachSession'
            );
        }
        const child = progress?.handle
            ? this.runtime.attachSession?.(progress.handle)
            : this.runtime.launchSession(invocation, { stdin: 'pipe' });
        const input = child?.stdin;
        if (!child || !input) {
            if (child) this.runtime.cancel(child);
            throw new Error('Runtime did not expose session input');
        }
        return {
            ...(child.handle ? { handle: child.handle } : {}),
            exited: child.exited,
            stdin: {
                write: (value: string) => input.write(value),
                flush: () => input.flush?.(),
                end: async () => {
                    await input.end?.();
                },
            },
            ...(child.stdout ? { stdout: child.stdout } : {}),
            ...(child.stderr ? { stderr: child.stderr } : {}),
            kill: () => this.runtime.cancel(child),
        };
    }
}
