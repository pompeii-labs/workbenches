import { createHash } from 'node:crypto';

import { requirementsOf, selectedRuntime } from '../../workbench/runtimes.js';
import type { RuntimePreparation, RuntimePrepareRequest } from '../contracts.js';
import { DockerBuildContext } from '../docker/build-context.js';
import { needsRepositoryTools, repositoryToolsCacheKey } from '../repository-tools.js';
import type {
    E2BClient,
    E2BTemplateResources,
    E2BTemplateSource,
} from './contracts.js';
import { e2bResources } from './resources.js';

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
        const image = selectedRuntime(request.workbench).image;
        if (!image)
            throw new Error('E2B runtime requires an image or local image build');
        const resources = sized(requirementsOf(request.workbench.manifest));
        if (typeof image === 'string') {
            return this.prepareSource(
                request,
                {
                    image,
                    ...(needsRepositoryTools(request) ? { repositoryTools: true } : {}),
                    ...(resources ? { resources } : {}),
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
                    ...(resources ? { resources } : {}),
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
        const name = templateName(request, reference, source.resources);
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

function sized(
    requirements: ReturnType<typeof requirementsOf>
): E2BTemplateResources | undefined {
    const resources = e2bResources(requirements);
    return Object.keys(resources).length > 0 ? resources : undefined;
}

function templateName(
    request: RuntimePrepareRequest,
    reference: string,
    resources: E2BTemplateResources | undefined
): string {
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
        ...(resources ? { resources } : {}),
    });
    const digest = createHash('sha256').update(identity).digest('hex').slice(0, 20);
    return `workbench-${slug || 'runtime'}-${digest}`;
}
