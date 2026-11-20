import { RegistryClient } from '../registry/client.js';
import type { CloudClient } from './client.js';

export interface CloudProject extends Record<string, unknown> {
    name: string;
    slug: string;
}

/** Organization projects on the optional hosted service. */
export class CloudProjects {
    constructor(private readonly client: Pick<CloudClient, 'request'>) {}

    async list(): Promise<CloudProject[]> {
        const value = await this.client.request('/v1/projects');
        if (!RegistryClient.isRecord(value) || !Array.isArray(value.projects))
            throw new Error('The cloud API returned a malformed project list');
        return value.projects.map(parseProject);
    }

    async create(name: string): Promise<CloudProject> {
        return parseProject(
            await this.client.request('/v1/projects', {
                method: 'POST',
                body: { name },
            })
        );
    }
}

function parseProject(value: unknown): CloudProject {
    if (
        !RegistryClient.isRecord(value) ||
        typeof value.name !== 'string' ||
        typeof value.slug !== 'string'
    )
        throw new Error('The cloud API returned a malformed project');
    return { ...value, name: value.name, slug: value.slug };
}
