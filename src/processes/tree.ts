import { ProcessProbe } from './probe.js';

/** Stops a host process and every child it started, including signal-ignoring children. */
export class ProcessTree {
    constructor(
        private readonly probe: Pick<ProcessProbe, 'descendants'> = new ProcessProbe(),
        private readonly kill: (pid: number) => void = (pid) =>
            process.kill(pid, 'SIGKILL')
    ) {}

    stop(pid: number): void {
        const children = this.probe.descendants(pid);
        for (const target of [...children.reverse(), pid]) {
            try {
                this.kill(target);
            } catch {
                // A process may have exited between discovery and the signal.
            }
        }
    }
}
