import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliInput } from '../src/commands/input.js';
import { RunControl } from '../src/runs/control.js';
import { RunEvents, type WorkbenchEventType } from '../src/runs/events.js';
import { RunStore } from '../src/runs/store.js';
import { RunSupervision } from '../src/runs/supervision.js';
import { SessionControl } from '../src/sessions/control.js';

const directories: string[] = [];
afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
});

async function fixture(mode: 'interactive' | 'detached' = 'interactive') {
    const home = await mkdtemp(join(tmpdir(), 'supervision-'));
    directories.push(home);
    const store = new RunStore(home);
    const run = await store.create({
        metadata: {
            workbench: 'probe',
            workbench_version: '0.1.0',
            runner: 'opencode',
            model: 'openai/gpt-5.4-mini',
            workspace: home,
            mode,
        },
        request: { workbench_path: home, workspace: home, task: '' },
    });
    await store.update(run.id, { status: 'running', pid: process.pid });
    const events = new RunEvents({
        runId: run.id,
        runner: run.runner,
        onEvent: (event) => store.appendEvent(run.id, event),
    });
    const emit = (type: WorkbenchEventType, data: Record<string, unknown> = {}) =>
        events.emit(type, data);
    return {
        home,
        store,
        run: await store.read(run.id),
        emit,
        supervision: new RunSupervision(home),
    };
}

describe('read-only run supervision', () => {
    test('idle, final response, usage, and outcome come from the last turn', async () => {
        const f = await fixture();
        await f.emit('run.ready');
        await f.emit('turn.started');
        await f.emit('output.text', { id: 'earlier', text: 'thinking' });
        await f.emit('output.text', { id: 'final', text: 'Hello ' });
        await f.emit('output.text', { id: 'final', text: 'world.\n' });
        await f.emit('usage.updated', { total_tokens: 12 });
        await f.emit('outcome.available', { outcome_id: 'result' });
        await f.emit('turn.completed');
        expect(await f.supervision.wait(f.run)).toMatchObject({
            state: 'idle',
            final: 'Hello world.',
            usage: { total_tokens: 12 },
            outcome_id: 'result',
            pending_requests: [],
        });
    });

    test('a new turn resets the answer even when the runner omits message IDs', async () => {
        const f = await fixture();
        await f.emit('turn.started');
        await f.emit('output.text', { text: 'old' });
        await f.emit('turn.completed');
        await f.emit('turn.started');
        await f.emit('output.text', { text: 'new' });
        await f.emit('turn.completed');
        expect((await f.supervision.snapshot(f.run)).final).toBe('new');
    });

    test('usage sums deltas within the latest turn, not across turns', async () => {
        const f = await fixture();
        await f.emit('turn.started');
        await f.emit('usage.updated', { kind: 'delta', total_tokens: 100 });
        await f.emit('turn.completed');
        await f.emit('turn.started');
        await f.emit('usage.updated', { kind: 'delta', total_tokens: 12 });
        await f.emit('usage.updated', { kind: 'delta', total_tokens: 8 });
        await f.emit('turn.completed');
        expect((await f.supervision.snapshot(f.run)).usage.total_tokens).toBe(20);
    });

    test('an old idle boundary cannot satisfy --after; timeout does not mutate the run', async () => {
        const f = await fixture();
        await f.emit('run.ready');
        await f.emit('turn.completed');
        const before = await f.store.readEvents(f.run.id);
        const result = await f.supervision.wait(f.run, {
            afterSequence: before.at(-1)?.sequence ?? 0,
            timeoutMilliseconds: 10,
        });
        expect(result.state).toBe('timeout');
        expect(await f.store.readEvents(f.run.id)).toEqual(before);
        expect((await f.store.read(f.run.id)).status).toBe('running');
    });

    test('wait observes a future completion without outputting events', async () => {
        const f = await fixture();
        await f.emit('run.ready');
        await f.emit('turn.started');
        const waiting = f.supervision.wait(f.run, { timeoutMilliseconds: 1000 });
        await f.emit('output.text', { text: 'finished' });
        await f.emit('turn.completed');
        expect(await waiting).toMatchObject({ state: 'idle', final: 'finished' });
    });

    test('queued work and delivered-but-not-started work are not idle', async () => {
        const f = await fixture();
        await f.emit('run.ready');
        await f.emit('input.queued', { id: 'next', kind: 'follow_up' });
        await f.emit('turn.completed');
        expect((await f.supervision.snapshot(f.run)).state).toBe('running');
        await f.emit('input.delivered', { id: 'next', kind: 'follow_up' });
        expect((await f.supervision.snapshot(f.run)).state).toBe('running');
    });

    test('unattended turn boundaries do not claim runtime cleanup has completed', async () => {
        const f = await fixture('detached');
        await f.emit('run.ready');
        await f.emit('turn.started');
        await f.emit('turn.completed');
        const turn = await f.supervision.wait(f.run, { timeoutMilliseconds: 5 });
        expect(turn.state).toBe('turn_completed');
        expect(
            (
                await f.supervision.wait(f.run, {
                    afterSequence: turn.sequence,
                    timeoutMilliseconds: 5,
                })
            ).state
        ).toBe('timeout');
        await f.emit('run.completed');
        await f.store.update(f.run.id, { status: 'completed' });
        expect((await f.supervision.wait(f.run)).state).toBe('completed');
    });

    test('every queued turn remains observable even after the execution closes', async () => {
        const f = await fixture('detached');
        await f.emit('run.ready');
        await f.emit('turn.started');
        await f.emit('input.queued', { id: 'next' });
        await f.emit('output.text', { id: 'first', text: 'first final' });
        await f.emit('usage.updated', { total_tokens: 10 });
        await f.emit('outcome.available', { outcome_id: 'first-outcome' });
        await f.emit('turn.completed');
        const firstSequence = (await f.store.readEvents(f.run.id)).at(-1)?.sequence;
        await f.emit('input.delivered', { id: 'next', kind: 'follow_up' });
        await f.emit('turn.started');
        await f.emit('output.text', { id: 'second', text: 'second final' });
        await f.emit('usage.updated', { total_tokens: 20 });
        await f.emit('outcome.available', { outcome_id: 'second-outcome' });
        await f.emit('turn.completed');
        const secondSequence = (await f.store.readEvents(f.run.id)).at(-1)?.sequence;
        const first = await f.supervision.wait(f.run);
        expect(first).toMatchObject({
            state: 'turn_completed',
            sequence: firstSequence,
            final: 'first final',
            usage: { total_tokens: 10 },
            outcome_id: 'first-outcome',
        });
        const second = await f.supervision.wait(f.run, {
            afterSequence: first.sequence,
        });
        expect(second).toMatchObject({
            state: 'turn_completed',
            sequence: secondSequence,
            final: 'second final',
            usage: { total_tokens: 20 },
            outcome_id: 'second-outcome',
        });
        await f.emit('run.completed');
        await f.store.update(f.run.id, { status: 'completed' });
        expect(await f.supervision.wait(await f.store.read(f.run.id))).toEqual(first);
        expect(
            await f.supervision.wait(f.run, { afterSequence: first.sequence })
        ).toMatchObject({ state: 'completed', final: 'second final' });
        expect(
            await f.supervision.wait(f.run, { afterSequence: second.sequence })
        ).toMatchObject({ state: 'completed', final: 'second final' });
    });

    test('a live observer returns the first boundary before a queued turn finishes', async () => {
        const f = await fixture('detached');
        await f.emit('turn.started');
        await f.emit('input.queued', { id: 'next' });
        const waiting = f.supervision.wait(f.run, { timeoutMilliseconds: 1000 });
        await f.emit('output.text', { text: 'first final' });
        await f.emit('turn.completed');
        await f.emit('input.delivered', { id: 'next', kind: 'follow_up' });
        await f.emit('turn.started');
        expect(await waiting).toMatchObject({
            state: 'turn_completed',
            final: 'first final',
        });
        expect((await f.supervision.snapshot(f.run)).state).toBe('running');
    });

    test('terminal metadata drains events appended after the observer reads its batch', async () => {
        const f = await fixture('detached');
        await f.emit('turn.started');
        const original = RunStore.prototype.readEvents;
        let first = true;
        const observer = spyOn(RunStore.prototype, 'readEvents').mockImplementation(
            async function (this: RunStore, id) {
                const events = await original.call(this, id);
                if (first) {
                    first = false;
                    await f.emit('output.text', { text: 'final response' });
                    await f.emit('outcome.available', { outcome_id: 'latest' });
                    await f.emit('turn.completed');
                    await f.emit('run.completed');
                    await f.store.update(f.run.id, { status: 'completed' });
                }
                return events;
            }
        );
        try {
            expect(await f.supervision.wait(f.run)).toMatchObject({
                state: 'completed',
                final: 'final response',
                outcome_id: 'latest',
                sequence: 5,
            });
        } finally {
            observer.mockRestore();
        }
    });

    test('permissions, questions, and authentication stop wait and resolve by ID', async () => {
        const f = await fixture();
        await f.emit('run.ready');
        await f.emit('turn.started');
        await f.emit('input.requested', {
            id: 'p',
            kind: 'permission',
            message: 'Run command?',
            options: ['allow_once', 'reject'],
        });
        await f.emit('question.requested', {
            id: 'q',
            questions: [
                { question: 'Which?', options: [], multiple: false, custom: true },
            ],
        });
        await f.emit('authentication.requested', {
            provider: 'openai',
            url: 'https://example.test/login',
        });
        expect(
            (await f.supervision.wait(f.run)).pending_requests.map(
                (request) => request.kind
            )
        ).toEqual(['permission', 'question', 'authentication']);
        await f.emit('input.accepted', { id: 'p', kind: 'permission' });
        await f.emit('question.answered', { id: 'q', answer_count: 1 });
        await f.emit('authentication.completed', { provider: 'openai' });
        expect((await f.supervision.snapshot(f.run)).pending_requests).toEqual([]);
    });

    for (const status of ['failed', 'cancelled'] as const)
        test(`terminal ${status} retains the response and no pending requests`, async () => {
            const f = await fixture();
            await f.emit('input.requested', { id: 'p' });
            await f.emit('output.text', { text: 'partial' });
            await f.emit(`run.${status}`, { message: 'failure' });
            await f.store.update(f.run.id, { status });
            expect(await f.supervision.wait(f.run)).toMatchObject({
                state: status,
                final: 'partial',
                pending_requests: [],
            });
        });

    test('invalid wait parameters fail before polling', async () => {
        const f = await fixture();
        await expect(f.supervision.wait(f.run, { afterSequence: -1 })).rejects.toThrow(
            '--after'
        );
        await expect(
            f.supervision.wait(f.run, { timeoutMilliseconds: NaN })
        ).rejects.toThrow('--timeout');
    });

    test('interrupting observation returns the actual state and never cancels execution', async () => {
        const f = await fixture();
        await f.emit('run.ready');
        await f.emit('turn.started');
        const before = await f.store.readEvents(f.run.id);
        expect(
            await f.supervision.wait(f.run, { signal: AbortSignal.abort() })
        ).toMatchObject({ state: 'running', interrupted: true });
        expect((await f.store.read(f.run.id)).status).toBe('running');
        expect(await f.store.readEvents(f.run.id)).toEqual(before);
    });
});

describe('session answers and explicit input sources', () => {
    test('answers a permission once, without recording the decision', async () => {
        const f = await fixture();
        await f.emit('input.requested', {
            id: 'permission',
            kind: 'permission',
            options: ['allow_once', 'reject'],
        });
        const control = new RunControl(f.home, f.run.id);
        const answering = new SessionControl(f.home).answer(
            f.run.id,
            'permission',
            'allow'
        );
        const request = await control.receive();
        expect(request?.permission).toEqual({
            id: 'permission',
            decision: 'allow_once',
        });
        if (!request) throw new Error('Missing request');
        await control.resolve(request, {
            outcome: 'accepted',
            disposition: 'delivered',
        });
        expect((await answering).receipt?.outcome).toBe('accepted');
        expect(JSON.stringify(await f.store.readEvents(f.run.id))).not.toContain(
            'decision'
        );
        await f.emit('input.accepted', { id: 'permission', kind: 'permission' });
        await expect(
            new SessionControl(f.home).answer(f.run.id, 'permission', 'allow')
        ).rejects.toThrow('no longer pending');
    });

    test('refuses unoffered permission scopes and authentication credentials', async () => {
        const f = await fixture();
        await f.emit('input.requested', {
            id: 'permission',
            kind: 'permission',
            options: ['allow_once', 'reject'],
        });
        const control = new SessionControl(f.home);
        await expect(
            control.answer(f.run.id, 'permission', 'allow_always')
        ).rejects.toThrow('offered');
        await f.emit('authentication.requested', { provider: 'openai' });
        await expect(
            control.answer(f.run.id, 'authentication:openai', 'secret')
        ).rejects.toThrow('cannot supply credentials');
    });

    test('validates questions before submitting and supports multi-question answers', async () => {
        const f = await fixture();
        await f.emit('question.requested', {
            id: 'q',
            questions: [
                {
                    question: 'First?',
                    options: [{ label: 'A' }],
                    multiple: false,
                    custom: false,
                },
                {
                    question: 'Second?',
                    options: [{ label: 'B' }, { label: 'C' }],
                    multiple: true,
                    custom: false,
                },
            ],
        });
        const sessions = new SessionControl(f.home);
        await expect(sessions.answer(f.run.id, 'q', 'A')).rejects.toThrow(
            'every question'
        );
        await expect(
            sessions.answer(f.run.id, 'q', '[["unknown"],["B"]]')
        ).rejects.toThrow('offered');
        const answering = sessions.answer(f.run.id, 'q', '[["A"],["B","C"]]');
        const control = new RunControl(f.home, f.run.id);
        const request = await control.receive();
        expect(request?.question?.response).toEqual({
            outcome: 'answered',
            answers: [['A'], ['B', 'C']],
        });
        if (!request) throw new Error('Missing request');
        await control.resolve(request, {
            outcome: 'accepted',
            disposition: 'delivered',
        });
        await answering;
    });

    test('does not silently choose between input sources or accept empty text', async () => {
        const input = new CliInput();
        expect(await input.read({ text: ' text ' })).toBe('text');
        await expect(input.read({})).rejects.toThrow('exactly one');
        await expect(input.read({ text: 'text', file: 'file' })).rejects.toThrow(
            'exactly one'
        );
        await expect(input.read({ text: ' ' })).rejects.toThrow('empty');
    });
});
