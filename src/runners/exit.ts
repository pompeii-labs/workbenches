/** Exit code of a process the kernel killed with SIGKILL: 128 + 9. */
const killedExitCode = 137;
/** The same kill as a runtime that reports the negated signal number reports it. */
const killedSignalCode = -9;

/**
 * Turns the exit of a runner's native process into the message of a failure.
 * Every runner uses it, so they all report a kill the same way. In a container
 * or sandbox a SIGKILL almost always comes from the kernel's out of memory
 * killer, so that is said plainly, naming the exit code the runtime reported
 * (137 or -9). Any other exit keeps its plain code.
 */
export class RunnerProcessExit {
    /** `label` names the process in the message, such as "Pi RPC". */
    constructor(private readonly label: string) {}

    /** Whether `code` is a SIGKILL. */
    static killed(code: number | null | undefined): boolean {
        return code === killedExitCode || code === killedSignalCode;
    }

    /** The failure message for an exit, with the process's own explanation when it gave one. */
    message(code: number | null | undefined, detail?: string): string {
        if (RunnerProcessExit.killed(code)) {
            const base = `${this.label} was killed (exit ${code}), most likely out of memory.`;
            return detail ? `${base} Last output: ${detail}` : base;
        }
        return `${this.label} exited with code ${code}${detail ? `: ${detail}` : ''}`;
    }
}
