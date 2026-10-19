import type { ProjectRecord, ProjectRecordStore } from '../database/projects.js';
import type { CloudProject } from './cloud.js';
import { projectSlug } from './name.js';

/**
 * The wb.db copy of projects: local projects, and the cloud projects of each
 * organization as last seen. When logged in, it is the offline fallback while
 * the cloud is unreachable.
 */
export class ProjectMirror {
    constructor(private readonly records: ProjectRecordStore) {}

    /** Local projects, newest first. */
    local(): ProjectRecord[] {
        return this.records.list(null);
    }

    /** An organization's mirrored projects, or the local ones when it has none yet. */
    organization(organization: string): ProjectRecord[] {
        const scoped = this.records.list(organization);
        return scoped.length ? scoped : this.local();
    }

    find(
        name: string,
        slug: string,
        organization: string | null,
        includeLocal = false
    ): ProjectRecord | undefined {
        return this.records.find(name, slug, organization, includeLocal);
    }

    createLocal(name: string): ProjectRecord {
        const slug = projectSlug(name);
        const existing = this.find(name, slug, null);
        if (existing) throw new Error(`Project already exists: ${existing.name}`);
        try {
            this.records.insert(name, slug, null, new Date().toISOString());
        } catch (error) {
            const raced = this.find(name, slug, null);
            if (raced) throw new Error(`Project already exists: ${raced.name}`);
            throw error;
        }
        const created = this.find(name, slug, null);
        if (!created) throw new Error(`Failed to create project: ${name}`);
        return created;
    }

    /** Records one cloud project of an organization. */
    mirror(organization: string, project: CloudProject): ProjectRecord {
        const existing = this.find(project.name, project.slug, organization);
        if (existing) {
            this.records.rename(existing.id, project.name, project.slug);
            const renamed = this.records.byId(existing.id);
            if (!renamed) throw new Error('Mirrored project does not exist');
            return renamed;
        }
        this.records.insert(
            project.name,
            project.slug,
            organization,
            project.updated_at
        );
        const created = this.find(project.name, project.slug, organization);
        if (!created) throw new Error(`Failed to mirror project: ${project.name}`);
        return created;
    }

    /** Records an organization's full cloud project list. */
    refresh(organization: string, projects: CloudProject[]): ProjectRecord[] {
        return this.records.transaction(() => {
            for (const project of projects) this.mirror(organization, project);
            return projects.map((project) => {
                const mirrored = this.find(project.name, project.slug, organization);
                if (!mirrored)
                    throw new Error(`Failed to mirror project: ${project.name}`);
                return mirrored;
            });
        });
    }

    /** Moves local projects into an organization once and records the merge. */
    adopt(organization: string, projects: ProjectRecord[]): void {
        this.records.transaction(() => {
            for (const project of projects)
                this.records.adopt(project.id, organization);
            this.markMerged(organization);
        });
    }

    markMerged(organization: string): void {
        this.records.markMerged(organization, new Date().toISOString());
    }

    merged(organization: string): boolean {
        return this.records.merged(organization);
    }

    /** Resolves a name or slug among mirrored projects, suggesting a close one. */
    resolve(requested: string, organization: string | null): ProjectRecord {
        const exact = this.find(
            requested,
            requested,
            organization,
            organization !== null
        );
        if (exact) return exact;
        const requestedSlug = projectSlug(requested);
        const closest = (organization ? this.organization(organization) : this.local())
            .map((project) => ({
                project,
                distance: editDistance(requestedSlug, project.slug),
            }))
            .toSorted((left, right) => left.distance - right.distance)[0];
        const suggestion =
            closest && closest.distance <= reasonableDistance(requestedSlug)
                ? ` Did you mean "${closest.project.name}"?`
                : '';
        throw new Error(
            `No project "${requested}".${suggestion}\nCreate it with: wb project create ${quote(requested)}`
        );
    }
}

function reasonableDistance(slug: string): number {
    return Math.max(2, Math.floor(slug.length / 3));
}

function editDistance(left: string, right: string): number {
    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
        const current = [leftIndex];
        for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
            current[rightIndex] = Math.min(
                (current[rightIndex - 1] ?? 0) + 1,
                (previous[rightIndex] ?? 0) + 1,
                (previous[rightIndex - 1] ?? 0) +
                    (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
            );
        }
        previous = current;
    }
    return previous[right.length] ?? left.length;
}

function quote(value: string): string {
    return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}
