import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
    PreparedRuntime,
    RuntimePrepareRequest,
    RuntimeProvider,
} from '../contracts.js';
import { RuntimeError } from '../error.js';
import { DockerClient } from './client.js';
import type { DockerRuntimeDependencies } from './contracts.js';
import { DockerCredentialVolume } from './credentials.js';
import { DockerImageManager } from './images.js';
import { DockerMountPlan } from './mounts.js';
import { DockerRuntime } from './runtime.js';

export class DockerRuntimeProvider implements RuntimeProvider {
    readonly name = 'docker';
    private readonly findExecutable: (name: string) => string | null;

    constructor(private readonly dependencies: DockerRuntimeDependencies = {}) {
        this.findExecutable = dependencies.findExecutable ?? Bun.which;
    }

    async prepare(request: RuntimePrepareRequest): Promise<PreparedRuntime> {
        const executable = this.findExecutable('docker');
        if (!executable) {
            throw new RuntimeError(
                this.name,
                'prepare',
                'Docker CLI is unavailable on the host'
            );
        }
        if (!request.workbench.manifest.image) {
            throw new RuntimeError(
                this.name,
                'prepare',
                'Docker runtime requires an image or local image build'
            );
        }
        const needsHostDocker =
            (request.purpose ?? 'run') === 'run' &&
            request.workbench.manifest.docker?.engine !== undefined;
        if (needsHostDocker && !request.authorizations?.hostDocker) {
            throw new RuntimeError(
                this.name,
                'bind',
                'Host Docker engine access requires explicit --allow-host-docker authorization'
            );
        }

        const client = new DockerClient(
            executable,
            this.dependencies,
            DockerMountPlan.environmentNames(request.workbench)
        );
        await client.require(
            [executable, 'version', '--format', '{{.Server.Version}}'],
            'Docker daemon is unavailable'
        );
        const hostSocket = needsHostDocker
            ? await client.resolveHostSocket()
            : undefined;
        const image = await new DockerImageManager(client).prepare(request);
        let stateDirectory: string | undefined;
        try {
            const credentials =
                request.purpose === 'build'
                    ? undefined
                    : new DockerCredentialVolume(
                          client,
                          image.preparation.immutableReference,
                          request.workbench.manifest.runner,
                          client.user
                      );
            await credentials?.prepare();
            const mounts = new DockerMountPlan(request, hostSocket);
            await mounts.verify();
            const directory = await mkdtemp(
                join(tmpdir(), 'workbench-docker-runtime-')
            );
            stateDirectory = directory;
            return new DockerRuntime({
                request,
                client,
                ...(hostSocket ? { hostSocket } : {}),
                mounts,
                ...(credentials ? { credentials } : {}),
                preparation: image.preparation,
                stateDirectory: directory,
                cleanupPreparation: async () => {
                    await Promise.all([
                        image.cleanup(),
                        rm(directory, {
                            recursive: true,
                            force: true,
                        }),
                    ]);
                },
            });
        } catch (error) {
            await Promise.all([
                image.cleanup(),
                ...(stateDirectory
                    ? [rm(stateDirectory, { recursive: true, force: true })]
                    : []),
            ]);
            throw error;
        }
    }
}
