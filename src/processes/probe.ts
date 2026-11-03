import { readFileSync } from 'node:fs';

const COMMAND_TIMEOUT_MILLISECONDS = 2_000;

/**
 * The one way the engine asks about a process by pid. Only ESRCH proves a
 * process is gone: a process owned by another user answers a signal probe
 * with EPERM, and an inaccessible process still counts as alive.
 */
export class ProcessProbe {
    /** Whether the pid may still name a live process. */
    alive(pid: number): boolean {
        if (!Number.isSafeInteger(pid) || pid <= 0) return false;
        try {
            process.kill(pid, 0);
            return true;
        } catch (error) {
            const code = error instanceof Error && 'code' in error ? error.code : '';
            return code !== 'ESRCH';
        }
    }

    /** The command line of the process, or undefined when it cannot be read. */
    command(pid: number): string | undefined {
        try {
            if (process.platform === 'linux') {
                const text = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
                    .split('\0')
                    .join(' ')
                    .trim();
                return text || undefined;
            }
            const result = Bun.spawnSync(
                ['ps', '-ww', '-o', 'command=', '-p', String(pid)],
                {
                    stdout: 'pipe',
                    stderr: 'ignore',
                    timeout: COMMAND_TIMEOUT_MILLISECONDS,
                }
            );
            if (result.exitCode !== 0) return undefined;
            const text = result.stdout.toString().trim();
            return text || undefined;
        } catch {
            return undefined;
        }
    }

    /** The pids of every process started under the pid, at any depth. */
    descendants(pid: number): number[] {
        try {
            const result = Bun.spawnSync(['ps', '-A', '-o', 'pid=,ppid='], {
                stdout: 'pipe',
                stderr: 'ignore',
                timeout: COMMAND_TIMEOUT_MILLISECONDS,
            });
            if (result.exitCode !== 0) return [];
            const children = new Map<number, number[]>();
            for (const line of result.stdout.toString().split('\n')) {
                const [child, parent] = line.trim().split(/\s+/).map(Number);
                if (!child || !parent) continue;
                children.set(parent, [...(children.get(parent) ?? []), child]);
            }
            const found: number[] = [];
            const pending = [pid];
            for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
                for (const child of children.get(next) ?? []) {
                    found.push(child);
                    pending.push(child);
                }
            }
            return found;
        } catch {
            return [];
        }
    }
}
