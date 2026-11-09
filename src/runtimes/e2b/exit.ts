/** Linux signal numbers by the name E2B reports in `signal: <name>`. */
const signals: Record<string, number> = {
    interrupt: 2,
    killed: 9,
    'segmentation fault': 11,
    terminated: 15,
};

/** An E2B exit code as a shell reports it: a signal kill is 128 plus the signal number. */
export function e2bExitCode(exitCode: number, error?: string | undefined): number {
    if (exitCode !== -1 || !error) return exitCode;
    const name = /\bsignal: ([a-z ]+?)(?: \(core dumped\))?$/.exec(error.trim())?.[1];
    const signal = name === undefined ? undefined : signals[name];
    return signal === undefined ? exitCode : 128 + signal;
}
