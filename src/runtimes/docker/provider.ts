import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HostOutcomeCapture } from '../../outcomes/index.js';
import { RequirementsPreflight } from '../../workbench/requirements.js';
import { requirementsOf, selectedRuntime } from '../../workbench/runtimes.js';
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

    private readonly requirements: RequirementsPreflight;

    constructor(private readonly dependencies: DockerRuntimeDependencies) {
        this.findExecutable = dependencies.findExecutable ?? Bun.which;
        this.requirements = new RequirementsPreflight(dependencies.host);
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
        const runtime = selectedRuntime(request.workbench);
        if (!runtime.image) {
            throw new RuntimeError(
                this.name,
                'prepare',
                'Docker runtime requires an image or local image build'
            );
        }
        try {
            this.requirements.check(request.workbench);
        } catch (error) {
            throw RuntimeError.from(this.name, 'prepare', error);
        }
        const needsHostDocker =
            (request.purpose ?? 'run') === 'run' &&
            runtime.docker?.engine !== undefined;
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
        // cpu and memory become container limits for the run, never for an
        // image build, so only a run checks that the daemon can satisfy them.
        const requirements = requirementsOf(request.workbench.manifest);
        if (
            request.purpose !== 'build' &&
            (requirements.cpu !== undefined || requirements.memory_gb !== undefined)
        ) {
            try {
                this.requirements.checkDaemon(
                    request.workbench,
                    await client.daemonCapacity()
                );
            } catch (error) {
                throw RuntimeError.from(this.name, 'prepare', error);
            }
        }
        const hostSocket = needsHostDocker
            ? await client.resolveHostSocket()
            : undefined;
        const image = await new DockerImageManager(client).prepare(request);
        let stateDirectory: string | undefined;
        let outcome: HostOutcomeCapture | undefined;
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
            outcome = request.outcome
                ? await HostOutcomeCapture.create(request)
                : undefined;
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
                ...(outcome ? { outcome } : {}),
                requirements: this.requirements,
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
                ...(outcome ? [outcome.cleanup()] : []),
            ]);
            throw error;
        }
    }
}
