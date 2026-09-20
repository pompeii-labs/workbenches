import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RuntimePrepareRequest } from '../contracts.js';
import {
    installRepositoryTools,
    needsRepositoryTools,
    repositoryToolsCacheKey,
} from '../repository-tools.js';
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
        const original =
            typeof image === 'string'
                ? await this.pull(image)
                : await this.build(request);
        if (!needsRepositoryTools(request)) return original;
        try {
            const prepared = await this.withRepositoryTools(original.preparation);
            return { preparation: prepared, cleanup: original.cleanup };
        } catch (error) {
            await original.cleanup();
            throw error;
        }
    }

    private async withRepositoryTools(
        original: DockerPreparation
    ): Promise<DockerPreparation> {
        const base = original.immutableReference;
        // BuildKit does not accept a bare local sha256 image ID in FROM. Local
        // builds already have a content-addressed Workbench tag we can use.
        const buildBase = base.startsWith('sha256:') ? original.reference : base;
        const digest = createHash('sha256')
            .update(JSON.stringify({ base, repositoryToolsCacheKey }))
            .digest('hex');
        const tag = `workbench-repository-tools:${digest.slice(0, 24)}`;
        const cached = await this.client.inspectImage(tag);
        if (cached?.Id) {
            return {
                ...original,
                reference: tag,
                immutableReference: cached.Id,
                action: 'cache-hit',
            };
        }
        const image = await this.client.inspectImage(base);
        if (!image) throw new Error(`Base Docker image is unavailable: ${base}`);
        const originalUser = image.Config?.User ?? '';
        if (originalUser && !/^[a-zA-Z0-9_.:-]+$/.test(originalUser)) {
            throw new Error('Base Docker image has an unsupported user declaration');
        }
        const context = await mkdtemp(join(tmpdir(), 'workbench-repository-tools-'));
        try {
            const dockerfile = join(context, 'Dockerfile');
            await Promise.all([
                writeFile(join(context, 'install.sh'), `${installRepositoryTools}\n`),
                writeFile(
                    dockerfile,
                    [
                        `FROM ${buildBase}`,
                        'USER root',
                        'COPY install.sh /tmp/workbench-repository-tools.sh',
                        'RUN /bin/sh /tmp/workbench-repository-tools.sh && rm /tmp/workbench-repository-tools.sh',
                        ...(originalUser ? [`USER ${originalUser}`] : []),
                        '',
                    ].join('\n')
                ),
            ]);
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
                    dockerfile,
                    context,
                ],
                'Failed to provision engine-managed Git tools in Docker image',
                { env: { ...process.env, BUILDX_METADATA_PROVENANCE: 'min' } }
            );
            const prepared = await this.client.inspectImage(tag);
            if (!prepared?.Id) {
                throw new Error(
                    `Provisioned Docker image could not be inspected: ${tag}`
                );
            }
            return {
                ...original,
                reference: tag,
                immutableReference: prepared.Id,
                action: 'built',
            };
        } finally {
            await rm(context, { recursive: true, force: true });
        }
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
