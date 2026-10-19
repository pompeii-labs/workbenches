import type { ProjectRecord } from '../database/projects.js';
import type {
    RegistryAccount,
    RegistryAccountStore,
} from '../registry/account-store.js';
import {
    type CloudProject,
    type CloudProjectClient,
    CloudProjectsUnsupportedError,
} from './cloud.js';
import type { ProjectMirror } from './mirror.js';
import { normalizeProjectName, projectSlug } from './name.js';

export interface ProjectListing {
    projects: ProjectRecord[];
    cloud: CloudProject[] | null;
    unsupported: boolean;
}

/**
 * Projects are local without a login. With one, they belong to the default
 * organization in the cloud and the mirror serves them while it is unreachable.
 */
export class ProjectStore {
    constructor(
        private readonly mirror: ProjectMirror,
        private readonly accounts: Pick<RegistryAccountStore, 'current'>,
        private readonly cloud: Pick<CloudProjectClient, 'create' | 'list'>
    ) {}

    async create(value: string): Promise<ProjectRecord> {
        const name = normalizeProjectName(value);
        const account = await this.accounts.current();
        if (!account) return this.mirror.createLocal(name);
        let result: Awaited<ReturnType<CloudProjectClient['create']>>;
        try {
            result = await this.cloud.create(account, name);
        } catch (error) {
            if (error instanceof CloudProjectsUnsupportedError)
                return this.mirror.createLocal(name);
            if (networkError(error)) {
                throw new Error(
                    'Could not reach Workbenches to create the project. Try again, or log out to work locally.'
                );
            }
            throw error;
        }
        if (!result.project)
            throw new Error(result.message ?? `Project already exists: ${name}`);
        return this.mirror.mirror(account.slug, result.project);
    }

    async list(): Promise<ProjectRecord[]> {
        return (await this.load()).projects;
    }

    /** Mirrored projects only, without a cloud request. */
    async mirrored(localOnly: boolean): Promise<ProjectRecord[]> {
        if (localOnly) return this.mirror.local();
        const account = await this.accounts.current();
        return account ? this.mirror.organization(account.slug) : this.mirror.local();
    }

    /** Resolves among mirrored projects only, without a cloud request. */
    async resolveMirrored(value: string, localOnly: boolean): Promise<ProjectRecord> {
        const requested = normalizeProjectName(value);
        if (localOnly) return this.mirror.resolve(requested, null);
        const account = await this.accounts.current();
        return this.mirror.resolve(requested, account?.slug ?? null);
    }

    /** Records a cloud project an organization reported. */
    record(organization: string, project: CloudProject): ProjectRecord {
        return this.mirror.mirror(organization, project);
    }

    async load(): Promise<ProjectListing> {
        const account = await this.accounts.current();
        if (!account)
            return { projects: this.mirror.local(), cloud: null, unsupported: false };
        try {
            await this.mergeLocal(account);
            const cloud = await this.cloud.list(account);
            this.mirror.markMerged(account.slug);
            return {
                projects: this.mirror.refresh(account.slug, cloud),
                cloud,
                unsupported: false,
            };
        } catch (error) {
            if (error instanceof CloudProjectsUnsupportedError) {
                return {
                    projects: this.mirror.local(),
                    cloud: null,
                    unsupported: true,
                };
            }
            if (!networkError(error)) throw error;
        }
        return {
            projects: this.mirror.organization(account.slug),
            cloud: null,
            unsupported: false,
        };
    }

    async resolve(value: string): Promise<ProjectRecord> {
        const requested = normalizeProjectName(value);
        const account = await this.accounts.current();
        if (!account) return this.mirror.resolve(requested, null);
        const previouslyMerged = this.mirror.merged(account.slug);
        try {
            await this.mergeLocal(account);
        } catch (error) {
            if (error instanceof CloudProjectsUnsupportedError)
                return this.mirror.resolve(requested, null);
            if (!networkError(error)) throw error;
        }
        if (!previouslyMerged) {
            const mirrored = this.mirror.find(
                requested,
                projectSlug(requested),
                account.slug,
                true
            );
            if (mirrored) return mirrored;
        }
        try {
            this.mirror.refresh(account.slug, await this.cloud.list(account));
            this.mirror.markMerged(account.slug);
        } catch (error) {
            if (error instanceof CloudProjectsUnsupportedError)
                return this.mirror.resolve(requested, null);
            if (!networkError(error)) throw error;
        }
        return this.mirror.resolve(requested, account.slug);
    }

    private async mergeLocal(account: RegistryAccount): Promise<void> {
        if (this.mirror.merged(account.slug)) return;
        const local = this.mirror.local().toSorted((left, right) => left.id - right.id);
        if (local.length === 0) return;
        for (const project of local) {
            const result = await this.cloud.create(account, project.name);
            if (!result.conflict && !result.project)
                throw new Error(`Failed to merge project: ${project.name}`);
        }
        this.mirror.adopt(account.slug, local);
    }
}

function networkError(error: unknown): boolean {
    return (
        error instanceof TypeError ||
        (error instanceof Error && error.name === 'TimeoutError')
    );
}
