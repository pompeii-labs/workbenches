import type { RuntimePrepareRequest } from '../contracts.js';
import { DockerBuildContext } from './build-context.js';
import type { DockerClient } from './client.js';
import type { DockerPreparation } from './contracts.js';
import { dockerLocalImage } from './identity.js';

export interface PreparedDockerImage {
    preparation: DockerPreparation;
    cleanup(): Promise<void>;
}

export class DockerImageManager {
    constructor(private readonly client: DockerClient) {}

    async prepare(request: RuntimePrepareRequest): Promise<PreparedDockerImage> {
        const image = request.workbench.manifest.image;
        if (typeof image === 'string') return this.pull(image);
        return this.build(request);
    }

    private async pull(reference: string): Promise<PreparedDockerImage> {
        if (reference.includes('@sha256:')) {
            const cached = await this.client.inspectImage(reference);
            if (cached) {
                return {
                    preparation: {
                        kind: 'image',
                        reference,
                        immutableReference: this.client.immutableReference(
                            reference,
                            cached
                        ),
                        action: 'cache-hit',
                    },
                    async cleanup() {},
                };
            }
        }
        await this.client.require(
            [this.client.executable, 'image', 'pull', '--quiet', reference],
            `Failed to pull Docker image ${reference}`
        );
        const inspected = await this.client.inspectImage(reference);
        if (!inspected) {
            throw new Error(`Pulled Docker image could not be inspected: ${reference}`);
        }
        return {
            preparation: {
                kind: 'image',
                reference,
                immutableReference: this.client.immutableReference(
                    reference,
                    inspected
                ),
                action: 'pulled',
            },
            async cleanup() {},
        };
    }

    private async build(request: RuntimePrepareRequest): Promise<PreparedDockerImage> {
        const image = request.workbench.manifest.image;
        if (!image || typeof image === 'string') {
            throw new Error('Local image build is missing');
        }
        const staged = await DockerBuildContext.stage(request.workbench);
        const tag = dockerLocalImage(request.workbench.manifest.name, staged.digest);
        const cached = await this.client.inspectImage(tag);
        if (cached) {
            return {
                preparation: {
                    kind: 'image',
                    reference: tag,
                    immutableReference: cached.Id ?? tag,
                    action: 'cache-hit',
                    cacheKey: staged.digest,
                    excludedPaths: staged.excludedPaths,
                },
                cleanup: () => staged.cleanup(),
            };
        }
        try {
            await this.client.require(
                [
                    this.client.executable,
                    'buildx',
                    'build',
                    '--load',
                    '--progress',
                    'plain',
                    '--tag',
                    tag,
                    '--file',
                    staged.dockerfile,
                    staged.context,
                ],
                `Failed to build Docker image for ${request.workbench.manifest.name}`,
                { env: { ...process.env, BUILDX_METADATA_PROVENANCE: 'min' } }
            );
            const inspected = await this.client.inspectImage(tag);
            if (!inspected?.Id) {
                throw new Error(`Built Docker image could not be inspected: ${tag}`);
            }
            return {
                preparation: {
                    kind: 'image',
                    reference: tag,
                    immutableReference: inspected.Id,
                    action: 'built',
                    cacheKey: staged.digest,
                    excludedPaths: staged.excludedPaths,
                },
                cleanup: () => staged.cleanup(),
            };
        } catch (error) {
            await staged.cleanup();
            throw error;
        }
    }
}
