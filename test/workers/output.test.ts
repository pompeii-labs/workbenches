import { describe, expect, test } from 'bun:test';

import {
    workerStartedLine,
    workerStatusLines,
    workerWaitingLine,
} from '../../src/rendering/worker.js';
import { clock } from '../../src/workers/log.js';

describe('worker output', () => {
    test('stop says what it waits on', () => {
        expect(workerWaitingLine('mac', 1, 'drain')).toBe(
            'Worker mac has 1 run going. Waiting for it to finish, or pass --now to stop it.'
        );
        expect(workerWaitingLine('mac', 2, 'drain')).toBe(
            'Worker mac has 2 runs going. Waiting for them to finish, or pass --now to stop them.'
        );
        expect(workerWaitingLine('mac', 2, 'now')).toBe(
            'Worker mac is cancelling 2 runs.'
        );
    });

    test('start says where the worker is online and how to follow it', () => {
        const worker = { name: 'mac', organization: 'acme' };
        expect(
            workerStartedLine(worker, { slots: 1, runtimes: ['docker'] }, true)
        ).toBe(
            'Worker mac is online for acme. 1 slot, runtimes docker. Follow it with: wb worker logs -f'
        );
        expect(
            workerStartedLine(
                worker,
                { slots: 2, runtimes: ['docker', 'local'] },
                false
            )
        ).toBe(
            'Worker mac started for acme and is still connecting. 2 slots, runtimes docker, local. Follow it with: wb worker logs -f'
        );
    });

    test('status prints a header and one line per run', () => {
        const now = new Date(2026, 9, 22, 14, 10, 0);
        const since = new Date(2026, 9, 22, 14, 2, 11);
        expect(
            workerStatusLines(
                {
                    registered: true,
                    name: 'mac',
                    organization: 'acme',
                    online: true,
                    running: true,
                    since: since.toISOString(),
                    slots: 2,
                    runtimes: ['docker'],
                    runs: [
                        {
                            run_id: 'wb_d8m99qyw2e4qqhitfff63f1n',
                            session_id: 'wb_mvk2local',
                            workbench: 'threejs-game',
                            runtime: 'docker',
                            state: 'running',
                            started_at: new Date(2026, 9, 22, 14, 5, 40).toISOString(),
                        },
                        {
                            run_id: 'wb_other',
                            session_id: 'wb_mvk3local',
                            workbench: 'docs\u001b[31m',
                            runtime: 'docker',
                            state: 'needs_input',
                            started_at: new Date(2026, 9, 22, 14, 9, 0).toISOString(),
                        },
                    ],
                    stopping: 'drain',
                },
                now
            )
        ).toEqual([
            `Worker mac is online for acme since ${clock(since)} (7m 49s). 2 of 2 slots busy, runtimes docker. Stopping after its runs finish.`,
            '  threejs-game  wb_d8m99qyw2e4qqhitfff63f1n  docker  4m 20s',
            '  docs  wb_other  docker  1m 0s  needs input',
        ]);
    });

    test('status says when the worker is offline or not registered', () => {
        const now = new Date(2026, 9, 22, 14, 10, 0);
        expect(
            workerStatusLines(
                {
                    registered: true,
                    name: 'mac',
                    organization: 'acme',
                    online: false,
                    running: false,
                    since: new Date(2026, 9, 20, 9, 0, 0).toISOString(),
                    slots: 1,
                    runtimes: ['docker'],
                    runs: [],
                    stopping: null,
                    stopped: 'stopped: the worker key was revoked',
                },
                now
            )
        ).toEqual([
            'Worker mac is offline for acme since 2026-10-20 09:00:00 (53h 10m).',
            'Stopped: the worker key was revoked',
        ]);
        expect(
            workerStatusLines(
                {
                    registered: false,
                    online: false,
                    running: false,
                    runs: [],
                    stopping: null,
                },
                now
            )
        ).toEqual([
            'This machine is not registered as a worker. Register and start it with: wb worker start --name <name>',
        ]);
    });
});
