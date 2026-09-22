import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { campaignSnapshot, renderMonitor } from './monitor.ts';
import { trialName } from './spec.ts';

const MODEL = 'vendor/m';
const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'wb-monitor-'));
    roots.push(root);
    writeFileSync(
        join(root, 'campaign.json'),
        JSON.stringify({
            version: 1,
            tasks: [{ id: 'task' }],
            arms: ['plain', 'workbench'],
            models: [MODEL],
            reps: 1,
        })
    );
    const trial = join(root, 'trials', trialName('task', MODEL, 'plain', 1));
    return { root, trial };
}
test('queued and preparing states retain unknown usage', () => {
    const { root, trial } = fixture();
    expect(campaignSnapshot(root).rows[0]?.phase).toBe('queued');
    mkdirSync(trial, { recursive: true });
    const s = campaignSnapshot(root);
    expect(s.rows[0]?.phase).toBe('preparing actor');
    expect(s.rows[0]?.actor.cost_usd).toBeNull();
    expect(s.complete).toBe(false);
});
test('normalized plain events, partial writes, and input waits are read safely', () => {
    const { root, trial } = fixture();
    mkdirSync(trial, { recursive: true });
    const path = join(trial, 'events.ndjson');
    const events =
        [
            {
                protocol: 0,
                type: 'usage.updated',
                data: { kind: 'delta', total_tokens: 123, cost_usd: 0.25 },
            },
            {
                type: 'input.requested',
                data: { message: 'private-secret', resources: ['private-secret'] },
            },
        ]
            .map((e) => JSON.stringify(e))
            .join('\n') + '\n{"unfinished":';
    writeFileSync(path, events);
    const s = campaignSnapshot(root);
    expect(s.rows[0]?.actor).toEqual({ tokens: 123, cost_usd: 0.25 });
    expect(s.rows[0]?.activity).toBe('input requested');
    expect(renderMonitor(s)).not.toContain('private-secret');
    expect(JSON.stringify(s)).not.toContain('private-secret');
    expect(readFileSync(path, 'utf8')).toBe(events);
    writeFileSync(
        path,
        events.slice(0, events.lastIndexOf('\n')) +
            '\n' +
            JSON.stringify({ type: 'tool.started', data: { name: 'bash' } })
    );
    expect(campaignSnapshot(root).rows[0]?.activity).toBe('tool: bash');
});
test('grading usage is separate and final results override streams', () => {
    const { root, trial } = fixture();
    mkdirSync(join(trial, 'grading'), { recursive: true });
    writeFileSync(
        join(trial, 'grading/events.ndjson'),
        JSON.stringify({
            protocol: 0,
            type: 'usage.updated',
            data: { kind: 'delta', total_tokens: 50, cost_usd: 0.1 },
        })
    );
    expect(campaignSnapshot(root).rows[0]?.phase).toBe('grading');
    expect(campaignSnapshot(root).rows[0]?.grader.cost_usd).toBe(0.1);
    for (const arm of ['plain', 'workbench'] as const) {
        const dir = join(root, 'trials', trialName('task', MODEL, arm, 1));
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, 'result.json'),
            JSON.stringify({
                version: 1,
                status: arm === 'plain' ? 'passed' : 'failed',
                metrics: { tokens: { total: 100 }, cost_usd: 0.2 },
                grading_metrics: { tokens: { total: 60 }, cost_usd: 0.12 },
            })
        );
    }
    const s = campaignSnapshot(root);
    expect(s.complete).toBe(true);
    expect(s.rows[0]?.grader.cost_usd).toBe(0.12);
    expect(s.rows[1]?.phase).toBe('failed');
});
test('malformed final results are not falsely complete and task traversal is rejected', () => {
    const { root, trial } = fixture();
    mkdirSync(trial, { recursive: true });
    writeFileSync(join(trial, 'result.json'), '{');
    expect(campaignSnapshot(root).rows[0]?.phase).toBe('result unreadable');
    expect(campaignSnapshot(root).complete).toBe(false);
    writeFileSync(
        join(root, 'campaign.json'),
        JSON.stringify({
            version: 1,
            tasks: [{ id: '../outside' }],
            arms: ['plain'],
            models: [MODEL],
            reps: 1,
        })
    );
    expect(() => campaignSnapshot(root)).toThrow();
});
test('finished dashboard separates passing dimensions from failures without leaking evidence', () => {
    const { root, trial } = fixture();
    mkdirSync(trial, { recursive: true });
    writeFileSync(
        join(trial, 'result.json'),
        JSON.stringify({
            version: 1,
            status: 'failed',
            verdicts: [
                { id: 'functionality', status: 'pass', evidence: 'private-secret' },
                { id: 'styling', status: 'fail', evidence: 'private-secret' },
            ],
        })
    );
    const rendered = renderMonitor(campaignSnapshot(root), { color: false });
    expect(rendered).toContain('PASS       functionality');
    expect(rendered).toContain('FAIL       styling');
    expect(rendered).not.toContain('private-secret');
});
test('dashboard fits narrow terminals and makes input waits prominent', () => {
    const { root, trial } = fixture();
    mkdirSync(trial, { recursive: true });
    writeFileSync(
        join(trial, 'events.ndjson'),
        JSON.stringify({
            protocol: 0,
            type: 'input.requested',
            data: { message: 'private-secret' },
        })
    );
    const snapshot = campaignSnapshot(root, Date.now() + 1596000);
    for (const columns of [40, 80, 120]) {
        const rendered = renderMonitor(snapshot, { columns, color: false });
        expect(rendered).toContain('WAITING FOR INPUT');
        expect(rendered).toContain('26m');
        expect(rendered).toContain('WORKBENCH');
        expect(rendered).not.toContain('private-secret');
        expect(rendered).not.toContain('\x1b');
        expect(rendered.split('\n').every((l) => l.length <= columns - 2)).toBe(true);
    }
    expect(renderMonitor(snapshot, { color: true })).toContain('\x1b[33m');
});
