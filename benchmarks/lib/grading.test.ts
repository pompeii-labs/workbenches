import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessmentTable } from './report.ts';
import type { Paths } from './runtime.ts';
import { loadTask } from './spec.ts';
import { gateStatus, prepareFixture, type TrialResult, tally } from './trial.ts';

test('browser infrastructure blockers are not submission failures', () => {
    const blocker = JSON.stringify({
        version: 1,
        probes: [{ id: 'infrastructure', status: 'not-tested' }],
    });
    expect(gateStatus(2, blocker)).toBe('not-tested');
    expect(gateStatus(2, 'unstructured error')).toBe('fail');
    expect(gateStatus(1, blocker)).toBe('fail');
    expect(gateStatus(0, '')).toBe('pass');
    expect(
        gateStatus(
            2,
            JSON.stringify({
                version: 1,
                probes: [
                    { id: 'infrastructure', status: 'not-tested' },
                    { id: 'contrast', status: 'fail' },
                ],
            })
        )
    ).toBe('fail');
});

test('required gate failures remain failures while passing dimensions remain visible', () => {
    const verdicts = [
        {
            id: 'functionality',
            kind: 'gate',
            title: 'Functionality',
            status: 'pass',
            pass: true,
        },
        {
            id: 'health-endpoint',
            kind: 'gate',
            title: 'Health endpoint',
            status: 'fail',
            pass: false,
        },
        { id: 'style', kind: 'criterion', title: 'Style', status: 'pass', pass: true },
    ] as TrialResult['verdicts'];
    expect(tally(verdicts).status).toBe('failed');
    const table = assessmentTable([
        { task: 'example', arm: 'plain', rep: 1, verdicts } as TrialResult,
    ]);
    expect(table).toContain('| functionality | pass |');
    expect(table).toContain('| health-endpoint | fail |');
    expect(table).toContain('| style | pass |');
});

test('example-hello has a deterministic gate and no judged criteria', () => {
    const task = loadTask(join(import.meta.dir, '..', 'tasks'), 'example-hello');
    expect(task.fixture).toEqual({ kind: 'dir', path: 'fixture' });
    expect(task.criteria ?? []).toEqual([]);
    expect(task.gates?.map((g) => g.id)).toEqual(['health-endpoint']);
});

test('actor staging contains only the fixture and baseline Git metadata', async () => {
    const tasks = join(import.meta.dir, '..', 'tasks');
    const task = loadTask(tasks, 'example-hello');
    const scratch = mkdtempSync(join(tmpdir(), 'wb-fixture-'));
    const project = join(scratch, 'project');
    try {
        await prepareFixture({ tasks } as Paths, task, project, scratch);
        expect(readdirSync(project).sort()).toEqual([
            '.git',
            'package.json',
            'server.js',
        ]);
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
});
