/**
 * Linux signal numbers by the name E2B's sandbox daemon reports. The daemon is
 * written in Go, which describes a signalled process as `signal: <name>`.
 */
const signals: Record<string, number> = {
    hangup: 1,
    interrupt: 2,
    quit: 3,
    'illegal instruction': 4,
    'trace/breakpoint trap': 5,
    aborted: 6,
    'bus error': 7,
    'floating point exception': 8,
    killed: 9,
    'user defined signal 1': 10,
    'segmentation fault': 11,
    'user defined signal 2': 12,
    'broken pipe': 13,
    'alarm clock': 14,
    terminated: 15,
};

/**
 * The exit code of an E2B command, as a shell reports it. E2B reports a process
 * a signal ended with exit code -1 and the signal's name in `error`, so it is
 * turned into 128 plus the signal number, the code a local or Docker process
 * reports for the same signal. An out of memory kill then reads as 137, the
 * code every runner already explains. Any other exit keeps its code.
 */
export function e2bExitCode(exitCode: number, error?: string | undefined): number {
    if (exitCode !== -1 || !error) return exitCode;
    const name = /\bsignal: ([a-z0-9 /]+?)(?: \(core dumped\))?$/.exec(
        error.trim()
    )?.[1];
    const signal = name === undefined ? undefined : signals[name];
    return signal === undefined ? exitCode : 128 + signal;
}
