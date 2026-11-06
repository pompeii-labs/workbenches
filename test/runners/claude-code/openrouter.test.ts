import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Connection } from '../../../src/database/connection.js';
import { ModelRouter } from '../../../src/models/index.js';
import { createEventRenderer } from '../../../src/rendering/events.js';
import { ClaudeCodeSessionAdapter } from '../../../src/runners/claude-code/adapter.js';
import {
    type OpenRouterAccess,
    OpenRouterGenerations,
} from '../../../src/runners/claude-code/openrouter.js';
import { RunEvents, type WorkbenchEventDraft } from '../../../src/runs/events.js';
import { RunStatusReader } from '../../../src/runs/status.js';
import { Services } from '../../../src/workbench/services.js';
import { modelCatalogFixture } from '../../model-catalog-fixture.js';
import { claudeCodeWorkbench, FakeClaudeCode, PREPARED } from './fixture.js';

const KEY = 'sk-or-v1-fake-openrouter-key';

/** A fake OpenRouter: each generation answers its scripted statuses in order, then its charge. */
function openRouter(script: Record<string, { statuses?: number[]; cost?: number }>) {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const sleeps: number[] = [];
    const seen = new Map<string, number>();
    const access: OpenRouterAccess = {
        fetch: async (input, init) => {
            const url = new URL(String(input));
            requests.push({
                url: url.href,
                authorization: new Headers(init?.headers).get('authorization'),
            });
            const id = url.searchParams.get('id') ?? '';
            const attempt = seen.get(id) ?? 0;
            seen.set(id, attempt + 1);
            const generation = script[id];
            const status = generation?.statuses?.[attempt];
            if (!generation || status !== undefined || generation.cost === undefined) {
                return Response.json(
                    { error: { code: status ?? 404, message: 'Generation not found' } },
                    { status: status ?? 404 }
                );
            }
            return Response.json({
                data: {
                    id,
                    finish_reason: 'stop',
                    total_cost: generation.cost,
                    usage: 1,
                },
            });
        },
        sleep: async (milliseconds) => void sleeps.push(milliseconds),
    };
    return { access, requests, sleeps };
}

describe('OpenRouter generation charges', () => {
    test('reads what each generation was charged with the route key', async () => {
        const fake = openRouter({
            'gen-1-a': { cost: 0.0292 },
            'gen-2-b': { cost: 0.0075 },
        });
        const generations = new OpenRouterGenerations(KEY, fake.access);

        expect(await generations.total(['gen-1-a', 'gen-2-b'])).toBeCloseTo(0.0367, 10);
        expect(fake.requests).toEqual([
            {
                url: 'https://openrouter.ai/api/v1/generation?id=gen-1-a',
                authorization: `Bearer ${KEY}`,
            },
            {
                url: 'https://openrouter.ai/api/v1/generation?id=gen-2-b',
                authorization: `Bearer ${KEY}`,
            },
        ]);
        expect(await generations.total([])).toBe(0);
    });

    test('retries a generation that is not found yet, and a server error', async () => {
        const fake = openRouter({
            'gen-1-a': { statuses: [404, 404, 502], cost: 0.01 },
        });
        const generations = new OpenRouterGenerations(KEY, fake.access);

        expect(await generations.cost('gen-1-a')).toBe(0.01);
        expect(fake.requests).toHaveLength(4);
        expect(fake.sleeps).toHaveLength(3);
    });

    test('gives up after a bounded number of attempts, naming only the generation and status', async () => {
        const fake = openRouter({});
        const generations = new OpenRouterGenerations(KEY, fake.access);

        const error = await generations.cost('gen-9-missing').catch((value) => value);
        expect(error).toBeInstanceOf(Error);
        expect(String(error.message)).toBe(
            'OpenRouter generation gen-9-missing was not read: 404'
        );
        expect(fake.requests.length).toBeGreaterThan(1);
        expect(fake.sleeps.reduce((sum, delay) => sum + delay, 0)).toBeLessThanOrEqual(
            60_000
        );
        expect(await generations.total(['gen-9-missing'])).toBeUndefined();
    });

    test('never retries a refused key, and never fetches an id that is not a generation', async () => {
        const fake = openRouter({ 'gen-1-a': { statuses: [401], cost: 0.01 } });
        const generations = new OpenRouterGenerations(KEY, fake.access);

        const refused = await generations.cost('gen-1-a').catch((value) => value);
        expect(refused.message).toBe('OpenRouter generation gen-1-a was not read: 401');
        expect(fake.requests).toHaveLength(1);
        expect(await generations.total(['req_011CUuL8', 'gen-1-a'])).toBeUndefined();
        const foreign = await generations.cost(`req_${KEY}`).catch((value) => value);
        expect(foreign.message).not.toContain(KEY);
        expect(fake.requests.every((request) => request.url.includes('gen-1-a'))).toBe(
            true
        );
    });

    test('a network failure names no detail, and a malformed charge is not a cost', async () => {
        const generations = new OpenRouterGenerations(KEY, {
            fetch: async () => {
                throw new TypeError(`fetch failed for Bearer ${KEY}`);
            },
            sleep: async () => {},
        });
        const failed = await generations.cost('gen-1-a').catch((value) => value);
        expect(failed.message).toBe(
            'OpenRouter generation gen-1-a was not read: no response'
        );

        const malformed = new OpenRouterGenerations(KEY, {
            fetch: async () =>
                Response.json({ data: { finish_reason: 'stop', total_cost: 'free' } }),
            sleep: async () => {},
        });
        const unreadable = await malformed.cost('gen-1-a').catch((value) => value);
        expect(unreadable.message).toBe(
            'OpenRouter generation gen-1-a was not read: no charged cost'
        );
    });

    test('an incomplete record is retried and never counted as free', async () => {
        const empty = { finish_reason: null, tokens_prompt: 0, total_cost: 0 };
        let attempts = 0;
        const generations = new OpenRouterGenerations(KEY, {
            fetch: async () =>
                Response.json({
                    data:
                        ++attempts < 3
                            ? empty
                            : { finish_reason: 'stop', total_cost: 0.02 },
                }),
            sleep: async () => {},
        });
        expect(await generations.cost('gen-1-a')).toBe(0.02);
        expect(attempts).toBe(3);

        const never = new OpenRouterGenerations(KEY, {
            fetch: async () => Response.json({ data: empty }),
            sleep: async () => {},
        });
        const error = await never.cost('gen-1-a').catch((value) => value);
        expect(error.message).toBe(
            'OpenRouter generation gen-1-a was not read: incomplete'
        );
        expect(await never.total(['gen-1-a'])).toBeUndefined();
    });
});

describe('Claude Code turns on the OpenRouter route', () => {
    const workbench = claudeCodeWorkbench('/repository');

    async function open(
        access: OpenRouterAccess,
        onEvent?: (event: WorkbenchEventDraft) => Promise<void>,
        meteredRoute = false
    ) {
        const native = new FakeClaudeCode();
        native.scenario = 'manual';
        const events: WorkbenchEventDraft[] = [];
        const adapter = new ClaudeCodeSessionAdapter({
            prepare: async () => ({
                session: {
                    ...PREPARED,
                    routeEnvironment: {
                        ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
                        ANTHROPIC_AUTH_TOKEN: KEY,
                        ANTHROPIC_API_KEY: '',
                    },
                    openRouterKey: meteredRoute ? undefined : KEY,
                },
                cleanup: async () => {},
            }),
            spawn: native.spawn,
            stopTimeoutMs: 1_000,
            openRouter: access,
        });
        const session = await adapter.start({
            workbench,
            workspaceDirectory: '/workspace',
            environment: {},
            configuration: new ModelRouter(modelCatalogFixture).resolve({ workbench }),
            host: {
                emit: async (event) => {
                    events.push(event);
                    await onEvent?.(event);
                },
                requestPermission: async () => 'reject',
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
        });
        return { session, native, events };
    }

    /** One host turn whose model calls carry `generations`, as Claude Code reports them. */
    async function turn(
        opened: Awaited<ReturnType<typeof open>>,
        generations: Array<{ id: string; parent?: string }>
    ) {
        const { session, native } = opened;
        const asked = new Set(
            native.lines.filter((line) => line.type === 'user').map((line) => line.uuid)
        );
        const prompt = session.prompt('work');
        const line = await native.waitFor(
            (value) => value.type === 'user' && !asked.has(value.uuid)
        );
        const command = String(line.uuid);
        native.turn(command);
        for (const generation of generations) {
            // Claude Code emits one frame per content block, each with the call's id.
            for (const text of ['Hello', ' world']) {
                native.emit({
                    type: 'assistant',
                    message: {
                        id: `msg_${generation.id}`,
                        role: 'assistant',
                        content: [{ type: 'text', text }],
                    },
                    parent_tool_use_id: generation.parent ?? null,
                    session_id: native.sessionId,
                    request_id: generation.id,
                });
            }
        }
        native.finishTurn(command, {
            usage: { input_tokens: 1200, output_tokens: 300 },
            // Claude Code's own estimate from Anthropic rates, never reported here.
            total_cost_usd: 0.0713,
        });
        return prompt;
    }

    function usage(events: WorkbenchEventDraft[]) {
        return events
            .filter((event) => event.type === 'usage.updated')
            .map((event) => event.data);
    }

    test('a turn costs the sum of what OpenRouter charged for each of its generations', async () => {
        const fake = openRouter({
            'gen-1793808752-mMF5gcUbTrFCIx3u07fe': { cost: 0.0292 },
            'gen-1793808760-Q2kSdp0xVv8Lr1YtHa9c': { cost: 0.0075 },
        });
        const opened = await open(fake.access);
        const result = await turn(opened, [
            { id: 'gen-1793808752-mMF5gcUbTrFCIx3u07fe' },
            { id: 'gen-1793808760-Q2kSdp0xVv8Lr1YtHa9c', parent: 'call_agent' },
        ]);
        await opened.session.close();

        expect(result.reason).toBe('end_turn');
        expect(usage(opened.events)).toEqual([
            {
                kind: 'delta',
                total_tokens: 1500,
                input_tokens: 1200,
                output_tokens: 300,
            },
            { kind: 'delta', cost_usd: expect.closeTo(0.0367, 10) },
        ]);
        // Several frames of one call are one generation, looked up once.
        expect(fake.requests).toHaveLength(2);
    });

    test('a generation that is not found at first is retried and counted', async () => {
        const fake = openRouter({
            'gen-1-late': { statuses: [404, 404], cost: 0.004 },
        });
        const opened = await open(fake.access);
        await turn(opened, [{ id: 'gen-1-late' }]);
        await opened.session.close();

        expect(usage(opened.events).map((data) => data.cost_usd)).toEqual([
            undefined,
            0.004,
        ]);
        expect(fake.requests).toHaveLength(3);
    });

    test('a generation that never resolves leaves the turn without a cost, and the turn completes', async () => {
        const fake = openRouter({
            'gen-1-found': { cost: 0.01 },
            'gen-3-next': { cost: 0.02 },
        });
        const release = Promise.withResolvers<void>();
        const opened = await open({
            ...fake.access,
            sleep: async (milliseconds) => {
                fake.sleeps.push(milliseconds);
                await release.promise;
            },
        });
        const result = await turn(opened, [
            { id: 'gen-1-found' },
            { id: 'gen-2-lost' },
        ]);

        expect(result.reason).toBe('end_turn');
        expect(usage(opened.events)).toEqual([
            {
                kind: 'delta',
                total_tokens: 1500,
                input_tokens: 1200,
                output_tokens: 300,
            },
        ]);

        // The next turn counts only its own generations, never an earlier one again.
        await turn(opened, [{ id: 'gen-1-found' }, { id: 'gen-3-next' }]);
        release.resolve();
        await opened.session.close();
        expect(usage(opened.events).at(-1)?.cost_usd).toBe(0.02);
        expect(usage(opened.events).map((data) => data.cost_usd)).toEqual([
            undefined,
            undefined,
            0.02,
        ]);
        expect(
            fake.requests.filter((request) => request.url.endsWith('gen-1-found'))
        ).toHaveLength(1);
    });

    test('completes the turn while lookups are unresolved and drains the summed charge on close', async () => {
        const reply = Promise.withResolvers<void>();
        const started = Promise.withResolvers<void>();
        const opened = await open({
            fetch: async () => {
                started.resolve();
                await reply.promise;
                return Response.json({
                    data: { finish_reason: 'stop', total_cost: 0.004 },
                });
            },
            sleep: async () => {},
        });
        const prompt = turn(opened, [{ id: 'gen-1-a' }, { id: 'gen-2-b' }]);
        try {
            await started.promise;
            // The turn completes while its charge is still being read.
            await prompt;
            expect(usage(opened.events)).toEqual([
                {
                    kind: 'delta',
                    total_tokens: 1500,
                    input_tokens: 1200,
                    output_tokens: 300,
                },
            ]);
            let closed = false;
            const closing = opened.session.close().then(() => {
                closed = true;
            });
            await Bun.sleep(0);
            expect(closed).toBe(false);
            reply.resolve();
            await closing;
            expect(usage(opened.events).at(-1)).toEqual({
                kind: 'delta',
                cost_usd: 0.008,
            });
        } finally {
            reply.resolve();
            await opened.session.close();
            await prompt;
        }
    });

    test('a turn closed before its result still reports what OpenRouter charged', async () => {
        const fake = openRouter({ 'gen-1-a': { cost: 0.004 } });
        const spoke = Promise.withResolvers<void>();
        const opened = await open(fake.access, async (event) => {
            if (event.type === 'output.text') spoke.resolve();
        });
        const { session, native } = opened;
        const prompt = session.prompt('work');
        const line = await native.waitFor((value) => value.type === 'user');
        native.turn(String(line.uuid));
        native.emit({
            type: 'assistant',
            message: {
                id: 'msg_gen-1-a',
                role: 'assistant',
                content: [{ type: 'text', text: 'Hello' }],
            },
            parent_tool_use_id: null,
            session_id: native.sessionId,
            request_id: 'gen-1-a',
        });
        await spoke.promise;
        await session.close();

        await expect(prompt).resolves.toEqual({ reason: 'cancelled' });
        expect(usage(opened.events)).toEqual([{ kind: 'delta', cost_usd: 0.004 }]);
        expect(fake.requests).toHaveLength(1);
    });

    test('normal shutdown drains outstanding charges from multiple turns independently', async () => {
        const first = Promise.withResolvers<void>();
        const second = Promise.withResolvers<void>();
        const opened = await open({
            fetch: async (input) => {
                const id = new URL(String(input)).searchParams.get('id');
                await (id === 'gen-1-a' ? first.promise : second.promise);
                return Response.json({
                    data: { finish_reason: 'stop', total_cost: 0.01 },
                });
            },
            sleep: async () => {},
        });
        try {
            await turn(opened, [{ id: 'gen-1-a' }]);
            await turn(opened, [{ id: 'gen-2-b' }]);
            let closed = false;
            const closing = opened.session.close().then(() => {
                closed = true;
            });
            second.resolve();
            await Bun.sleep(0);
            expect(closed).toBe(false);
            expect(usage(opened.events).filter((data) => 'cost_usd' in data)).toEqual([
                { kind: 'delta', cost_usd: 0.01 },
            ]);
            first.resolve();
            await closing;
            expect(usage(opened.events).filter((data) => 'cost_usd' in data)).toEqual([
                { kind: 'delta', cost_usd: 0.01 },
                { kind: 'delta', cost_usd: 0.01 },
            ]);
        } finally {
            first.resolve();
            second.resolve();
            await opened.session.close();
        }
    });

    test('no event carries the key', async () => {
        const fake = openRouter({ 'gen-1-a': { cost: 0.002 } });
        const opened = await open(fake.access);
        await turn(opened, [{ id: 'gen-1-a' }, { id: 'gen-2-missing' }]);
        await turn(opened, [{ id: 'gen-3-b' }]);
        await opened.session.close();

        expect(opened.events.length).toBeGreaterThan(0);
        expect(JSON.stringify(opened.events)).not.toContain(KEY);
    });

    test('other routes retain native token and cost reporting without any lookup', async () => {
        const fake = openRouter({});
        const opened = await open(fake.access, undefined, true);
        try {
            await turn(opened, [{ id: 'req-native' }]);
            await opened.session.close();
            expect(usage(opened.events)).toEqual([
                {
                    kind: 'delta',
                    total_tokens: 1500,
                    input_tokens: 1200,
                    output_tokens: 300,
                    cost_usd: 0.0713,
                },
            ]);
            expect(fake.requests).toHaveLength(0);
        } finally {
            await opened.session.close();
        }
    });

    test('late charges survive storage and reach run totals, wait cursors, and renderers before termination', async () => {
        const home = await mkdtemp(join(tmpdir(), 'claude-code-late-cost-'));
        const connection = Connection.open(home);
        const services = new Services(home, connection);
        const run = await services.runs.create({
            metadata: {
                workbench: 'probe',
                workbench_version: '0.1.0',
                runner: 'claude-code',
                model: 'anthropic/claude-sonnet-4-5',
                workspace: home,
                mode: 'detached',
            },
            request: { workbench_path: home, workspace: home, task: '' },
        });
        const output: string[] = [];
        const human = createEventRenderer({
            mode: 'human',
            color: false,
            stdout: (text) => void output.push(text),
        });
        const json: string[] = [];
        const machine = createEventRenderer({
            mode: 'json',
            stdout: (text) => void json.push(text),
        });
        const emitter = new RunEvents({
            runId: run.id,
            runner: run.runner,
            onEvent: async (event) => {
                await services.runs.appendEvent(run.id, event);
                human.render(event);
                machine.render(event);
            },
        });
        const release = Promise.withResolvers<void>();
        const fake = openRouter({
            'gen-1-late': { statuses: [404, 404, 404], cost: 0.03675 },
        });
        const opened = await open(
            {
                ...fake.access,
                sleep: async (milliseconds) => {
                    fake.sleeps.push(milliseconds);
                    await release.promise;
                },
            },
            async (event) => {
                await emitter.emitDraft(event);
            }
        );
        try {
            await services.runs.update(run.id, { status: 'running', pid: process.pid });
            await emitter.emit('turn.started', {});
            await turn(opened, [{ id: 'gen-1-late' }]);
            const boundary = await emitter.emit('turn.completed', {
                reason: 'end_turn',
            });
            const first = await services.supervision.wait(run);
            expect(first.state).toBe('turn_completed');
            expect(first.usage_total).toEqual({
                kind: 'total',
                total_tokens: 1500,
                input_tokens: 1200,
                output_tokens: 300,
            });
            const closing = opened.session.close();
            release.resolve();
            await closing;
            await emitter.emit('run.completed', {});
            await services.runs.update(run.id, { status: 'completed' });
            const final = await services.supervision.wait(run, {
                afterSequence: boundary.sequence,
            });
            expect(final.state).toBe('completed');
            expect(final.usage).toMatchObject({
                kind: 'delta',
                cost_usd: 0.03675,
                total_tokens: 0,
            });
            expect(final.usage_total).toEqual({
                kind: 'total',
                cost_usd: 0.03675,
                total_tokens: 1500,
                input_tokens: 1200,
                output_tokens: 300,
            });
            expect((await services.supervision.snapshot(run)).usage_total).toEqual(
                final.usage_total
            );
            const status = new RunStatusReader(services.runs, connection, {
                alive: () => true,
            });
            expect((await status.read(await services.runs.read(run.id))).cost_usd).toBe(
                0.03675
            );
            const stored = await services.runs.readEvents(run.id);
            const cost = stored.find(
                (event) =>
                    event.type === 'usage.updated' &&
                    typeof event.data === 'object' &&
                    event.data !== null &&
                    'cost_usd' in event.data
            );
            expect(cost?.sequence).toBeGreaterThan(boundary.sequence);
            expect(stored.at(-1)?.type).toBe('run.completed');
            expect(fake.requests).toHaveLength(4);
            expect(output.join('')).toContain('$0.0367');
            expect(json.join('')).toContain('"cost_usd":0.03675');
            expect(JSON.stringify(stored)).not.toContain(KEY);
        } finally {
            release.resolve();
            await opened.session.close();
            connection.close();
            await rm(home, { recursive: true, force: true });
        }
    });
});
