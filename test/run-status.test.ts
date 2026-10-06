import { afterEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderStatusLine } from '../src/rendering/status-line.js';
import type { WorkbenchEvent, WorkbenchEventType } from '../src/runs/index.js';
import { RunStore } from '../src/runs/index.js';
import { type RunStatus, RunStatusReader } from '../src/runs/status.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('run status', () => {
    test('folds cost, plan, steps, activity, and open input from the event log', async () => {
        const { home, run, write } = await runningFixture();
        await write(
            ['usage.updated', { kind: 'delta', cost_usd: 0.25 }],
            ['plan.updated', plan(['Build', 'in_progress'], ['Test', 'pending'])],
            ['tool.started', { id: 't1', name: 'bash', title: 'npm run build' }],
            ['tool.completed', { id: 't1', name: 'bash' }],
            ['tool.started', { id: 't2', name: 'read', title: 'Read src' }],
            ['tool.completed', { id: 't2', name: 'read' }],
            ['plan.updated', plan(['Build', 'completed'], ['Test', 'in_progress'])],
            ['tool.started', { id: 't3', name: 'bash', title: 'tgcheck' }],
            ['usage.updated', { kind: 'delta', cost_usd: 0.5 }],
            [
                'input.requested',
                { id: 'r1', kind: 'permission', action: 'external_directory' },
            ]
        );

        const status = await new RunStatusReader(home).read(run);
        expect(status.status).toBe('running');
        expect(status.cost_usd).toBeCloseTo(0.75);
        expect(status.plan).toMatchObject({ completed: 1, total: 2 });
        expect(status.steps).toEqual({ item: 'Test', current: 1, completed: [2] });
        expect(status.activity).toMatchObject({ kind: 'tool', title: 'tgcheck' });
        expect(status.pending_input).toEqual({
            id: 'r1',
            kind: 'permission',
            action: 'external_directory',
        });

        await write(['input.accepted', { id: 'r1', kind: 'permission' }]);
        expect((await new RunStatusReader(home).read(run)).pending_input).toBeNull();
    });

    test('folds only appended complete lines, from a private cache', async () => {
        const { home, run, write, log } = await runningFixture();
        await write(['usage.updated', { kind: 'delta', cost_usd: 1 }]);
        const reader = new RunStatusReader(home);
        expect((await reader.read(run)).cost_usd).toBe(1);

        const cache = join(home, 'runs', run.id, 'status-cache.json');
        expect((await stat(cache)).mode & 0o777).toBe(0o600);
        const offset = JSON.parse(await readFile(cache, 'utf8')).offset;

        // A line still being written is left for the next read.
        const next = JSON.stringify(
            event(run.id, 99, 'usage.updated', { kind: 'delta', cost_usd: 2 })
        );
        await appendFile(log, next.slice(0, 20));
        expect((await reader.read(run)).cost_usd).toBe(1);
        expect(JSON.parse(await readFile(cache, 'utf8')).offset).toBe(offset);
        await appendFile(log, `${next.slice(20)}\n`);
        expect((await reader.read(run)).cost_usd).toBe(3);
    });

    test('marks an active run whose worker is gone as lost', async () => {
        const home = await temporaryHome();
        const store = new RunStore(home);
        const created = await fixtureRun(home);
        const run = await store.update(created.id, {
            status: 'running',
            pid: 2 ** 22 + 7,
        });
        expect((await new RunStatusReader(home).read(run)).status).toBe('lost');
    });

    test('a terminal event outranks a stale running record', async () => {
        const home = await temporaryHome();
        const store = new RunStore(home);
        const created = await fixtureRun(home);
        const run = await store.update(created.id, {
            status: 'running',
            pid: 2 ** 22 + 7,
        });
        await store.appendEvent(run.id, event(run.id, 1, 'run.failed', {}));
        expect((await new RunStatusReader(home).read(run)).status).toBe('failed');
    });

    test('typical step is the median over finished runs of the same workbench', async () => {
        const home = await temporaryHome();
        const store = new RunStore(home);
        const finished = async (workbench: string, counts: number[]) => {
            const run = await fixtureRun(home, workbench);
            let sequence = 0;
            const items = counts.map((_, index) => `item ${index}`);
            for (const [index, count] of counts.entries()) {
                const statuses = items.map((text, at) => [
                    text,
                    at < index ? 'completed' : at === index ? 'in_progress' : 'pending',
                ]);
                await store.appendEvent(
                    run.id,
                    event(run.id, ++sequence, 'plan.updated', plan(...statuses))
                );
                for (let call = 0; call < count; call++) {
                    await store.appendEvent(
                        run.id,
                        event(run.id, ++sequence, 'tool.started', {
                            id: `${index}-${call}`,
                        })
                    );
                }
            }
            await store.appendEvent(
                run.id,
                event(
                    run.id,
                    ++sequence,
                    'plan.updated',
                    plan(...items.map((text) => [text, 'completed']))
                )
            );
            await store.update(run.id, {
                status: 'completed',
                exit_code: 0,
                finished_at: '2026-10-05T00:00:00.000Z',
            });
        };
        await finished('game', [4, 10]);
        await finished('game', [20]);
        await finished('other', [100, 100, 100]);

        const reader = new RunStatusReader(home);
        expect(await reader.typicalStep('game')).toBe(10);
        expect(await reader.typicalStep('missing')).toBeUndefined();
    });
});

describe('status line', () => {
    const base: RunStatus = {
        run_id: 'wb_1',
        workbench: 'threejs-game',
        workbench_version: '0.2.3',
        status: 'running',
        dispatched_at: '2026-10-05T00:00:00.000Z',
        started_at: '2026-10-05T00:00:00.000Z',
        cost_usd: 3.5,
        last_activity_at: '2026-10-05T00:09:59.000Z',
        activity: { kind: 'thinking' },
        pending_input: null,
        plan: {
            items: [
                { text: 'Levels', status: 'completed' },
                { text: 'Skill tree', status: 'in_progress' },
            ],
            completed: 1,
            total: 2,
        },
        steps: { item: 'Skill tree', current: 20, completed: [] },
    };
    const now = Date.parse('2026-10-05T00:10:00.000Z');

    test('shows the plan bar, a long step, elapsed time, and cost', () => {
        expect(renderStatusLine(base, { now, typicalStep: 16, color: false })).toBe(
            '□ threejs-game ▰▱ 1/2 · Skill tree · 20 calls · 10m · $3.50'
        );
        expect(
            renderStatusLine(
                { ...base, steps: { ...base.steps, current: 8 } },
                { now, typicalStep: 16, color: false }
            )
        ).toBe('□ threejs-game ▰▱ 1/2 · Skill tree · 10m · $3.50');
    });

    test('puts open input first and names the answer command', () => {
        const line = renderStatusLine(
            {
                ...base,
                pending_input: { id: 'r1', kind: 'permission', action: 'bash' },
            },
            { now, typicalStep: 16, color: false }
        );
        expect(line).toBe('▲ threejs-game needs input · bash · wb answer wb_1');
    });

    test('strips terminal control sequences from agent-supplied text', () => {
        const line = renderStatusLine(
            {
                ...base,
                plan: {
                    completed: 0,
                    total: 1,
                    items: [
                        {
                            text: 'evil\u001b]8;;http://x\u001b\\link\nnext',
                            status: 'in_progress',
                        },
                    ],
                },
            },
            { now, typicalStep: 16, color: false }
        );
        expect(line).not.toContain('\u001b');
        expect(line).toContain('evil');
    });

    test('summarizes finished runs', () => {
        expect(
            renderStatusLine(
                {
                    ...base,
                    status: 'completed',
                    finished_at: '2026-10-05T00:08:00.000Z',
                },
                { now, typicalStep: 16, color: false }
            )
        ).toBe('✓ threejs-game done 2m ago · $3.50');
    });
});

async function runningFixture() {
    const home = await temporaryHome();
    const store = new RunStore(home);
    const created = await fixtureRun(home);
    const run = await store.update(created.id, { status: 'running', pid: process.pid });
    let sequence = 0;
    const write = async (
        ...events: Array<[WorkbenchEventType, Record<string, unknown>]>
    ) => {
        for (const [type, data] of events) {
            await store.appendEvent(run.id, event(run.id, ++sequence, type, data));
        }
    };
    return { home, run, write, log: join(home, 'runs', run.id, 'events.ndjson') };
}

function plan(...items: string[][]) {
    return {
        items: items.map(([text, status]) => ({ text, status })),
        completed: items.filter(([, status]) => status === 'completed').length,
        total: items.length,
    };
}

async function temporaryHome() {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-status-'));
    temporaryDirectories.push(directory);
    return directory;
}

function fixtureRun(home: string, workbench = 'fixture-core') {
    return new RunStore(home).create({
        metadata: {
            workbench,
            workbench_version: '0.1.0',
            runner: 'opencode',
            model: 'openrouter/openai/gpt-5.6-terra',
            workspace: '/workspace',
            mode: 'detached',
        },
        request: {
            workbench_path: '/repo/.workbenches/core',
            workspace: '/workspace',
            task: 'task',
        },
    });
}

function event(
    id: string,
    sequence: number,
    type: WorkbenchEventType,
    data: Record<string, unknown> = {}
): WorkbenchEvent {
    return {
        protocol: 0,
        run_id: id,
        sequence,
        timestamp: '2026-10-05T00:00:00.000Z',
        type,
        runner: 'opencode',
        data,
    };
}
