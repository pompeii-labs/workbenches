import { afterEach, describe, expect, jest, test } from 'bun:test';
import {
    isOpenCodeV2,
    openCodeConnection,
} from '../src/runners/opencode/connection.js';
import { OpenCodeV2Credentials } from '../src/runners/opencode/credentials.js';
import { OpenCodeServerSession } from '../src/runners/opencode/session.js';
import { v2Message } from '../src/runners/opencode/v2.js';
import type { RunnerSessionHost } from '../src/runners/session.js';
import type { WorkbenchEventDraft } from '../src/runs/index.js';
import { fixtureConfiguration, fixtureWorkbench } from './runners/opencode/fixture.js';
import { FakeOpenCodeV2Server } from './runners/opencode/v2fixture.js';

const usage = {
    cost: 0.01,
    tokens: { input: 2, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
};

/** An OpenCode 2 fake that answers each prompt with `Hello V2`, and what its session emitted. */
class V2Server extends FakeOpenCodeV2Server {
    readonly events: WorkbenchEventDraft[] = [];
    override onPrompt: (body: Record<string, unknown>) => void = (body) =>
        this.completeTurn('Hello V2', String(body.id), usage);

    async start(
        host: Partial<RunnerSessionHost> = {},
        authentication = false,
        nativeSessionId?: string
    ) {
        const workbench = fixtureWorkbench('/package', '/workspace');
        const session = new OpenCodeServerSession({
            workbench,
            workspaceDirectory: '/workspace',
            environment: {},
            configuration: fixtureConfiguration(workbench),
            host: {
                emit: async (event) => {
                    this.events.push(event);
                },
                requestPermission: async () => 'reject',
                requestQuestion: async () => ({ outcome: 'rejected' }),
                ...host,
            },
            fetch: this.fetcher,
            password: () => 'test-password',
            launch: () => this.launch(),
            startupTimeoutMs: 1000,
            authenticationTimeoutMs: 1000,
            cleanup: async () => {},
            ...(nativeSessionId
                ? {
                      session: {
                          id: 'wb_fixture',
                          directory: '/sessions/wb_fixture',
                          nativeSessionId,
                      },
                  }
                : {}),
            ...(authentication
                ? {
                      authentication: {
                          provider: 'openai',
                          nativeProvider: 'openai',
                          authenticationMethod: 'oauth',
                          nativeMethod: 'ChatGPT Pro/Plus (headless)',
                      },
                  }
                : {}),
        });
        await session.start();
        return session;
    }
    count(suffix: string) {
        return this.requests.filter((request) => request.path.endsWith(suffix)).length;
    }

    texts() {
        return this.events
            .filter((event) => event.type === 'output.text')
            .map((event) => event.data.text);
    }
}

describe('OpenCode V2 protocol', () => {
    test('uses V2 session creation, streaming, usage, and multiple turns', async () => {
        const server = new V2Server();
        const session = await server.start();
        try {
            expect(await session.prompt('first')).toEqual({ reason: 'stop' });
            expect(await session.prompt('second')).toEqual({ reason: 'stop' });
            expect(
                server.events
                    .filter((event) => event.type === 'output.text')
                    .map((event) => event.data.text)
            ).toEqual(['Hello V2', 'Hello V2']);
            expect(
                server.events.filter((event) => event.type === 'usage.updated')
            ).toHaveLength(2);
            expect(
                server.requests.find((request) => request.path === '/api/session')?.body
                    .location
            ).toEqual({ directory: '/workspace' });
            expect(
                server.requests
                    .filter((request) => request.path.endsWith('/prompt'))
                    .map((request) => request.body.text)
            ).toEqual(['first', 'second']);
        } finally {
            await session.close();
        }
    });

    test('uses method IDs and polls the V2 OAuth attempt before creating a session', async () => {
        const server = new V2Server();
        const session = await server.start({}, true);
        try {
            expect(
                server.requests.find((request) =>
                    request.path.endsWith('/connect/oauth')
                )?.body
            ).toEqual({ methodID: 'chatgpt-headless' });
            expect(server.events.map((event) => event.type)).toEqual([
                'authentication.requested',
                'authentication.completed',
            ]);
        } finally {
            await session.close();
        }
    });

    test('answers V2 session-scoped permissions and form fields without losing option values', async () => {
        const server = new V2Server();
        let permission!: () => void;
        let question!: () => void;
        const permitted = new Promise<void>((resolve) => {
            permission = resolve;
        });
        const questioned = new Promise<void>((resolve) => {
            question = resolve;
        });
        const session = await server.start({
            requestPermission: async (request) => {
                expect(request.action).toBe('shell');
                permission();
                return 'allow_once';
            },
            requestQuestion: async (request) => {
                expect(request.questions[0]?.question).toBe('Target');
                question();
                return { outcome: 'answered', answers: [['Production']] };
            },
        });
        try {
            server.onPrompt = () => {
                server.emit('permission.asked', {
                    id: 'permission_1',
                    action: 'shell',
                    resources: ['git status'],
                    save: [],
                });
                server.emit('form.created', {
                    form: {
                        id: 'form_1',
                        sessionID: 'ses_native_1',
                        title: 'Choose',
                        fields: [
                            {
                                key: 'target',
                                type: 'string',
                                title: 'Target',
                                custom: false,
                                options: [{ value: 'prod', label: 'Production' }],
                            },
                        ],
                    },
                });
            };
            const turn = session.prompt('ask');
            await permitted;
            await questioned;
            await Bun.sleep(5);
            expect(
                server.requests.find((request) => request.path.includes('/permission/'))
                    ?.body
            ).toEqual({ decision: 'once' });
            expect(
                server.requests.find((request) => request.path.includes('/form/'))?.body
            ).toEqual({ answer: { target: 'prod' } });
            await session.cancelTurn();
            expect(await turn).toEqual({ reason: 'cancelled' });
        } finally {
            await session.close();
        }
    });

    test('recovers paginated projected messages and their durable idle outcome', async () => {
        const server = new V2Server();
        const session = await server.start();
        try {
            server.pageSize = 1;
            server.transcript = [
                { id: 'input_1', type: 'user', text: 'hello' },
                {
                    id: 'answer_1',
                    type: 'assistant',
                    content: [{ type: 'text', text: 'Recovered' }],
                    finish: 'stop',
                    time: { completed: 1 },
                },
                { id: 'idle_1', type: 'idle', outcome: 'succeeded' },
            ];
            expect(await session.resumeTurn()).toEqual({ reason: 'stop' });
            expect(
                server.events
                    .filter((event) => event.type === 'output.text')
                    .map((event) => event.data.text)
            ).toEqual(['Recovered']);
        } finally {
            await session.close();
        }
    });

    test('waits for configured MCP servers to start before the first prompt', async () => {
        const server = new V2Server();
        server.config = [
            {
                type: 'document',
                info: {
                    mcp: {
                        servers: {
                            fixture: {
                                type: 'local',
                                command: ['fixture-mcp'],
                                timeout: { startup: 5000 },
                            },
                        },
                    },
                },
            },
        ];
        const connected = { name: 'fixture', status: { status: 'connected' } };
        server.mcp = [
            [],
            [{ ...connected, status: { status: 'pending' } }],
            [connected],
        ];
        const session = await server.start();
        try {
            expect(await session.prompt('use the tools')).toEqual({ reason: 'stop' });
            const paths = server.requests.map((request) => request.path);
            expect(paths.filter((path) => path === '/api/mcp')).toHaveLength(3);
            expect(paths.lastIndexOf('/api/mcp')).toBeLessThan(
                paths.findIndex((path) => path.endsWith('/prompt'))
            );
        } finally {
            await session.close();
        }
    });

    test('asks again for a permission still pending when a resumed turn reconnects', async () => {
        const server = new V2Server();
        server.pendingPermissions = [
            {
                id: 'permission_1',
                sessionID: 'ses_native_1',
                action: 'shell',
                resources: ['git status'],
                save: [],
            },
        ];
        server.transcript = [{ id: 'input_1', type: 'user', text: 'hello' }];
        const asked: string[] = [];
        const session = await server.start(
            {
                requestPermission: async (request) => {
                    asked.push(request.action);
                    queueMicrotask(() =>
                        server.completeTurn('Resumed', 'input_1', usage)
                    );
                    return 'allow_once';
                },
            },
            false,
            'ses_native_1'
        );
        try {
            expect(await session.resumeTurn()).toEqual({ reason: 'stop' });
            expect(asked).toEqual(['shell']);
            expect(
                server.requests.find(
                    (request) =>
                        request.path ===
                        '/api/session/ses_native_1/permission/permission_1/reply'
                )?.body
            ).toEqual({ decision: 'once' });
        } finally {
            await session.close();
        }
    });

    test('recognizes both version and auth listing formats', () => {
        expect(isOpenCodeV2('opencode v2.0.29')).toBe(true);
        expect(isOpenCodeV2('1.18.30')).toBe(false);
        const candidates = [
            { provider: 'openai', nativeProvider: 'openai', nativeModel: 'gpt' },
        ];
        expect(
            openCodeConnection.probe.authenticated(
                'OpenAI      OAuth                       stored',
                candidates
            )[0]?.authenticationMethod
        ).toBe('oauth');
        expect(
            openCodeConnection.probe.authenticated('● OpenAI oauth', candidates)[0]
                ?.authenticationMethod
        ).toBe('oauth');
        // OpenCode 2.2 lists JSON; its text listing names an account, not a method.
        const json = JSON.stringify([
            {
                id: 'openai',
                name: 'OpenAI',
                connections: [
                    {
                        type: 'credential',
                        id: 'cred_1',
                        label: 'OpenAI',
                        method: 'oauth',
                    },
                ],
            },
            { id: 'anthropic', name: 'Anthropic', connections: [] },
        ]);
        expect(
            openCodeConnection.probe.authenticated(json, candidates)[0]
                ?.authenticationMethod
        ).toBe('oauth');
        expect(
            openCodeConnection.probe.authenticated(
                JSON.stringify([
                    {
                        id: 'openai',
                        connections: [{ type: 'credential', method: 'api' }],
                    },
                ]),
                candidates
            )[0]?.authenticationMethod
        ).toBe('api');
        expect(openCodeConnection.probe.authenticated('[]', candidates)).toEqual([]);
        expect(
            openCodeConnection.probe.authenticated(
                'OpenAI  OpenAI                      stored',
                candidates
            )
        ).toEqual([]);
        expect(
            openCodeConnection.hostSignIn?.arguments(
                'openai',
                'ChatGPT Pro/Plus (browser)',
                'opencode v2.0.29'
            )
        ).toEqual([
            'auth',
            'login',
            'openai',
            '--standalone',
            '--method',
            'chatgpt-token-sharing',
        ]);
        expect(
            v2Message({
                id: 'answer',
                type: 'assistant',
                content: [{ type: 'text', text: 'text' }],
            }).parts[0]?.id
        ).toBe('answer:0');
    });

    test('streams tools, keeps reasoning private, and reports provider failures', async () => {
        const server = new V2Server();
        const session = await server.start();
        try {
            server.onPrompt = (body) => {
                server.emit('session.inbox.delivered', { inboxID: body.id });
                server.emit('session.step.started', {
                    assistantMessageID: 'answer_tools',
                });
                server.emit('session.reasoning.started', {
                    assistantMessageID: 'answer_tools',
                    ordinal: 0,
                });
                server.emit('session.reasoning.ended', {
                    assistantMessageID: 'answer_tools',
                    ordinal: 0,
                    text: 'private reasoning',
                });
                server.emit('session.tool.input.started', {
                    assistantMessageID: 'answer_tools',
                    id: 'call_1',
                    name: 'read',
                });
                server.emit('session.tool.called', {
                    assistantMessageID: 'answer_tools',
                    id: 'call_1',
                    input: { path: 'README.md' },
                });
                server.emit('session.tool.success', {
                    assistantMessageID: 'answer_tools',
                    id: 'call_1',
                    content: [{ type: 'text', text: 'tool result' }],
                });
                server.emit('session.execution.failed', {
                    error: { type: 'ProviderError', message: 'Provider unavailable' },
                });
            };
            await expect(session.prompt('tools')).rejects.toThrow(
                'Provider unavailable'
            );
            expect(
                server.events.filter((event) => event.type === 'tool.started')
            ).toHaveLength(1);
            expect(
                server.events.filter((event) => event.type === 'tool.completed')
            ).toHaveLength(1);
            expect(
                server.events.filter((event) => event.type === 'output.text')
            ).toHaveLength(0);
            expect(JSON.stringify(server.events)).not.toContain('private reasoning');
        } finally {
            await session.close();
        }
    });

    test('imports Workbench-owned credentials and saves refreshed V2 OAuth values', async () => {
        let portable = JSON.stringify({
            openai: {
                type: 'oauth',
                methodID: 'chatgpt-headless',
                refresh: 'fixture-old',
                access: 'fixture-access',
                expires: 1,
            },
            other: { type: 'api', key: 'fixture-other' },
        });
        const writes: unknown[] = [];
        const credentials = new OpenCodeV2Credentials(
            {
                request: async (_path, init) => {
                    writes.push(JSON.parse(String(init.body)));
                    return new Response(null, { status: 204 });
                },
                requestJson: async () => [
                    {
                        id: 'cred_1',
                        integrationID: 'openai',
                        active: true,
                        value: {
                            type: 'oauth',
                            methodID: 'chatgpt-headless',
                            refresh: 'fixture-refreshed',
                            access: 'fixture-access',
                            expires: 2,
                        },
                    },
                ],
            },
            {
                read: async () => portable,
                write: async (_path, contents) => {
                    portable = contents;
                },
            }
        );
        await credentials.load();
        expect(writes).toEqual([
            {
                value: {
                    type: 'oauth',
                    methodID: 'chatgpt-headless',
                    refresh: 'fixture-old',
                    access: 'fixture-access',
                    expires: 1,
                    metadata: {},
                },
            },
            { integrationID: 'other', value: { type: 'key', key: 'fixture-other' } },
        ]);
        await credentials.save();
        expect(JSON.parse(portable).openai.refresh).toBe('fixture-refreshed');
        expect(JSON.parse(portable).other).toEqual({
            type: 'api',
            key: 'fixture-other',
        });
    });

    test('translates image input and delivers steering through the V2 inbox', async () => {
        const server = new V2Server();
        const session = await server.start();
        try {
            let admitted!: () => void;
            const prompted = new Promise<void>((resolve) => {
                admitted = resolve;
            });
            server.onPrompt = (body) => {
                if (body.delivery === 'steer')
                    server.completeTurn('Steered', String(body.id), usage);
                else admitted();
            };
            const turn = session.prompt({
                text: 'See image',
                images: [
                    { data: 'aW1hZ2U=', mimeType: 'image/png', name: 'image.png' },
                ],
            });
            await prompted;
            const steering = await session.steer('Focus on the image');
            await steering.delivered;
            expect(await turn).toEqual({ reason: 'stop' });
            const prompts = server.requests.filter((request) =>
                request.path.endsWith('/prompt')
            );
            expect(prompts[0]?.body.files).toEqual([
                { uri: 'data:image/png;base64,aW1hZ2U=', name: 'image.png' },
            ]);
            expect(prompts[1]?.body.delivery).toBe('steer');
        } finally {
            await session.close();
        }
    });
});

/** What a V2 server holds once the turn begun by `inputID` has finished. */
function finishedTranscript(inputID: string, text: string) {
    return [
        { id: inputID, type: 'user', text: 'work' },
        {
            id: `answer_${inputID}`,
            type: 'assistant',
            content: [{ type: 'text', text }],
            finish: 'stop',
            cost: 0.01,
            tokens: {
                input: 2,
                output: 3,
                reasoning: 0,
                cache: { read: 0, write: 0 },
            },
            time: { completed: 1 },
        },
        { id: `idle_${inputID}`, type: 'idle', outcome: 'succeeded' },
    ];
}

/** Lets pending promise callbacks run while fake timers hold every timer. */
async function drain(rounds = 200): Promise<void> {
    for (let round = 0; round < rounds; round += 1) await Promise.resolve();
}

describe('OpenCode V2 quiet event stream', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    test('a stream that stays open but goes quiet mid-turn is caught up from the transcript', async () => {
        jest.useFakeTimers();
        const server = new V2Server();
        const session = await server.start();
        try {
            let input = '';
            server.onPrompt = (body) => {
                input = String(body.id);
                server.emit('session.inbox.delivered', { inboxID: input });
                server.emit('session.step.started', {
                    assistantMessageID: `answer_${input}`,
                });
                server.emit('session.text.started', {
                    assistantMessageID: `answer_${input}`,
                    ordinal: 0,
                });
                server.emit('session.text.delta', {
                    assistantMessageID: `answer_${input}`,
                    ordinal: 0,
                    delta: 'Hello',
                });
                // The stream stays open, and nothing more arrives on it.
            };
            const turn = session.prompt('work');
            await drain();
            expect(server.texts()).toEqual(['Hello']);
            server.transcript = finishedTranscript(input, 'Hello, world');

            jest.advanceTimersByTime(50_000);
            await drain();
            expect(server.count('/event')).toBe(1);
            jest.advanceTimersByTime(20_000);
            expect(await turn).toEqual({ reason: 'stop' });

            expect(server.count('/event')).toBe(2);
            expect(server.texts()).toEqual(['Hello', ', world']);
            expect(
                server.events.filter((event) => event.type === 'usage.updated')
            ).toHaveLength(1);
        } finally {
            await session.close();
        }
    });

    test('heartbeat comments keep a long turn on its stream', async () => {
        jest.useFakeTimers();
        const server = new V2Server();
        const session = await server.start();
        try {
            let input = '';
            server.onPrompt = (body) => {
                input = String(body.id);
                server.emit('session.inbox.delivered', { inboxID: input });
            };
            const turn = session.prompt('work');
            await drain();
            for (let beat = 0; beat < 12; beat += 1) {
                jest.advanceTimersByTime(15_000);
                server.heartbeat();
                await drain();
            }
            expect(server.count('/event')).toBe(1);
            expect(server.count('/message')).toBe(0);
            server.completeTurn('Hello V2', input);
            expect(await turn).toEqual({ reason: 'stop' });
        } finally {
            await session.close();
        }
    });

    test('a quiet stream with no turn in flight starts no catch-up', async () => {
        jest.useFakeTimers();
        const server = new V2Server();
        const session = await server.start();
        try {
            jest.advanceTimersByTime(10 * 60_000);
            await drain();
            expect(server.count('/event')).toBe(1);
            expect(server.count('/message')).toBe(0);
            expect(server.events).toEqual([]);
        } finally {
            await session.close();
        }
    });

    test('a turn that completes with text that never streamed ends with its final message', async () => {
        const server = new V2Server();
        const session = await server.start();
        try {
            server.onPrompt = (body) => {
                const input = String(body.id);
                server.transcript = finishedTranscript(input, 'The final report');
                server.emit('session.inbox.delivered', { inboxID: input });
                server.emit('session.step.started', {
                    assistantMessageID: `answer_${input}`,
                });
                server.emit('session.step.ended', {
                    assistantMessageID: `answer_${input}`,
                    finish: 'stop',
                    cost: 0.01,
                    tokens: {
                        input: 2,
                        output: 3,
                        reasoning: 0,
                        cache: { read: 0, write: 0 },
                    },
                });
                server.emit('session.execution.succeeded', {});
            };
            expect(await session.prompt('work')).toEqual({ reason: 'stop' });
            expect(server.texts()).toEqual(['The final report']);
            expect(
                server.events.filter((event) => event.type === 'usage.updated')
            ).toHaveLength(1);
        } finally {
            await session.close();
        }
    });

    test('a streamed turn is reconciled at completion without emitting anything twice', async () => {
        const server = new V2Server();
        // One page, so one read of the transcript is one request.
        server.pageSize = 3;
        const session = await server.start();
        try {
            server.onPrompt = (body) => {
                server.transcript = finishedTranscript(String(body.id), 'Hello V2');
                server.completeTurn('Hello V2', String(body.id));
            };
            expect(await session.prompt('work')).toEqual({ reason: 'stop' });
            expect(server.texts()).toEqual(['Hello V2']);
            expect(
                server.events.filter((event) => event.type === 'usage.updated')
            ).toHaveLength(1);
            expect(server.count('/message')).toBe(1);
        } finally {
            await session.close();
        }
    });

    test('a recovered failed turn reports the recorded error', async () => {
        const failure = { type: 'ProviderError', message: 'Provider overloaded' };
        const cases = [
            // The failed idle record carries the error.
            [
                { id: 'answer_1', type: 'assistant', content: [] },
                { id: 'idle_1', type: 'idle', outcome: 'failed', error: failure },
            ],
            // Only the turn's last answer does.
            [
                { id: 'answer_1', type: 'assistant', content: [], error: failure },
                { id: 'idle_1', type: 'idle', outcome: 'failed' },
            ],
        ];
        for (const records of cases) {
            const server = new V2Server();
            const session = await server.start();
            try {
                server.transcript = [
                    { id: 'input_1', type: 'user', text: 'work' },
                    ...records,
                ];
                await expect(session.resumeTurn()).rejects.toThrow(
                    'OpenCode session failed: Provider overloaded'
                );
            } finally {
                await session.close();
            }
        }
    });
});
