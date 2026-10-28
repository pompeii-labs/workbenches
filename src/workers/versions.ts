import type { Runner } from '../runners/runner.js';
import { WorkerRejection } from './contracts.js';
import { probe, type WorkerProbeCommand } from './machine.js';

/**
 * Refuses a local run whose runner CLI on this machine is older than the
 * runner works with, before anything is spent. An old CLI would otherwise
 * fail mid-run on an option it does not know.
 */
export class WorkerRunnerVersions {
    constructor(private readonly command: WorkerProbeCommand = probe) {}

    async check(
        runner: Pick<Runner, 'displayName' | 'executable' | 'minimumVersion'>
    ): Promise<void> {
        const minimum = runner.minimumVersion;
        if (!minimum) return;
        const output = await this.command([runner.executable, '--version']);
        const version = output?.match(/\d+\.\d+\.\d+/)?.[0];
        // A CLI that is missing or says no version is left to preflight.
        if (!version || Bun.semver.order(version, minimum) >= 0) return;
        throw new WorkerRejection(
            `${runner.displayName} ${version} on this worker is older than ${minimum}, the oldest release Workbench works with. Update it on the worker.`
        );
    }
}
