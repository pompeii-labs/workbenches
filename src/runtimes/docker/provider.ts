import { HostCredentialFiles } from '../../connections/credentials.js';
import { HostOutcomeCapture } from '../../outcomes/index.js';
import { RequirementsPreflight } from '../../workbench/requirements.js';
import { requirementsOf, selectedRuntime } from '../../workbench/runtimes.js';
import type {
    PreparedRuntime,
    RuntimePrepareRequest,
    RuntimeProvider,
} from '../contracts.js';
import { RuntimeError } from '../error.js';
import { readCredentialRoot } from '../hostvariables.js';
import { DockerClient } from './client.js';
import type { DockerRuntimeDependencies } from './contracts.js';
import {
    DockerCredentialMount,
    type DockerCredentials,
    DockerCredentialVolume,
} from './credentials.js';
import { DockerImageManager } from './images.js';
import { DockerMountPlan } from './mounts.js';
import { DockerRuntime } from './runtime.js';

export class DockerRuntimeProvider implements RuntimeProvider {
    readonly name = 'docker';
    readonly placement = 'container' as const;
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
            DockerMountPlan.environmentNames(request.workbench),
            request.environment
        );
        await client.require(
            [executable, 'version', '--format', '{{.Server.Version}}'],
            'Docker daemon is unavailable'
        );
        // cpu and memory become container limits for the run, never for an
        // image build, so only a run checks that the daemon can satisfy them.
        // A GPU reaches the run's containers only through the NVIDIA runtime.
        const requirements = requirementsOf(request.workbench.manifest);
        const limited =
            requirements.cpu !== undefined || requirements.memory_gb !== undefined;
        if (request.purpose !== 'build' && (limited || requirements.gpu)) {
            try {
                if (limited)
                    this.requirements.checkDaemon(
                        request.workbench,
                        await client.daemonCapacity()
                    );
                if (requirements.gpu)
                    this.requirements.checkDaemonRuntimes(
                        request.workbench,
                        await client.daemonRuntimes()
                    );
            } catch (error) {
                throw RuntimeError.from(this.name, 'prepare', error);
            }
        }
        const hostSocket = needsHostDocker
            ? await client.resolveHostSocket()
            : undefined;
        const image = await new DockerImageManager(client).prepare(request);
        let outcome: HostOutcomeCapture | undefined;
        try {
            const credentials =
                request.purpose === 'build'
                    ? undefined
                    : await this.credentials(
                          request,
                          client,
                          image.preparation.immutableReference
                      );
            const mounts = new DockerMountPlan(request, hostSocket);
            await mounts.verify();
            outcome = request.outcome
                ? await HostOutcomeCapture.create(request)
                : undefined;
            return new DockerRuntime({
                request,
                client,
                ...(hostSocket ? { hostSocket } : {}),
                mounts,
                ...(credentials ? { credentials } : {}),
                preparation: image.preparation,
                ...(outcome ? { outcome } : {}),
                requirements: this.requirements,
                cleanupPreparation: () => image.cleanup(),
            });
        } catch (error) {
            await Promise.all([
                image.cleanup(),
                ...(outcome ? [outcome.cleanup()] : []),
            ]);
            throw error;
        }
    }

    /**
     * The runner's credential root. A worker names the starting member's own
     * sign-ins, which any runner may keep there. Otherwise it is the Workbench
     * home's volume, and a runner without a credential file gets none.
     */
    private async credentials(
        request: RuntimePrepareRequest,
        client: DockerClient,
        image: string
    ): Promise<DockerCredentials | undefined> {
        const runner = request.runner;
        if (!runner) return undefined;
        const root = readCredentialRoot(request.environment);
        if (root)
            return new DockerCredentialMount(
                root,
                new HostCredentialFiles(root),
                runner
            );
        if (!runner.credentialEnvironment) return undefined;
        const volume = new DockerCredentialVolume(
            client,
            image,
            request.workbench.manifest.runner,
            runner,
            client.user
        );
        await volume.prepare();
        return volume;
    }
}
