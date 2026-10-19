import type { Connection } from '../connection.js';
import { type Row, RowReader } from '../rows.js';

/** A cloud session this machine started or saw, with its project's name. */
export interface TrackedCloudSession {
    sessionId: string;
    latestRunId: string;
    organization: string;
    projectId: number;
    project: string;
    workbench: string;
    title: string;
    createdAt: string;
}

export type TrackCloudSession = Omit<TrackedCloudSession, 'project'>;

/** The `cloud_sessions` rows. */
export class CloudSessionStore {
    constructor(private readonly database: Pick<Connection, 'run' | 'one' | 'all'>) {}

    track(record: TrackCloudSession): void {
        this.database.run(
            `INSERT INTO cloud_sessions (
                session_id, latest_run_id, organization, project_id,
                workbench, title, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (session_id) DO UPDATE SET
                latest_run_id = excluded.latest_run_id,
                organization = excluded.organization,
                project_id = excluded.project_id,
                workbench = excluded.workbench,
                title = excluded.title`,
            record.sessionId,
            record.latestRunId,
            record.organization,
            record.projectId,
            record.workbench,
            record.title,
            record.createdAt
        );
    }

    bySession(id: string): TrackedCloudSession | undefined {
        const row = this.database.one(
            `${selectTracked} WHERE cloud_sessions.session_id = ?`,
            id
        );
        return row ? this.parse(row) : undefined;
    }

    byRun(id: string): TrackedCloudSession | undefined {
        const row = this.database.one(
            `${selectTracked} WHERE cloud_sessions.latest_run_id = ?`,
            id
        );
        return row ? this.parse(row) : undefined;
    }

    list(): TrackedCloudSession[] {
        return this.database
            .all(`${selectTracked} ORDER BY cloud_sessions.created_at DESC`)
            .map((row) => this.parse(row));
    }

    private parse(row: Row): TrackedCloudSession {
        const reader = new RowReader(row, 'Tracked cloud session');
        return {
            sessionId: reader.text('session_id'),
            latestRunId: reader.text('latest_run_id'),
            organization: reader.text('organization'),
            projectId: reader.integer('project_id'),
            project: reader.text('project'),
            workbench: reader.text('workbench'),
            title: reader.text('title'),
            createdAt: reader.text('created_at'),
        };
    }
}

const selectTracked = `SELECT cloud_sessions.session_id, cloud_sessions.latest_run_id,
    cloud_sessions.organization, cloud_sessions.project_id, projects.name AS project,
    cloud_sessions.workbench, cloud_sessions.title, cloud_sessions.created_at
FROM cloud_sessions JOIN projects ON projects.id = cloud_sessions.project_id`;
