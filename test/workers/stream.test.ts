import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WorkbenchEvent } from '../../src/runs/events.js';
import {
    type WorkerAssignment,
    WorkerAssignments,
} from '../../src/workers/assignments.js';
import { WorkerHome } from '../../src/workers/home.js';
import { parseServerMessage, type WorkerMessage } from '../../src/workers/protocol.js';
import { WorkerEventStream } from '../../src/workers/stream.js';
import { runStart } from './fixture.js';

function event(sequence: number, type: string): WorkbenchEvent {
    return {
        protocol: 0,
        run_id: 'wb_session',
        sequence,
        timestamp: new Date(0).toISOString(),
        type,
        runner: 'opencode',
        data: {},
    } as WorkbenchEvent;
}

function stream() {
    const assignments = new WorkerAssignments(
        new WorkerHome(join(tmpdir(), 'wb-worker-stream-unused'))
    );
    const start = parseServerMessage(JSON.stringify(runStart()));
    if (start?.type !== 'run.start') throw new Error('not a run start');
    const assignment: WorkerAssignment = {
        run_id: 'run_1',
        session_id: 'wb_session',
        workbench: 'threejs-game',
        runner: 'opencode',
        runtime: 'docker',
        member_id: null,
        connection: null,
        started_by: null,
        task: 'Build it',
        accepted_at: new Date(0).toISOString(),
        max_minutes: null,
        state: 'running',
        observed: 3,
        uploaded: [],
    };
    assignments.add(assignment, start);
    const log = [
        event(1, 'run.started'),
        event(2, 'outcome.available'),
        event(3, 'run.completed'),
    ];
    const sent: WorkerMessage[] = [];
    const events = new WorkerEventStream(
        assignments,
        {
            events: async (_session, after) =>
                log.filter((entry) => entry.sequence > after),
        },
        (message) => {
            sent.push(message);
            return true;
        }
    );
    const types = () =>
        sent.flatMap((message) =>
            message.type === 'events' ? message.events.map((entry) => entry.type) : []
        );
    return { assignment, events, types };
}

describe('WorkerEventStream', () => {
    test("holds a run's end until the worker has finished the run, so its outcome goes first", async () => {
        const { assignment, events, types } = stream();

        await events.flush();
        expect(types()).toEqual(['run.started', 'outcome.available']);

        assignment.state = 'completed';
        await events.flush();
        expect(types()).toEqual(['run.started', 'outcome.available', 'run.completed']);
    });
});
