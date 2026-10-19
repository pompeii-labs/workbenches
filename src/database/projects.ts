import type { Connection } from './connection.js';
import { type Row, RowReader } from './rows.js';

export interface ProjectRecord {
    id: number;
    name: string;
    slug: string;
    created_at: string;
}

/** The `projects` rows. */
export class ProjectRecordStore {
    constructor(private readonly database: Pick<Connection, 'run' | 'one' | 'all'>) {}

    insert(name: string, slug: string, createdAt: string): void {
        this.database.run(
            'INSERT INTO projects (name, slug, created_at) VALUES (?, ?, ?)',
            name,
            slug,
            createdAt
        );
    }

    /** Every project, newest first. */
    list(): ProjectRecord[] {
        return this.database
            .all('SELECT id, name, slug, created_at FROM projects ORDER BY id DESC')
            .map((row) => this.parse(row));
    }

    /** The project whose name or slug matches, case-insensitively, preferring the name. */
    find(name: string, slug: string): ProjectRecord | undefined {
        const row = this.database.one(
            `SELECT id, name, slug, created_at FROM projects
             WHERE name = ? COLLATE NOCASE OR slug = ? COLLATE NOCASE
             ORDER BY CASE WHEN name = ? COLLATE NOCASE THEN 0 ELSE 1 END
             LIMIT 1`,
            name,
            slug,
            name
        );
        return row ? this.parse(row) : undefined;
    }

    private parse(row: Row): ProjectRecord {
        const reader = new RowReader(row, 'Workbench project record');
        return {
            id: reader.integer('id'),
            name: reader.text('name'),
            slug: reader.text('slug'),
            created_at: reader.text('created_at'),
        };
    }
}
