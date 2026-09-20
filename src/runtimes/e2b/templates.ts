import { createHash } from 'node:crypto';

import type { RuntimePreparation, RuntimePrepareRequest } from '../contracts.js';
import { DockerBuildContext } from '../docker/build-context.js';
import { needsRepositoryTools, repositoryToolsCacheKey } from '../repository-tools.js';
import type { E2BClient, E2BTemplateSource } from './contracts.js';

export interface PreparedE2BTemplate {
    preparation: RuntimePreparation & {
        kind: 'image';
        reference: string;
        immutableReference: string;
        action: 'built' | 'cache-hit';
    };
    cleanup(): Promise<void>;
}

export class E2BTemplateManager {
    constructor(private readonly client: E2BClient) {}

    async prepare(request: RuntimePrepareRequest): Promise<PreparedE2BTemplate> {
        const image = request.workbench.manifest.image;
        if (!image)
            throw new Error('E2B runtime requires an image or local image build');
        if (typeof image === 'string') {
            return this.prepareSource(
                request,
                {
                    image,
                    ...(needsRepositoryTools(request) ? { repositoryTools: true } : {}),
                },
                image,
                []
            );
        }

        const staged = await DockerBuildContext.stage(request.workbench);
        try {
            const prepared = await this.prepareSource(
                request,
                {
                    dockerfile: staged.dockerfile,
                    context: staged.context,
                    ...(needsRepositoryTools(request) ? { repositoryTools: true } : {}),
                },
                `local:${staged.digest}`,
                staged.excludedPaths,
                staged.digest
            );
            return {
                ...prepared,
                cleanup: () => staged.cleanup(),
            };
        } catch (error) {
            await staged.cleanup();
            throw error;
        }
    }

    private async prepareSource(
        request: RuntimePrepareRequest,
        source: E2BTemplateSource,
        reference: string,
        excludedPaths: string[],
        cacheKey?: string
    ): Promise<PreparedE2BTemplate> {
        const name = templateName(request, reference);
        const prepared = await this.client.prepareTemplate(source, name);
        return {
            preparation: {
                kind: 'image',
                reference,
                immutableReference: prepared.immutableReference,
                action: prepared.action,
                ...(cacheKey ? { cacheKey } : {}),
                ...(excludedPaths.length > 0 ? { excludedPaths } : {}),
            },
            async cleanup() {},
        };
    }
}

function templateName(request: RuntimePrepareRequest, reference: string): string {
    const slug = request.workbench.manifest.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 32);
    const identity = JSON.stringify({
        runtime: 'e2b-v0',
        name: request.workbench.manifest.name,
        version: request.workbench.manifest.version,
        reference,
        ...(needsRepositoryTools(request)
            ? { repositoryTools: repositoryToolsCacheKey }
            : {}),
    });
    const digest = createHash('sha256').update(identity).digest('hex').slice(0, 20);
    return `workbench-${slug || 'runtime'}-${digest}`;
}
