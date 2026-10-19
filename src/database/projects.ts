import type { Connection } from './connection.js';
import { type Row, RowReader } from './rows.js';

export interface ProjectRecord {
    id: number;
    name: string;
    slug: string;
    /** The organization that owns a mirrored cloud project; null for a local one. */
    organization: string | null;
    created_at: string;
}

/** The `projects` and `project_merges` rows. */
export class ProjectRecordStore {
    constructor(
        private readonly database: Pick<
            Connection,
            'run' | 'one' | 'all' | 'transaction'
        >
    ) {}

    transaction<T>(operation: () => T): T {
        return this.database.transaction(operation);
    }

    insert(
        name: string,
        slug: string,
        organization: string | null,
        createdAt: string
    ): void {
        this.database.run(
            'INSERT INTO projects (name, slug, organization, created_at) VALUES (?, ?, ?, ?)',
            name,
            slug,
            organization,
            createdAt
        );
    }

    rename(id: number, name: string, slug: string): void {
        this.database.run(
            'UPDATE projects SET name = ?, slug = ? WHERE id = ?',
            name,
            slug,
            id
        );
    }

    /** Moves a local project into an organization, keeping its id and sessions. */
    adopt(id: number, organization: string): void {
        this.database.run(
            'UPDATE projects SET organization = ? WHERE id = ? AND organization IS NULL',
            organization,
            id
        );
    }

    byId(id: number): ProjectRecord | undefined {
        const row = this.database.one(
            'SELECT id, name, slug, organization, created_at FROM projects WHERE id = ?',
            id
        );
        return row ? this.parse(row) : undefined;
    }

    /** The projects of one organization, or the local ones for null, newest first. */
    list(organization: string | null): ProjectRecord[] {
        return this.database
            .all(
                `SELECT id, name, slug, organization, created_at FROM projects
                 WHERE organization ${organization === null ? 'IS NULL' : '= ?'}
                 ORDER BY id DESC`,
                ...(organization === null ? [] : [organization])
            )
            .map((row) => this.parse(row));
    }

    /**
     * The project whose name or slug matches, case-insensitively. With
     * `includeLocal`, a local project also matches, after an organization one.
     */
    find(
        name: string,
        slug: string,
        organization: string | null,
        includeLocal: boolean
    ): ProjectRecord | undefined {
        const row = this.database.one(
            `SELECT id, name, slug, organization, created_at FROM projects
             WHERE (organization ${organization === null ? 'IS NULL' : '= ?'}${includeLocal ? ' OR organization IS NULL' : ''})
               AND (name = ? COLLATE NOCASE OR slug = ? COLLATE NOCASE)
             ORDER BY CASE WHEN organization IS NULL THEN 1 ELSE 0 END,
                      CASE WHEN name = ? COLLATE NOCASE THEN 0 ELSE 1 END
             LIMIT 1`,
            ...(organization === null
                ? [name, slug, name]
                : [organization, name, slug, name])
        );
        return row ? this.parse(row) : undefined;
    }

    markMerged(organization: string, mergedAt: string): void {
        this.database.run(
            'INSERT OR IGNORE INTO project_merges (organization, merged_at) VALUES (?, ?)',
            organization,
            mergedAt
        );
    }

    merged(organization: string): boolean {
        return (
            this.database.one(
                'SELECT organization FROM project_merges WHERE organization = ?',
                organization
            ) !== undefined
        );
    }

    private parse(row: Row): ProjectRecord {
        const reader = new RowReader(row, 'Workbench project record');
        return {
            id: reader.integer('id'),
            name: reader.text('name'),
            slug: reader.text('slug'),
            organization: reader.optionalText('organization') ?? null,
            created_at: reader.text('created_at'),
        };
    }
}
