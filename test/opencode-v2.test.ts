import { describe, expect, test } from 'bun:test';
import {
    isOpenCodeV2,
    openCodeConnection,
} from '../src/runners/opencode/connection.js';
import { OpenCodeV2Credentials } from '../src/runners/opencode/credentials.js';
import { OpenCodeServerSession } from '../src/runners/opencode/session.js';
import { v2Message } from '../src/runners/opencode/v2.js';
import type { RunnerSessionHost } from '../src/runners/session.js';
import type { WorkbenchEventDraft } from '../src/runs/index.js';
import {
    FakeOpenCodeServer,
    fixtureConfiguration,
    fixtureWorkbench,
} from './runners/opencode/fixture.js';

class V2Server {
    readonly events: WorkbenchEventDraft[] = [];
    readonly requests: Array<{
        path: string;
        method: string;
        body: Record<string, unknown>;
    }> = [];
    readonly process = new FakeOpenCodeServer();
    private stream?: ReadableStreamDefaultController<Uint8Array>;
    onPrompt: (body: Record<string, unknown>) => void = (body) =>
        this.complete(String(body.id));
    pages: unknown[][] = [];
    async start(host: Partial<RunnerSessionHost> = {}, authentication = false) {
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
            fetch: async (input, init = {}) => {
                const url = new URL(String(input));
                const path = url.pathname;
                const method = init.method ?? 'GET';
                const body = init.body ? JSON.parse(String(init.body)) : {};
                this.requests.push({ path, method, body });
                expect(new Headers(init.headers).get('Authorization')).toBe(
                    `Basic ${btoa('opencode:test-password')}`
                );
                if (path === '/api/info') return Response.json({ version: '2.0.29' });
                if (path === '/api/integration')
                    return Response.json({
                        data: [
                            {
                                id: 'openai',
                                methods: [
                                    { type: 'key' },
                                    {
                                        id: 'chatgpt-headless',
                                        type: 'oauth',
                                        label: 'Codex device code (legacy)',
                                    },
                                ],
                            },
                        ],
                    });
                if (path.endsWith('/connect/oauth'))
                    return Response.json({
                        data: {
                            attemptID: 'attempt_1',
                            url: 'https://auth.example/device',
                            mode: 'auto',
                        },
                    });
                if (path.endsWith('/connect/oauth/attempt_1'))
                    return Response.json({ data: { status: 'complete' } });
                if (path === '/api/session')
                    return Response.json({ data: { id: 'ses_v2' } });
                if (path === '/api/session/ses_v2')
                    return Response.json({ data: { id: 'ses_v2' } });
                if (path === '/api/event')
                    return new Response(
                        new ReadableStream({
                            start: (controller) => {
                                this.stream = controller;
                                init.signal?.addEventListener(
                                    'abort',
                                    () => controller.close(),
                                    { once: true }
                                );
                            },
                        })
                    );
                if (path.endsWith('/prompt')) {
                    queueMicrotask(() => this.onPrompt(body));
                    return Response.json({ data: { id: body.id } });
                }
                if (path.endsWith('/interrupt')) {
                    this.emit('session.execution.interrupted', { reason: 'user' });
                    return Response.json({ data: {} });
                }
                if (path.endsWith('/message')) {
                    const index = Number(url.searchParams.get('cursor') ?? '0');
                    return Response.json({
                        data: this.pages[index] ?? [],
                        cursor: {
                            next:
                                index + 1 < this.pages.length
                                    ? String(index + 1)
                                    : null,
                        },
                    });
                }
                if (path.endsWith('/reply') || method === 'DELETE')
                    return new Response(null, { status: 204 });
                return new Response(null, { status: 404 });
            },
            password: () => 'test-password',
            launch: () => this.process.launch(),
            startupTimeoutMs: 1000,
            authenticationTimeoutMs: 1000,
            cleanup: async () => {},
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
    emit(type: string, data: Record<string, unknown>) {
        this.stream?.enqueue(
            new TextEncoder().encode(
                `event: ${type}\ndata: ${JSON.stringify({ type, data: { sessionID: 'ses_v2', ...data } })}\n\n`
            )
        );
    }
    complete(inputID: string, text = 'Hello V2') {
        this.emit('session.inbox.delivered', { inboxID: inputID });
        this.emit('session.step.started', { assistantMessageID: `answer_${inputID}` });
        this.emit('session.text.started', {
            assistantMessageID: `answer_${inputID}`,
            ordinal: 0,
        });
        this.emit('session.text.delta', {
            assistantMessageID: `answer_${inputID}`,
            ordinal: 0,
            delta: text,
        });
        this.emit('session.text.ended', {
            assistantMessageID: `answer_${inputID}`,
            ordinal: 0,
            text,
        });
        this.emit('session.step.ended', {
            assistantMessageID: `answer_${inputID}`,
            finish: 'stop',
            cost: 0.01,
            tokens: { input: 2, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
        });
        this.emit('session.execution.succeeded', {});
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
                        sessionID: 'ses_v2',
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
            server.pages = [
                [{ id: 'input_1', type: 'user', text: 'hello' }],
                [
                    {
                        id: 'answer_1',
                        type: 'assistant',
                        content: [{ type: 'text', text: 'Recovered' }],
                        finish: 'stop',
                        time: { completed: 1 },
                    },
                    { id: 'idle_1', type: 'idle', outcome: 'succeeded' },
                ],
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
                    server.complete(String(body.id), 'Steered');
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
