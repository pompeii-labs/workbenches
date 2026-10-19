import type { Connection } from '../connection.js';
import { RowReader } from '../rows.js';

export interface StudioStateRecord {
    server_pid: number;
    api_port: number;
    ui_port: number;
    container_id: string;
    token: string;
    image: string;
    created_at: string;
}

/** The single `studio` row of the running local Studio. */
export class StudioStateStore {
    constructor(private readonly database: Pick<Connection, 'run' | 'one'>) {}

    read(): StudioStateRecord | undefined {
        const row = this.database.one('SELECT * FROM studio WHERE id = 1');
        if (!row) return undefined;
        const reader = new RowReader(row, 'Studio state');
        return {
            server_pid: reader.integer('server_pid'),
            api_port: reader.integer('api_port'),
            ui_port: reader.integer('ui_port'),
            container_id: reader.text('container_id'),
            token: reader.text('token'),
            image: reader.text('image'),
            created_at: reader.text('created_at'),
        };
    }

    write(record: StudioStateRecord): void {
        this.database.run(
            `INSERT INTO studio (
                id, server_pid, api_port, ui_port, container_id, token, image, created_at
             ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET server_pid = excluded.server_pid,
                api_port = excluded.api_port, ui_port = excluded.ui_port,
                container_id = excluded.container_id, token = excluded.token,
                image = excluded.image, created_at = excluded.created_at`,
            record.server_pid,
            record.api_port,
            record.ui_port,
            record.container_id,
            record.token,
            record.image,
            record.created_at
        );
    }

    clear(): void {
        this.database.run('DELETE FROM studio WHERE id = 1');
    }
}
