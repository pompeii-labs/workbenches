export interface CommandResult {
    code: number;
    stdout: string;
    stderr: string;
}

/**
 * Runs host commands such as the Docker CLI. Each spawn passes the current
 * environment explicitly, because Bun otherwise keeps the one it started with
 * and resolves executables from a stale PATH.
 */
export class HostCommands {
    async run(args: string[]): Promise<CommandResult> {
        let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
        try {
            child = Bun.spawn(args, {
                env: process.env,
                stdin: 'ignore',
                stdout: 'pipe',
                stderr: 'pipe',
            });
        } catch (error) {
            throw new Error(
                error instanceof Error
                    ? error.message
                    : `Could not run ${args[0] ?? 'command'}`
            );
        }
        const [code, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
        ]);
        return { code, stdout, stderr };
    }

    /** Runs a command to completion, or undefined when it cannot start. */
    runSync(args: string[]): CommandResult | undefined {
        try {
            const result = Bun.spawnSync(args, {
                env: process.env,
                stdin: 'ignore',
                stdout: 'pipe',
                stderr: 'pipe',
            });
            return {
                code: result.exitCode,
                stdout: new TextDecoder().decode(result.stdout),
                stderr: new TextDecoder().decode(result.stderr),
            };
        } catch {
            return undefined;
        }
    }

    /**
     * Starts a detached launcher such as `open`, and reports whether it
     * succeeded. One still running after two seconds has handed off.
     */
    async launch(args: string[]): Promise<boolean> {
        let child: Bun.Subprocess;
        try {
            child = Bun.spawn(args, {
                env: process.env,
                stdin: 'ignore',
                stdout: 'ignore',
                stderr: 'ignore',
                detached: true,
            });
        } catch {
            return false;
        }
        const code = await Promise.race([child.exited, Bun.sleep(2_000).then(() => 0)]);
        child.unref();
        return code === 0;
    }
}
