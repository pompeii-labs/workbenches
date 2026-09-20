import { afterEach, describe, expect, test } from 'bun:test';
import { testRender } from '@opentui/solid';
import { CliRunClient } from '../../src/commands/run-client.js';
import { RepositoryDeliveryStore } from '../../src/repositories/receipts.js';
import { RunEvents } from '../../src/runs/events.js';
import { StoredRunHandle } from '../../src/runs/handle.js';
import { RunStore } from '../../src/runs/store.js';
import { RunSupervision } from '../../src/runs/supervision.js';
import { DeliveryCard } from '../../src/tui/delivery.js';
import { emptyTranscript, reduceTranscript } from '../../src/tui/model.js';
import { SessionTranscript } from '../../src/tui/session-transcript.js';
import { ThemeController, ThemeProvider } from '../../src/tui/theme/index.js';
import { binding, result, temporary } from './fixture.js';

const renderers: Array<{ destroy(): void }> = [];
afterEach(() => {
    for (const renderer of renderers.splice(0)) renderer.destroy();
});

describe('repository delivery presentation', () => {
    test('foreground continuation includes preparation and in-turn delivery events before execution ends', async () => {
        const home = await temporary();
        const outcome = await result(home);
        const runs = new RunStore(home);
        const events = new RunEvents({
            runId: outcome.run_id,
            runner: 'opencode',
            onEvent: (event) => runs.appendEvent(outcome.run_id, event),
        });
        const input = 'input_fixture';
        await events.emit('repository.preparing', {
            repository: 'example/project',
            revision: binding.revision,
        });
        await events.emit('repository.ready', {
            repository: 'example/project',
            revision: binding.revision,
        });
        await events.emit('turn.started', { input_id: input });
        await events.emit('output.text', { text: 'Changes prepared.' });
        await events.emit('delivery.started', {
            outcome_id: outcome.id,
            repository: 'example/project',
        });
        await events.emit('delivery.failed', {
            outcome_id: outcome.id,
            state: 'failed',
            message: 'GitHub request failed',
        });
        await events.emit('turn.completed', { input_id: input });
        await events.emit('run.completed', {});
        const rendered: string[] = [];
        const followed = await new CliRunClient().followInput(
            new StoredRunHandle(home, outcome.run_id),
            input,
            (event) => rendered.push(event.type),
            0,
            true
        );
        expect(followed).toMatchObject({
            interrupted: false,
            reachedBoundary: true,
            terminalStatus: 'completed',
        });
        expect(rendered).toEqual([
            'repository.preparing',
            'repository.ready',
            'turn.started',
            'output.text',
            'delivery.started',
            'delivery.failed',
            'turn.completed',
            'run.completed',
        ]);
    });

    test('replays preparation feedback and deduplicated published draft links from durable events', async () => {
        const home = await temporary();
        const outcome = await result(home);
        const runs = new RunStore(home);
        await runs.update(outcome.run_id, { session_id: binding.session_id });
        const events = new RunEvents({
            runId: outcome.run_id,
            runner: 'opencode',
            onEvent: (event) => runs.appendEvent(outcome.run_id, event),
        });
        let state = reduceTranscript(
            emptyTranscript(),
            await events.emit('repository.preparing', {
                repository: 'example/project',
                revision: binding.revision,
            })
        );
        expect(state).toMatchObject({ busy: true, status: 'Preparing repository' });
        state = reduceTranscript(
            state,
            await events.emit('delivery.started', {
                outcome_id: outcome.id,
                repository: 'example/project',
            })
        );
        expect(state.status).toBe('Publishing draft PR');
        const data = {
            outcome_id: outcome.id,
            state: 'published',
            pull_request: {
                number: 1,
                url: 'https://github.com/example/project/pull/1',
            },
        };
        for (let attempt = 0; attempt < 2; attempt++)
            state = reduceTranscript(
                state,
                await events.emit('delivery.completed', data)
            );
        expect(state.items.filter((item) => item.kind === 'delivery')).toHaveLength(1);
        const transcript = new SessionTranscript(home, binding.session_id);
        transcript.schedule(state.items);
        await transcript.flush();
        const restored = await transcript.restore();
        expect(restored.items.find((item) => item.kind === 'delivery')).toMatchObject({
            state: 'published',
            url: data.pull_request.url,
        });
    });

    test('renders a historical failed delivery without a nonexistent retry command', async () => {
        const home = await temporary();
        const themes = new ThemeController(home);
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <DeliveryCard
                        item={{
                            id: 'delivery',
                            kind: 'delivery',
                            outcomeId: 'wbo_1234567890abcdefghij',
                            state: 'failed',
                            message: 'GitHub POST request failed with HTTP 403',
                        }}
                    />
                </ThemeProvider>
            ),
            { width: 100, height: 10 }
        );
        renderers.push(setup.renderer);
        await setup.flush();
        const frame = setup.captureCharFrame();
        expect(frame).toContain('Work saved');
        expect(frame).toContain('PR delivery failed');
        expect(frame).toContain('Resume the agent to continue GitHub work');
        expect(frame).toContain('wbo_1234567890abcdefghij');
        expect(frame).not.toContain('Draft PR created');
    });

    test('PR delivery does not mark an active agent idle, and CI cards update by actual head', async () => {
        const home = await temporary();
        const events = new RunEvents({ runId: binding.session_id, runner: 'opencode' });
        let state = reduceTranscript(
            emptyTranscript(),
            await events.emit('turn.started', { input_id: 'input_fixture' })
        );
        const pull = {
            number: 1,
            url: 'https://github.com/example/project/pull/1',
        };
        for (const type of ['delivery.completed', 'delivery.failed'] as const) {
            state = reduceTranscript(
                state,
                await events.emit(type, {
                    outcome_id: 'wbo_1234567890abcdefghij',
                    state: type === 'delivery.completed' ? 'published' : 'failed',
                    pull_request: pull,
                })
            );
            expect(state).toMatchObject({ busy: true, status: 'Working' });
        }
        for (const result of [
            { head: 'a'.repeat(40), state: 'pending' },
            { head: 'a'.repeat(40), state: 'failed' },
            { head: 'b'.repeat(40), state: 'passed' },
        ])
            state = reduceTranscript(
                state,
                await events.emit('repository.checks', {
                    pull_request: { ...pull, head: result.head },
                    state: result.state,
                    jobs: [{ id: 9 }],
                })
            );
        expect(state.items.filter((item) => item.kind === 'checks')).toMatchObject([
            { head: 'a'.repeat(40), state: 'failed', jobs: 1 },
            { head: 'b'.repeat(40), state: 'passed', jobs: 1 },
        ]);
        expect(state.busy).toBe(true);
        state = reduceTranscript(
            state,
            await events.emit('turn.completed', { input_id: 'input_fixture' })
        );
        expect(state.busy).toBe(false);
        const transcript = new SessionTranscript(home, 'wb_1234567890abcdefghij');
        transcript.schedule(state.items);
        await transcript.flush();
        expect(
            (await transcript.restore()).items.filter((item) => item.kind === 'checks')
        ).toHaveLength(2);
    });

    test('exposes unchanged delivery and immutable repository provenance through headless supervision', async () => {
        const home = await temporary();
        const outcome = await result(home);
        const receipt = {
            version: 1 as const,
            run_id: outcome.run_id,
            session_id: binding.session_id,
            outcome_id: outcome.id,
            repository: 'example/project',
            revision: binding.revision,
            base_branch: binding.base_branch,
            branch: `workbenches/${binding.session_id}`,
            created_at: new Date().toISOString(),
            state: 'unchanged' as const,
        };
        await new RepositoryDeliveryStore(home).write(receipt);
        const run = await new RunStore(home).read(outcome.run_id);
        expect(await new RunSupervision(home).snapshot(run)).toMatchObject({
            state: 'completed',
            repository: binding,
            delivery: receipt,
        });
    });
});
