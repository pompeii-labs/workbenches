import { DockerClient } from './client.js';
import type { DockerRuntimeDependencies } from './contracts.js';

const managedLabel = 'dev.workbenches.managed';
const runLabel = 'dev.workbenches.run';
const scopeLabel = 'dev.workbenches.scope';

export interface ManagedDockerContainer {
    id: string;
    name: string;
    runId: string;
}

export class DockerManagedContainers {
    private constructor(
        private readonly client: DockerClient,
        readonly scope: string
    ) {}

    static labels(run: { id: string; scope: string }): string[] {
        DockerManagedContainers.validateRun(run.id);
        DockerManagedContainers.validateScope(run.scope);
        return [
            '--label',
            `${managedLabel}=true`,
            '--label',
            `${runLabel}=${run.id}`,
            '--label',
            `${scopeLabel}=${run.scope}`,
        ];
    }

    static async connect(
        scope: string,
        dependencies: DockerRuntimeDependencies = {}
    ): Promise<DockerManagedContainers | undefined> {
        DockerManagedContainers.validateScope(scope);
        const executable = (dependencies.findExecutable ?? Bun.which)('docker');
        if (!executable) return undefined;
        const client = new DockerClient(executable, dependencies, []);
        const available = await client.run([
            executable,
            'version',
            '--format',
            '{{.Server.Version}}',
        ]);
        if (available.code !== 0) return undefined;
        return new DockerManagedContainers(client, scope);
    }

    async list(): Promise<ManagedDockerContainer[]> {
        const result = await this.client.require(
            [
                this.client.executable,
                'container',
                'ls',
                '--all',
                '--filter',
                `label=${managedLabel}=true`,
                '--filter',
                `label=${scopeLabel}=${this.scope}`,
                '--format',
                `{{.ID}}\t{{.Names}}\t{{.Label "${runLabel}"}}`,
            ],
            'Failed to inspect managed Workbench containers'
        );
        return result.stdout
            .split(/\r?\n/)
            .filter(Boolean)
            .flatMap((line) => {
                const [id, name, runId] = line.split('\t');
                if (
                    !id ||
                    !name ||
                    !runId ||
                    !/^[a-f0-9]{12,64}$/.test(id) ||
                    !/^workbench-[a-f0-9]{20}$/.test(name) ||
                    !/^wb_[a-z0-9]{20,64}$/.test(runId)
                ) {
                    return [];
                }
                return [{ id, name, runId }];
            });
    }

    async remove(container: ManagedDockerContainer): Promise<void> {
        const result = await this.client.run([
            this.client.executable,
            'container',
            'rm',
            '--force',
            container.id,
        ]);
        if (result.code !== 0 && !result.stderr.includes('No such container')) {
            throw new Error(
                this.client.diagnostic(
                    result,
                    `Failed to remove managed Workbench container ${container.name}`
                )
            );
        }
    }

    private static validateRun(id: string): void {
        if (!/^wb_[a-z0-9]{20,64}$/.test(id)) {
            throw new Error(`Invalid managed Workbench run ID: ${id}`);
        }
    }

    private static validateScope(scope: string): void {
        if (!/^[a-f0-9]{24}$/.test(scope)) {
            throw new Error(`Invalid managed Workbench scope: ${scope}`);
        }
    }
}
