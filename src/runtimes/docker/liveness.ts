import { DockerClient } from './client.js';
import type { DockerClientDependencies } from './contracts.js';

/** Bounded inspection and removal by run label, independent of the runner process. */
export class DockerRunContainers {
    private readonly client: DockerClient | undefined;

    constructor(
        dependencies: DockerClientDependencies = {},
        environment: Record<string, string | undefined> = process.env
    ) {
        const executable = (dependencies.findExecutable ?? Bun.which)('docker');
        if (executable)
            this.client = new DockerClient(executable, dependencies, [], environment);
    }

    async exists(runId: string): Promise<boolean | undefined> {
        const ids = await this.list(runId);
        return ids === undefined ? undefined : ids.length > 0;
    }

    async remove(runId: string): Promise<void> {
        const ids = await this.list(runId);
        if (!this.client || !ids?.length) return;
        const result = await this.client.run(
            [this.client.executable, 'container', 'rm', '--force', ...ids],
            { timeout: 10_000 }
        );
        if (result.code !== 0) throw new Error('Could not remove the run containers');
    }

    private async list(runId: string): Promise<string[] | undefined> {
        if (!this.client) return undefined;
        try {
            const result = await this.client.run(
                [
                    this.client.executable,
                    'container',
                    'ls',
                    '--all',
                    '--filter',
                    `label=dev.workbenches.run=${runId}`,
                    '--format',
                    '{{.ID}}',
                ],
                { timeout: 10_000 }
            );
            if (result.code !== 0) return undefined;
            const ids = result.stdout.split(/\s+/).filter(Boolean);
            return ids.every((id) => /^[a-f0-9]{12,64}$/.test(id)) ? ids : undefined;
        } catch {
            return undefined;
        }
    }
}
