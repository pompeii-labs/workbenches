import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkbenchEvent } from '../../src/runs/events.js';
import { RunStore } from '../../src/runs/store.js';
import { SessionTranscript } from '../../src/tui/session-transcript.js';

const homes: string[] = [];
const sessionId = 'wb_historysession123456789012';
afterEach(async () => {
    await Promise.all(
        homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))
    );
});

describe('canonical session transcript restoration', () => {
    for (const runtime of ['local', 'docker', 'e2b']) {
        for (const runner of ['opencode', 'pi']) {
            test(`restores ${runner}/${runtime} history after an older client replaced its cache`, async () => {
                const home = await temporaryHome();
                const runs = new RunStore(home);
                const first = await createRun(runs, runtime, runner, 1, 'completed');
                await append(runs, first, runner, [
                    ['run.ready', {}],
                    [
                        'input.delivered',
                        { id: 'first', kind: 'send', text: 'Make a report' },
                    ],
                    ['output.text', { id: 'reply', text: 'Report ' }],
                    ['output.text', { id: 'reply', text: 'created' }],
                    [
                        'outcome.available',
                        {
                            outcome_id: 'wbo_report',
                            application_state: 'present',
                            completeness: 'complete',
                            artifacts: 1,
                        },
                    ],
                    ['run.completed', {}],
                ]);
                const failed = await createRun(runs, runtime, runner, 2, 'failed');
                await append(runs, failed, runner, [
                    ['run.started', {}],
                    [
                        'run.failed',
                        { message: 'OpenCode request failed with HTTP 404' },
                    ],
                ]);
                const latest = await createRun(runs, runtime, runner, 3, 'running');
                await append(runs, latest, runner, [
                    ['run.ready', {}],
                    [
                        'input.delivered',
                        { id: 'second', kind: 'send', text: 'Revise the report' },
                    ],
                    ['output.text', { id: 'reply', text: 'Revised report created' }],
                    ['turn.completed', {}],
                ]);
                const transcript = new SessionTranscript(home, sessionId);
                transcript.schedule(
                    [
                        {
                            id: 'error-2',
                            kind: 'notice',
                            tone: 'error',
                            text: 'OpenCode request failed with HTTP 404',
                        },
                    ],
                    { runId: failed, sequence: 2 }
                );
                await transcript.flush();
                const cached = await readFile(
                    join(home, 'sessions', sessionId, 'transcript.json'),
                    'utf8'
                );
                const restored = await transcript.restore();
                expect(
                    restored.items
                        .filter((item) => item.kind === 'user')
                        .map((item) => item.text)
                ).toEqual(['Make a report', 'Revise the report']);
                expect(
                    restored.items
                        .filter((item) => item.kind === 'assistant')
                        .map((item) => item.text)
                ).toEqual(['Report created', 'Revised report created']);
                expect(
                    restored.items.filter((item) => item.kind === 'outcome')
                ).toHaveLength(1);
                expect(
                    restored.items.some(
                        (item) => item.kind === 'notice' && item.text.includes('404')
                    )
                ).toBeFalse();
                expect(new Set(restored.items.map((item) => item.id)).size).toBe(
                    restored.items.length
                );
                expect(restored.cursor).toEqual({ runId: latest, sequence: 4 });
                expect(restored.ready).toBeTrue();
                expect(
                    await readFile(
                        join(home, 'sessions', sessionId, 'transcript.json'),
                        'utf8'
                    )
                ).toBe(cached);
                expect((await runs.readEvents(failed)).at(-1)?.type).toBe('run.failed');
            });
        }
    }

    for (const cache of [
        null,
        '{broken',
        JSON.stringify({ version: 99, items: [{ kind: 'future' }] }),
    ]) {
        test(`rebuilds without a usable cache (${cache ?? 'missing'})`, async () => {
            const home = await temporaryHome();
            const runs = new RunStore(home);
            const id = await createRun(runs, 'e2b', 'opencode', 1, 'completed');
            await append(runs, id, 'opencode', [
                ['input.delivered', { id: 'input', kind: 'send', text: 'Hello' }],
                ['output.text', { text: 'Hi' }],
            ]);
            const transcript = new SessionTranscript(home, sessionId);
            transcript.schedule([]);
            await transcript.flush();
            const path = join(home, 'sessions', sessionId, 'transcript.json');
            if (cache === null) await rm(path);
            else await writeFile(path, cache);
            expect((await transcript.restore()).items.map((item) => item.kind)).toEqual(
                ['user', 'assistant']
            );
        });
    }

    test('isolates sessions, deduplicates delivered input, and restores steering, images, and completed tools', async () => {
        const home = await temporaryHome();
        const runs = new RunStore(home);
        const unrelated = await createRun(
            runs,
            'local',
            'pi',
            1,
            'completed',
            'wb_othersession123456789012'
        );
        await append(runs, unrelated, 'pi', [
            ['output.text', { text: 'Unrelated conversation' }],
        ]);
        const id = await createRun(runs, 'local', 'pi', 2, 'completed');
        await append(runs, id, 'pi', [
            ['input.queued', { id: 'queued', kind: 'steer', text: 'Not delivered' }],
            [
                'input.delivered',
                {
                    id: 'send',
                    kind: 'send',
                    text: 'Inspect this',
                    images: [{ name: 'screenshot.png' }],
                },
            ],
            ['input.delivered', { id: 'send', kind: 'send', text: 'Inspect this' }],
            ['tool.started', { id: 'tool', name: 'read', title: 'Read file' }],
            ['tool.completed', { id: 'tool', status: 'completed' }],
            [
                'input.delivered',
                { id: 'steer', kind: 'steer', text: 'Focus on errors' },
            ],
            ['output.text', { text: 'Done' }],
            ['run.completed', {}],
        ]);
        const restored = await new SessionTranscript(home, sessionId).restore();
        expect(
            restored.items
                .filter((item) => item.kind === 'user')
                .map((item) => item.text)
        ).toEqual(['Inspect this', 'Focus on errors']);
        expect(restored.items.find((item) => item.kind === 'user')).toMatchObject({
            images: ['screenshot.png'],
        });
        expect(restored.items.find((item) => item.kind === 'tool')).toMatchObject({
            status: 'completed',
        });
        expect(JSON.stringify(restored.items)).not.toContain('Unrelated');
        expect(restored.ready).toBeFalse();
    });

    test('keeps actual work failures explicitly historical instead of hiding them', async () => {
        const home = await temporaryHome();
        const runs = new RunStore(home);
        const id = await createRun(runs, 'docker', 'opencode', 1, 'failed');
        await append(runs, id, 'opencode', [
            ['input.delivered', { id: 'send', kind: 'send', text: 'Build a report' }],
            ['run.failed', { message: 'Tool failed' }],
        ]);
        const restored = await new SessionTranscript(home, sessionId).restore();
        expect(restored.items.at(-1)).toMatchObject({
            kind: 'notice',
            tone: 'error',
            text: 'Previous run failed: Tool failed',
        });
        expect(restored.ready).toBeFalse();
    });

    test('does not treat a cursor before native readiness as a ready session', async () => {
        const home = await temporaryHome();
        const runs = new RunStore(home);
        const id = await createRun(runs, 'e2b', 'opencode', 1, 'running');
        await append(runs, id, 'opencode', [['run.started', {}]]);
        const restored = await new SessionTranscript(home, sessionId).restore();
        expect(restored.items).toEqual([]);
        expect(restored.ready).toBeFalse();
        expect(restored.cursor).toEqual({ runId: id, sequence: 1 });
    });

    for (const type of ['input.requested', 'question.requested'] as const) {
        test(`replays an outstanding ${type} instead of skipping its UI`, async () => {
            const home = await temporaryHome();
            const runs = new RunStore(home);
            const id = await createRun(runs, 'e2b', 'opencode', 1, 'running');
            await append(runs, id, 'opencode', [
                ['run.ready', {}],
                [
                    'input.delivered',
                    { id: 'send', kind: 'send', text: 'Build the report' },
                ],
                ['turn.started', {}],
                [type, { id: 'pending' }],
            ]);
            const restored = await new SessionTranscript(home, sessionId).restore();
            expect(restored.cursor).toEqual({ runId: id, sequence: 3 });
            expect(restored.ready).toBeTrue();
            expect(restored.state?.busy).toBeTrue();
            expect(restored.items.filter((item) => item.kind === 'user')).toHaveLength(
                1
            );
        });
    }

    test('retains a valid cache when no run logs remain', async () => {
        const home = await temporaryHome();
        const transcript = new SessionTranscript(home, sessionId);
        const items = [
            {
                id: 'cached',
                kind: 'assistant' as const,
                text: 'Retained cached conversation',
            },
        ];
        transcript.schedule(items);
        await transcript.flush();
        expect((await transcript.restore()).items).toEqual(items);
    });
});

async function temporaryHome(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'workbench-session-history-'));
    homes.push(home);
    return home;
}

async function createRun(
    runs: RunStore,
    runtime: string,
    runner: string,
    order: number,
    status: 'running' | 'completed' | 'failed',
    stableId = sessionId
): Promise<string> {
    const run = await runs.create({
        metadata: {
            workbench: 'reports',
            workbench_version: '0.1.0',
            runner,
            model: 'openai/gpt-5.4-mini',
            runtime,
            workspace: '/workspace',
            session_id: stableId,
        },
        request: { workbench_path: '/package', workspace: '/workspace', task: '' },
    });
    await runs.update(run.id, {
        status,
        dispatched_at: new Date(Date.UTC(2026, 8, 17, 0, 0, order)).toISOString(),
    });
    return run.id;
}

async function append(
    runs: RunStore,
    id: string,
    runner: string,
    drafts: Array<[WorkbenchEvent['type'], unknown]>
): Promise<void> {
    for (const [index, [type, data]] of drafts.entries()) {
        await runs.appendEvent(id, {
            protocol: 0,
            run_id: id,
            sequence: index + 1,
            timestamp: '2026-09-17T00:00:00.000Z',
            type,
            runner,
            data,
        });
    }
}
