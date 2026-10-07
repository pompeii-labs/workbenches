import { describe, expect, test } from 'bun:test';

import { ClaudeCodeConfigStaging } from '../src/runners/claude-code/config.js';
import { ClaudeCodeSessionAdapter } from '../src/runners/claude-code/session.js';
import { RunnerContextStaging } from '../src/runners/context/stage.js';
import { MemoryRunnerFiles } from '../src/runners/files/memory.js';
import type {
    RunnerPermissionRequest,
    RunnerQuestionRequest,
} from '../src/runners/session.js';
import {
    type RunnerConformanceScenario,
    runnerAdapterContract,
} from './runner-adapter-contract.js';
import {
    claudeCodeConfiguration,
    claudeCodeWorkbench,
    claudeProtocolFixture,
    claudeProtocolTrace,
    FakeClaudeCode,
} from './runners/claude-code/fixture.js';

function harness() {
    const files = new MemoryRunnerFiles()
        .file('/package/instructions.md', '# Instructions\n')
        .file('/package/skills/review/SKILL.md', '# Review\n')
        .file('/package/runner.json', '{}');
    const native = new FakeClaudeCode();
    return {
        adapter: new ClaudeCodeSessionAdapter({
            config: new ClaudeCodeConfigStaging(files, new RunnerContextStaging(files)),
            spawn: native.spawn,
        }),
        workbench: claudeCodeWorkbench(),
        arrange(scenario: RunnerConformanceScenario) {
            native.scenario = scenario;
        },
        native,
    };
}

runnerAdapterContract({
    name: 'Claude Code',
    createHarness: harness,
});

describe('Claude Code stream session', () => {
    test('translates image input to native base64 content blocks', async () => {
        const observed = harness();
        const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
        const session = await observed.adapter.start(sessionOptions(observed, events));

        await session.prompt({
            text: 'Inspect this image',
            images: [
                {
                    data: 'aW1hZ2UtYnl0ZXM=',
                    mimeType: 'image/png',
                    name: 'diagram.png',
                },
            ],
        });

        expect(JSON.parse(observed.native.invocations[0]?.input[0] ?? '')).toEqual({
            type: 'user',
            uuid: expect.any(String),
            message: {
                role: 'user',
                content: [
                    { type: 'text', text: 'Inspect this image' },
                    {
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: 'image/png',
                            data: 'aW1hZ2UtYnl0ZXM=',
                        },
                    },
                ],
            },
        });
        expect(JSON.stringify(events)).not.toContain('aW1hZ2UtYnl0ZXM=');
        await session.close();
    });

    test('replays a recorded lifecycle trace through the process boundary', async () => {
        const files = new MemoryRunnerFiles()
            .file('/package/instructions.md', '# Instructions\n')
            .file('/package/skills/review/SKILL.md', '# Review\n')
            .file('/package/runner.json', '{}');
        const trace = claudeProtocolTrace('lifecycle-basic.jsonl').slice(0, 7);
        const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
        const adapter = new ClaudeCodeSessionAdapter({
            config: new ClaudeCodeConfigStaging(files, new RunnerContextStaging(files)),
            spawn: () => traceProcess(trace, [0.0203, 0.0232]),
        });
        const workbench = claudeCodeWorkbench();
        const session = await adapter.start({
            workbench,
            workspaceDirectory: '/workspace',
            environment: { ANTHROPIC_API_KEY: 'credential' },
            configuration: claudeCodeConfiguration(workbench),
            host: {
                emit: async (event) => {
                    events.push(event);
                },
                requestPermission: async () => 'reject',
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
        });

        await expect(session.prompt('replay')).resolves.toEqual({
            reason: 'end_turn',
        });
        await expect(session.prompt('replay again')).resolves.toEqual({
            reason: 'end_turn',
        });
        expect(events).toContainEqual({
            type: 'output.text',
            data: { id: 'message-1', text: 'ONE' },
        });
        const costs = events
            .filter((event) => event.type === 'usage.updated')
            .map((event) => event.data?.cost_usd);
        expect(costs[0]).toBeCloseTo(0.0203);
        expect(costs[1]).toBeCloseTo(0.0029);
        await session.close();
    });

    test('reports zero cost for OAuth subscription usage', async () => {
        const files = new MemoryRunnerFiles()
            .file('/package/instructions.md', '# Instructions\n')
            .file('/package/skills/review/SKILL.md', '# Review\n')
            .file('/package/runner.json', '{}');
        const adapter = new ClaudeCodeSessionAdapter({
            config: new ClaudeCodeConfigStaging(files, new RunnerContextStaging(files)),
            spawn: () =>
                traceProcess(
                    claudeProtocolTrace('lifecycle-basic.jsonl').slice(0, 7),
                    [0.0203]
                ),
        });
        const workbench = claudeCodeWorkbench();
        const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
        const session = await adapter.start({
            workbench,
            workspaceDirectory: '/workspace',
            environment: {},
            configuration: {
                ...claudeCodeConfiguration(workbench),
                authenticationMethod: 'oauth',
            },
            host: {
                emit: async (event) => {
                    events.push(event);
                },
                requestPermission: async () => 'reject',
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
        });

        await session.prompt('subscription turn');

        expect(
            events.find((event) => event.type === 'usage.updated')?.data?.cost_usd
        ).toBe(0);
        await session.close();
    });

    test('emits configuration warnings before runner activity', async () => {
        const observed = harness();
        observed.workbench.manifest.mcps = [
            {
                name: 'credentialled',
                transport: 'http',
                url: 'https://example.com/mcp',
                headers: { Authorization: `Bearer ${'$'}{ANTHROPIC_API_KEY}` },
            },
        ];
        const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
        const options = sessionOptions(observed, events);
        const session = await observed.adapter.start({
            ...options,
            environment: { ANTHROPIC_API_KEY: 'credential' },
        });

        await session.prompt('inspect');

        expect(events[0]).toEqual({
            type: 'runner.event',
            data: {
                native_type: 'config.warning',
                message:
                    'MCP credentialled is disabled because Claude Code does not expand Claude or Anthropic environment references in MCP headers',
            },
        });
        await session.close();
    });

    test('maps permission allow, deny, and allow-always responses', async () => {
        for (const [scenario, decision, fixture] of [
            ['permission_allow', 'allow_once', 'permission-allow-response.json'],
            ['permission_deny', 'reject', 'permission-deny-response.json'],
        ] as const) {
            const observed = harness();
            observed.native.scenario = scenario;
            const requests: RunnerPermissionRequest[] = [];
            const session = await observed.adapter.start({
                ...sessionOptions(observed),
                host: {
                    ...sessionOptions(observed).host,
                    requestPermission: async (request) => {
                        requests.push(request);
                        return decision;
                    },
                },
            });
            await session.prompt('request permission');
            expect(requests).toEqual([
                {
                    id: 'permission_contract_1',
                    action: 'Bash',
                    resources: ['npm run test -- --watch=false'],
                    message:
                        'Allow Bash?\nCommand: npm run test -- --watch=false\nDecision reason: The command needs approval\nBlocked path: /workspace/package.json',
                    allowAlways: true,
                },
            ]);
            expect(JSON.parse(observed.native.invocations[0]?.input[1] ?? '')).toEqual(
                claudeProtocolFixture(fixture)
            );
            await session.close();
        }

        const always = harness();
        always.native.scenario = 'permission_always';
        let requestCount = 0;
        const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
        const options = sessionOptions(always, events);
        const session = await always.adapter.start({
            ...options,
            host: {
                ...options.host,
                requestPermission: async () => {
                    requestCount += 1;
                    return 'allow_always';
                },
            },
        });
        await session.prompt('remember permission');
        expect(requestCount).toBe(1);
        expect(JSON.parse(always.native.invocations[0]?.input[1] ?? '')).toEqual(
            claudeProtocolFixture('permission-always-response.json')
        );
        expect(JSON.parse(always.native.invocations[0]?.input[2] ?? '')).toEqual(
            claudeProtocolFixture('permission-cached-response.json')
        );
        expect(events).toContainEqual({
            type: 'runner.event',
            data: { native_type: 'permission.auto_approved' },
        });
        await session.close();
    });

    test('maps multiple questions and rejection through updatedInput', async () => {
        const answered = harness();
        answered.native.scenario = 'questions_multiple';
        const questions: RunnerQuestionRequest[] = [];
        const answeredSession = await answered.adapter.start({
            ...sessionOptions(answered),
            host: {
                ...sessionOptions(answered).host,
                requestQuestion: async (request) => {
                    questions.push(request);
                    return {
                        outcome: 'answered',
                        answers: [['Production'], ['Unit', 'Integration']],
                    };
                },
            },
        });
        await answeredSession.prompt('ask');
        expect(questions[0]).toMatchObject({
            id: 'question_contract',
            questions: [
                { question: 'Where should this deploy?', multiple: false },
                { question: 'Which checks should run?', multiple: true },
            ],
        });
        expect(JSON.parse(answered.native.invocations[0]?.input[1] ?? '')).toEqual(
            claudeProtocolFixture('question-response.json')
        );
        await answeredSession.close();

        const rejected = harness();
        rejected.native.scenario = 'question_reject';
        const rejectedSession = await rejected.adapter.start({
            ...sessionOptions(rejected),
            host: {
                ...sessionOptions(rejected).host,
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
        });
        await rejectedSession.prompt('ask');
        expect(JSON.parse(rejected.native.invocations[0]?.input[1] ?? '')).toEqual(
            claudeProtocolFixture('question-reject-response.json')
        );
        await rejectedSession.close();
    });

    test('holds steering until an active tool call can fold it into the turn', async () => {
        const observed = harness();
        observed.native.scenario = 'steering';
        const session = await observed.adapter.start(sessionOptions(observed));
        const turn = session.prompt('start');
        const delivery = await session.steer?.('change direction');
        await delivery?.delivered;
        expect(JSON.parse(observed.native.invocations[0]?.input[1] ?? '')).toEqual({
            type: 'user',
            uuid: expect.any(String),
            message: {
                role: 'user',
                content: [{ type: 'text', text: 'change direction' }],
            },
        });
        await session.cancelTurn();
        await expect(turn).resolves.toEqual({ reason: 'cancelled' });
        await session.close();
    });

    test('rejects held steering without writing it when the active turn ends', async () => {
        const observed = harness();
        observed.native.scenario = 'held_steering';
        const session = await observed.adapter.start(sessionOptions(observed));
        const turn = session.prompt('start');
        const delivery = await session.steer?.('too late');

        await expect(delivery?.delivered).rejects.toThrow(
            'did not consume steering input'
        );
        await expect(turn).resolves.toEqual({ reason: 'end_turn' });
        expect(observed.native.invocations[0]?.input).toHaveLength(1);
        await session.close();
    });

    test('accepts a written steer that Claude starts as a separate native turn', async () => {
        const observed = harness();
        observed.native.scenario = 'separate_steering';
        const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
        const session = await observed.adapter.start(sessionOptions(observed, events));
        const turn = session.prompt('start');
        const delivery = await session.steer?.('too late');

        await expect(delivery?.delivered).resolves.toBeUndefined();
        await expect(turn).resolves.toEqual({ reason: 'end_turn' });
        expect(observed.native.invocations[0]?.input).toHaveLength(2);
        expect(events).toContainEqual({
            type: 'output.text',
            data: expect.objectContaining({ text: 'separate turn' }),
        });
        await session.close();
    });

    test('interrupts a turn without ending the resumable process', async () => {
        const observed = harness();
        observed.native.scenario = 'cancellation';
        const session = await observed.adapter.start(sessionOptions(observed));
        const turn = session.prompt('wait');
        await session.cancelTurn();
        await expect(turn).resolves.toEqual({ reason: 'cancelled' });
        expect(JSON.parse(observed.native.invocations[0]?.input[1] ?? '')).toEqual(
            expect.objectContaining({
                type: 'control_request',
                request: { subtype: 'interrupt', cancel_queued: true },
            })
        );
        expect(observed.native.invocations[0]?.killed).toBeFalse();
        observed.native.scenario = 'multi_turn';
        await session.prompt('retry');
        expect(observed.native.invocations).toHaveLength(1);
        await session.close();
    });

    test('rejects steering that remains queued when a turn is cancelled', async () => {
        const observed = harness();
        observed.native.scenario = 'queued_steering';
        const session = await observed.adapter.start(sessionOptions(observed));
        const turn = session.prompt('wait');
        const delivery = await session.steer?.('queued change');

        await session.cancelTurn();
        await expect(delivery?.delivered).rejects.toThrow(
            'did not consume steering input'
        );
        await expect(turn).resolves.toEqual({ reason: 'cancelled' });
        await session.close();
    });

    test('ignores keep-alive and unmatched control responses', async () => {
        const observed = harness();
        observed.native.scenario = 'control_plane';
        const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
        const session = await observed.adapter.start(sessionOptions(observed, events));

        await session.prompt('control traffic');
        expect(events).not.toContainEqual({
            type: 'runner.event',
            data: { native_type: 'keep_alive' },
        });
        expect(events).not.toContainEqual({
            type: 'runner.event',
            data: { native_type: 'control_response' },
        });
        await session.close();
    });

    test('reports unprompted background turns without leaking control events', async () => {
        const observed = harness();
        observed.native.scenario = 'background_turn';
        const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
        const session = await observed.adapter.start(sessionOptions(observed, events));

        await expect(session.prompt('start background work')).resolves.toEqual({
            reason: 'end_turn',
        });
        await eventually(() =>
            expect(events).toContainEqual({
                type: 'output.text',
                data: expect.objectContaining({ text: 'background activity' }),
            })
        );
        expect(events.filter((event) => event.type === 'runner.event')).toEqual([]);
        await session.close();
    });

    test('denies a pending request when the session closes', async () => {
        const observed = harness();
        observed.native.scenario = 'pending_request';
        const waiting = deferred<'reject'>();
        const session = await observed.adapter.start({
            ...sessionOptions(observed),
            host: {
                ...sessionOptions(observed).host,
                requestPermission: () => waiting.promise,
            },
        });
        const turn = session.prompt('wait for permission');
        await Bun.sleep(0);
        await session.close();
        await expect(turn).rejects.toThrow('runner session is closed');
        expect(JSON.parse(observed.native.invocations[0]?.input[1] ?? '')).toEqual(
            claudeProtocolFixture('permission-deny-response.json')
        );
        waiting.resolve('reject');
    });

    test('withdraws a native-cancelled request and still completes the turn', async () => {
        const observed = harness();
        observed.native.scenario = 'cancelled_request';
        const waiting = deferred<'allow_once'>();
        const withdrawn: string[] = [];
        const options = sessionOptions(observed);
        const session = await observed.adapter.start({
            ...options,
            host: {
                ...options.host,
                requestPermission: () => waiting.promise,
                withdrawPermission: (id) => withdrawn.push(id),
            },
        });

        await expect(session.prompt('cancel request')).resolves.toEqual({
            reason: 'end_turn',
        });
        expect(withdrawn).toEqual(['permission_contract_1']);
        expect(observed.native.invocations[0]?.input).toHaveLength(1);
        waiting.resolve('allow_once');
        await session.close();
    });

    test('answers control requests emitted after a native result', async () => {
        const observed = harness();
        observed.native.scenario = 'between_turn_request';
        let requests = 0;
        const options = sessionOptions(observed);
        const session = await observed.adapter.start({
            ...options,
            host: {
                ...options.host,
                requestPermission: async () => {
                    requests += 1;
                    return 'allow_once';
                },
            },
        });

        await session.prompt('finish then request');
        await eventually(() => expect(requests).toBe(1));
        await eventually(() =>
            expect(observed.native.invocations[0]?.input).toHaveLength(2)
        );
        await session.close();
    });

    test('denies native requests without prompting in one-shot mode', async () => {
        const observed = harness();
        observed.native.scenario = 'permission_deny';
        let requests = 0;
        const options = sessionOptions(observed);
        const session = await observed.adapter.start({
            ...options,
            answerRequests: false,
            host: {
                ...options.host,
                requestPermission: async () => {
                    requests += 1;
                    return 'allow_once';
                },
            },
        });

        await session.prompt('do not prompt');
        expect(requests).toBe(0);
        expect(JSON.parse(observed.native.invocations[0]?.input[1] ?? '')).toEqual(
            claudeProtocolFixture('permission-deny-response.json')
        );
        await session.close();
    });

    test('keeps one process open across successful turns', async () => {
        const observed = harness();
        observed.native.scenario = 'multi_turn';
        const events: Array<{ type: string }> = [];
        const session = await observed.adapter.start({
            workbench: observed.workbench,
            workspaceDirectory: '/workspace',
            environment: { ANTHROPIC_API_KEY: 'credential' },
            configuration: claudeCodeConfiguration(observed.workbench),
            session: {
                id: 'wb_claude1234567890123456',
                directory: '/session',
            },
            host: {
                emit: async (event) => {
                    events.push(event);
                },
                requestPermission: async () => 'reject',
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
        });
        try {
            await session.prompt('first');
            expect(session.id).toBeTruthy();
            expect(observed.native.invocations[0]?.command).toContain('--session-id');
            await session.prompt('second');
            expect(observed.native.invocations).toHaveLength(1);
            expect(observed.native.invocations[0]?.env.CLAUDE_CONFIG_DIR).toBe(
                '/session/claude-code-config'
            );
            expect(JSON.parse(observed.native.invocations[0]?.input[0] ?? '')).toEqual({
                type: 'user',
                uuid: expect.any(String),
                message: {
                    role: 'user',
                    content: [{ type: 'text', text: 'first' }],
                },
            });
            expect(JSON.parse(observed.native.invocations[0]?.input[1] ?? '')).toEqual({
                type: 'user',
                uuid: expect.any(String),
                message: {
                    role: 'user',
                    content: [{ type: 'text', text: 'second' }],
                },
            });
            expect(
                events.filter((event) => event.type === 'turn.completed')
            ).toHaveLength(0);
        } finally {
            await session.close();
        }
        expect(observed.native.invocations[0]?.killed).toBeTrue();
    });

    test('reopens a stopped process with resume and never reuses session-id', async () => {
        const observed = harness();
        observed.native.scenario = 'restart';
        const session = await observed.adapter.start({
            workbench: observed.workbench,
            workspaceDirectory: '/workspace',
            environment: { ANTHROPIC_API_KEY: 'credential' },
            configuration: claudeCodeConfiguration(observed.workbench),
            session: { id: 'wb_claude1234567890123456', directory: '/session' },
            host: {
                emit: async () => {},
                requestPermission: async () => 'reject',
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
        });
        try {
            await session.prompt('first');
            await Bun.sleep(0);
            await session.prompt('second');
            const nativeId = session.id;
            if (!nativeId) throw new Error('native session id was not recorded');
            expect(observed.native.invocations).toHaveLength(2);
            expect(observed.native.invocations[0]?.command).toContain('--session-id');
            expect(observed.native.invocations[1]?.command).not.toContain(
                '--session-id'
            );
            expect(observed.native.invocations[1]?.command.slice(-2)).toEqual([
                '--resume',
                nativeId,
            ]);
        } finally {
            await session.close();
        }
    });

    test('strips inherited Claude and Anthropic environment except explicit auth', async () => {
        const observed = harness();
        const session = await observed.adapter.start({
            workbench: observed.workbench,
            workspaceDirectory: '/workspace',
            environment: {
                PATH: '/bin',
                CLAUDECODE: 'nested',
                CLAUDE_BEDROCK: 'leak',
                ANTHROPIC_BASE_URL: 'leak',
                ANTHROPIC_API_KEY: 'credential',
                CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
            },
            configuration: claudeCodeConfiguration(observed.workbench),
            host: {
                emit: async () => {},
                requestPermission: async () => 'reject',
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
        });
        try {
            await session.prompt('inspect');
            expect(observed.native.invocations[0]?.env).toMatchObject({
                PATH: '/bin',
                ANTHROPIC_API_KEY: 'credential',
                CLAUDE_CONFIG_DIR: expect.any(String),
                CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '0',
            });
            expect(
                observed.native.invocations[0]?.env.CLAUDE_CODE_OAUTH_TOKEN
            ).toBeUndefined();
            expect(observed.native.invocations[0]?.env.CLAUDECODE).toBeUndefined();
            expect(observed.native.invocations[0]?.env.CLAUDE_BEDROCK).toBeUndefined();
            expect(
                observed.native.invocations[0]?.env.ANTHROPIC_BASE_URL
            ).toBeUndefined();
        } finally {
            await session.close();
        }
    });

    test('keeps the child on acknowledged cancellation and kills it on adapter errors', async () => {
        const cancelled = harness();
        cancelled.native.scenario = 'cancellation';
        const cancelledSession = await cancelled.adapter.start({
            workbench: cancelled.workbench,
            workspaceDirectory: '/workspace',
            environment: {},
            configuration: claudeCodeConfiguration(cancelled.workbench),
            host: {
                emit: async () => {},
                requestPermission: async () => 'reject',
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
        });
        const turn = cancelledSession.prompt('wait');
        await cancelledSession.cancelTurn();
        await expect(turn).resolves.toEqual({ reason: 'cancelled' });
        expect(cancelled.native.invocations[0]?.killed).toBeFalse();
        cancelled.native.scenario = 'multi_turn';
        await cancelledSession.prompt('retry');
        expect(cancelled.native.invocations).toHaveLength(1);
        expect(cancelled.native.invocations[0]?.input).toHaveLength(3);
        await cancelledSession.close();

        const failed = harness();
        failed.native.scenario = 'malformed_stream';
        const failedSession = await failed.adapter.start({
            workbench: failed.workbench,
            workspaceDirectory: '/workspace',
            environment: {},
            configuration: claudeCodeConfiguration(failed.workbench),
            host: {
                emit: async () => {
                    throw new Error('host rejected event');
                },
                requestPermission: async () => 'reject',
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
        });
        await expect(failedSession.prompt('fail')).rejects.toThrow(
            'host rejected event'
        );
        expect(failed.native.invocations[0]?.killed).toBeTrue();
        await failedSession.close();
    });

    test('starts a fresh process when prompting as cancellation settles', async () => {
        const observed = harness();
        observed.native.scenario = 'cancellation';
        const session = await observed.adapter.start(sessionOptions(observed));
        const first = session.prompt('wait');

        const cancelling = session.cancelTurn();
        await first;
        observed.native.scenario = 'multi_turn';
        await session.prompt('retry');
        await cancelling;

        expect(observed.native.invocations).toHaveLength(1);
        await session.close();
    });

    test('drops native events after cancellation and ignores a stale success result', async () => {
        const cancelled = harness();
        cancelled.native.scenario = 'events_after_cancel';
        const cancelledEvents: Array<{ type: string }> = [];
        const cancelledSession = await cancelled.adapter.start(
            sessionOptions(cancelled, cancelledEvents)
        );
        const turn = cancelledSession.prompt('wait');
        await cancelledSession.cancelTurn();
        await turn;
        await Bun.sleep(0);
        expect(cancelledEvents).toEqual([]);
        await cancelledSession.close();

        const observed = harness();
        observed.native.scenario = 'stray_result';
        const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
        const session = await observed.adapter.start(sessionOptions(observed, events));
        await session.prompt('first');
        await session.prompt('second');
        expect(events).toContainEqual(
            expect.objectContaining({
                type: 'output.text',
                data: expect.objectContaining({ text: 'second' }),
            })
        );
        await session.close();
    });

    test('force kills a child that ignores termination', async () => {
        const observed = harness();
        observed.native.scenario = 'ignore_sigterm';
        const session = await observed.adapter.start(sessionOptions(observed));
        const turn = session.prompt('wait');

        await session.cancelTurn();
        await expect(turn).resolves.toEqual({ reason: 'cancelled' });

        expect(observed.native.invocations[0]?.kills).toEqual(['SIGTERM', 'SIGKILL']);
        await session.close();
    }, 12_000);

    test('rejects the active turn when stdin throws synchronously', async () => {
        const observed = harness();
        observed.native.scenario = 'synchronous_write_throw';
        const session = await observed.adapter.start(sessionOptions(observed));

        await expect(session.prompt('fail')).rejects.toThrow(
            'synchronous stdin failure'
        );
        await session.close();
    });

    test('rejects the active turn when a control response write fails', async () => {
        const observed = harness();
        observed.native.scenario = 'asynchronous_write_failure';
        const session = await observed.adapter.start(sessionOptions(observed));

        await expect(session.prompt('request permission')).rejects.toThrow(
            'asynchronous stdin failure'
        );
        expect(observed.native.invocations[0]?.killed).toBeTrue();
        await session.close();
    });

    test('fails closed on control requests and includes stderr when no result arrives', async () => {
        const controlled = harness();
        controlled.native.scenario = 'control_request';
        const controlledSession = await controlled.adapter.start({
            workbench: controlled.workbench,
            workspaceDirectory: '/workspace',
            environment: {},
            configuration: claudeCodeConfiguration(controlled.workbench),
            host: {
                emit: async () => {},
                requestPermission: async () => 'reject',
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
        });
        await controlledSession.prompt('inspect');
        expect(JSON.parse(controlled.native.invocations[0]?.input[1] ?? '')).toEqual(
            claudeProtocolFixture('unknown-control-response.json')
        );
        await controlledSession.close();

        const exited = harness();
        exited.native.scenario = 'exit_without_result';
        const exitedSession = await exited.adapter.start({
            workbench: exited.workbench,
            workspaceDirectory: '/workspace',
            environment: { ANTHROPIC_API_KEY: 'credential-value' },
            configuration: claudeCodeConfiguration(exited.workbench),
            host: {
                emit: async () => {},
                requestPermission: async () => 'reject',
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
        });
        await expect(exitedSession.prompt('fail')).rejects.toThrow(
            'Claude Code exited without a result (code 1): error: native startup failed [REDACTED]\nbundled source excerpt\ntrailing diagnostic'
        );
        await expect(exitedSession.close()).resolves.toBeUndefined();
    });

    test('resumes a recorded native id after a failed first turn', async () => {
        const observed = harness();
        observed.native.scenario = 'failures';
        const session = await observed.adapter.start({
            workbench: observed.workbench,
            workspaceDirectory: '/workspace',
            environment: {},
            configuration: claudeCodeConfiguration(observed.workbench),
            host: {
                emit: async () => {},
                requestPermission: async () => 'reject',
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
        });
        await expect(session.prompt('fail')).rejects.toThrow('session failed');
        const recorded = session.id;
        if (!recorded) throw new Error('native session id was not recorded');
        observed.native.scenario = 'multi_turn';
        await session.prompt('retry');
        expect(observed.native.invocations[1]?.command.slice(-2)).toEqual([
            '--resume',
            recorded,
        ]);
        await session.close();
    });
});

function traceProcess(trace: unknown[], costs: number[]) {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let finish: ((code: number) => void) | undefined;
    let closed = false;
    const exited = new Promise<number>((resolve) => {
        finish = resolve;
    });
    const stdout = new ReadableStream<Uint8Array>({
        start(stream) {
            controller = stream;
        },
    });
    let turn = 0;
    const close = () => {
        if (closed) return;
        closed = true;
        controller?.close();
        finish?.(0);
    };
    return {
        exited,
        stdout,
        stderr: new ReadableStream<Uint8Array>({
            start(stream) {
                stream.close();
            },
        }),
        stdin: {
            write(value: string | Uint8Array) {
                const parsed: unknown = JSON.parse(String(value));
                const message =
                    parsed !== null &&
                    typeof parsed === 'object' &&
                    !Array.isArray(parsed)
                        ? Object.fromEntries(Object.entries(parsed))
                        : {};
                const uuid =
                    typeof message.uuid === 'string' ? message.uuid : 'command-1';
                for (const event of trace) {
                    const entry =
                        event !== null &&
                        typeof event === 'object' &&
                        !Array.isArray(event)
                            ? Object.fromEntries(Object.entries(event))
                            : {};
                    const normalized =
                        entry.type === 'result'
                            ? { ...entry, total_cost_usd: costs[turn] }
                            : entry;
                    const line = JSON.stringify(normalized).replaceAll(
                        'command-1',
                        uuid
                    );
                    controller?.enqueue(new TextEncoder().encode(`${line}\n`));
                }
                turn++;
                return Promise.resolve();
            },
            close,
        },
        kill: close,
    };
}

function sessionOptions(
    observed: ReturnType<typeof harness>,
    events: Array<{ type: string; data?: Record<string, unknown> }> = []
) {
    return {
        workbench: observed.workbench,
        workspaceDirectory: '/workspace',
        environment: {},
        configuration: claudeCodeConfiguration(observed.workbench),
        host: {
            emit: async (event: { type: string; data?: Record<string, unknown> }) => {
                events.push(event);
            },
            requestPermission: async () => 'reject' as const,
            requestQuestion: async () => ({ outcome: 'rejected' as const }),
        },
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((accepted) => {
        resolve = accepted;
    });
    return { promise, resolve };
}

async function eventually(assertion: () => void): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
            assertion();
            return;
        } catch {
            await Bun.sleep(0);
        }
    }
    assertion();
}
