import { DuplicateEventSequenceError } from '../../runs/error.js';
import { WORKBENCH_EVENT_PROTOCOL, type WorkbenchEvent } from '../../runs/events.js';
import type { Connection } from '../connection.js';
import { DatabaseConstraintError } from '../error.js';
import { RowReader } from '../rows.js';

/** Largest serialized event the log stores. */
const MAXIMUM_EVENT_BYTES = 4 * 1024 * 1024;

interface LoggedEvent {
    cursor: number;
    event: WorkbenchEvent;
}

/**
 * The ordered event stream of every run. Rows are ordered globally by their
 * integer key; the per-run `sequence` that consumers see is unique within a run.
 *
 * An event whose serialized form exceeds the 4 MiB limit is not
 * rejected, because the run must keep its sequence and terminal events. Its
 * `data` is replaced by `{ truncated: true, original_bytes, limit_bytes }` and
 * the envelope is stored unchanged.
 */
export class RunEventStore {
    constructor(private readonly database: Pick<Connection, 'run' | 'one' | 'all'>) {}

    append(runId: string, event: WorkbenchEvent): void {
        const stored = this.capped(event);
        try {
            this.database.run(
                'INSERT INTO events (run_id, sequence, type, timestamp, payload) VALUES (?, ?, ?, ?, ?)',
                runId,
                stored.sequence,
                stored.type,
                stored.timestamp,
                JSON.stringify(stored)
            );
        } catch (error) {
            if (error instanceof DatabaseConstraintError && error.code === 'unique')
                throw new DuplicateEventSequenceError(runId, stored.sequence, {
                    cause: error,
                });
            throw error;
        }
    }

    read(runId: string): WorkbenchEvent[] {
        return this.after(runId, 0).map((logged) => logged.event);
    }

    /** Events appended after `cursor`, in order. */
    after(runId: string, cursor: number): LoggedEvent[] {
        return this.database
            .all(
                'SELECT id, payload FROM events WHERE run_id = ? AND id > ? ORDER BY id',
                runId,
                cursor
            )
            .map((row) => {
                if (typeof row.id !== 'number' || typeof row.payload !== 'string')
                    throw this.invalid(runId);
                return { cursor: row.id, event: this.parse(row.payload, runId) };
            });
    }

    /** Events whose sequence is after `sequence`, in sequence order. */
    afterSequence(runId: string, sequence: number): WorkbenchEvent[] {
        return this.database
            .all(
                'SELECT payload FROM events WHERE run_id = ? AND sequence > ? ORDER BY sequence',
                runId,
                sequence
            )
            .map((row) => {
                if (typeof row.payload !== 'string') throw this.invalid(runId);
                return this.parse(row.payload, runId);
            });
    }

    last(runId: string): WorkbenchEvent | undefined {
        const row = this.database.one(
            'SELECT payload FROM events WHERE run_id = ? ORDER BY id DESC LIMIT 1',
            runId
        );
        return row && typeof row.payload === 'string'
            ? this.parse(row.payload, runId)
            : undefined;
    }

    bytes(runId: string): number {
        const row = this.database.one(
            'SELECT COALESCE(SUM(length(CAST(payload AS BLOB))), 0) AS bytes FROM events WHERE run_id = ?',
            runId
        );
        return typeof row?.bytes === 'number' ? row.bytes : 0;
    }

    private capped(event: WorkbenchEvent): WorkbenchEvent {
        const bytes = Buffer.byteLength(JSON.stringify(event));
        if (bytes <= MAXIMUM_EVENT_BYTES) return event;
        const stored: WorkbenchEvent = {
            ...event,
            data: {
                truncated: true,
                original_bytes: bytes,
                limit_bytes: MAXIMUM_EVENT_BYTES,
            },
        };
        if (Buffer.byteLength(JSON.stringify(stored)) > MAXIMUM_EVENT_BYTES)
            throw new Error('Workbench event envelope exceeds the event size limit');
        return stored;
    }

    private parse(source: string, runId: string): WorkbenchEvent {
        let event: unknown;
        try {
            event = JSON.parse(source);
        } catch {
            throw this.invalid(runId);
        }
        if (!this.isEvent(event, runId)) throw this.invalid(runId);
        return event;
    }

    private isEvent(value: unknown, runId: string): value is WorkbenchEvent {
        return (
            RowReader.isRecord(value) &&
            value.protocol === WORKBENCH_EVENT_PROTOCOL &&
            value.run_id === runId &&
            typeof value.type === 'string' &&
            typeof value.sequence === 'number' &&
            typeof value.timestamp === 'string' &&
            typeof value.runner === 'string'
        );
    }

    private invalid(runId: string): Error {
        return new Error(`Invalid event stream for Workbench run: ${runId}`);
    }
}
