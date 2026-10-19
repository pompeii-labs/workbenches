import type { ProjectRecord, ProjectRecordStore } from '../database/projects.js';
import { normalizeProjectName, projectSlug } from './name.js';

/** The local projects of one Workbench home. */
export class ProjectStore {
    constructor(private readonly records: ProjectRecordStore) {}

    create(value: string): ProjectRecord {
        const name = normalizeProjectName(value);
        const slug = projectSlug(name);
        const existing = this.records.find(name, slug);
        if (existing) throw new Error(`Project already exists: ${existing.name}`);
        try {
            this.records.insert(name, slug, new Date().toISOString());
        } catch (error) {
            const raced = this.records.find(name, slug);
            if (raced) throw new Error(`Project already exists: ${raced.name}`);
            throw error;
        }
        const created = this.records.find(name, slug);
        if (!created) throw new Error(`Failed to create project: ${name}`);
        return created;
    }

    /** Every project, newest first. */
    list(): ProjectRecord[] {
        return this.records.list();
    }

    /** Resolves a name or slug, suggesting a close project when none matches. */
    resolve(value: string): ProjectRecord {
        const requested = normalizeProjectName(value);
        const exact = this.records.find(requested, requested);
        if (exact) return exact;
        const requestedSlug = projectSlug(requested);
        const closest = this.records
            .list()
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
