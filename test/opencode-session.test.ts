import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRouter } from '../src/models/index.js';
import { OpenCodeSessionAdapter } from '../src/runners/opencode/session.js';
import type {
    RunnerPermissionRequest,
    RunnerQuestionRequest,
} from '../src/runners/session.js';
import type { WorkbenchEventDraft } from '../src/runs/index.js';
import type { ResolvedWorkbench } from '../src/types.js';
import {
    RUNNER_CONFORMANCE_UNSAFE_VALUES,
    type RunnerConformanceScenario,
    runnerAdapterContract,
} from './runner-adapter-contract.js';

runnerAdapterContract({
    name: 'OpenCode',
    createHarness: () => {
        const server = new FakeOpenCodeServer();
        return {
            adapter: server.adapter(),
            workbench: workbench(),
            arrange: (scenario) => server.arrange(scenario),
        };
    },
});

describe('OpenCode interactive server adapter', () => {
    test('stages a packaged config directory without treating it as a config file', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'opencode-config-test-'));
        const config = join(directory, 'runner');
        await mkdir(config);
        const fixture = workbench();
        fixture.manifest = {
            ...fixture.manifest,
            spec: 0,
            model: { id: 'openai/gpt-5.6-terra' },
            runner_config: './runner',
        };
        fixture.runnerConfigPath = config;
        const server = new FakeOpenCodeServer();
        try {
            const session = await server.adapter().start({
                workbench: fixture,
                workspaceDirectory: '/workspace',
                environment: {},
                configuration: new ModelRouter().resolve({
                    workbench: fixture,
                }),
                host: {
                    emit: async () => {},
                    requestPermission: async () => 'reject',
                    requestQuestion: async () => ({ outcome: 'rejected' }),
                },
            });
            expect(server.spawnEnvironment.OPENCODE_CONFIG).toBeUndefined();
            expect(server.spawnEnvironment.OPENCODE_CONFIG_DIR).toContain(
                'workbench-opencode-'
            );
            await session.close();
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test('translates structured image input to native file parts', async () => {
        const server = new FakeOpenCodeServer();
        const events: WorkbenchEventDraft[] = [];
        const session = await server.adapter().start({
            workbench: workbench(),
            workspaceDirectory: '/workspace',
            environment: {},
            configuration: configuration(),
            host: {
                emit: async (event) => void events.push(event),
                requestPermission: async () => 'reject',
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
        });
        server.onPrompt = () => server.completeTurn('described');

        await session.prompt({
            text: 'describe this',
            images: [
                {
                    data: 'aW1hZ2UtYnl0ZXM=',
                    mimeType: 'image/png',
                    name: 'screen.png',
                },
            ],
        });
        await session.close();

        expect(server.promptBodies[0]?.parts).toEqual([
            { type: 'text', text: 'describe this' },
            {
                type: 'file',
                mime: 'image/png',
                url: 'data:image/png;base64,aW1hZ2UtYnl0ZXM=',
                filename: 'screen.png',
            },
        ]);
        expect(JSON.stringify(events)).not.toContain('aW1hZ2UtYnl0ZXM=');
    });

    test('keeps context in one native server session across streamed turns', async () => {
        const server = new FakeOpenCodeServer();
        const events: WorkbenchEventDraft[] = [];
        const adapter = server.adapter();
        const session = await adapter.start({
            workbench: workbench(),
            workspaceDirectory: '/workspace',
            environment: {},
            configuration: configuration(),
            host: {
                emit: async (event) => void events.push(event),
                requestPermission: async () => 'reject',
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
        });

        server.onPrompt = (body) => {
            const text = firstPartText(body);
            server.emit('message.updated', {
                info: { id: 'user_message', role: 'user' },
            });
            server.emit('message.part.delta', {
                messageID: 'user_message',
                partID: 'user_part',
                field: 'text',
                delta: 'MUST_NOT_RENDER',
            });
            server.beginAssistant();
            server.emit('message.part.updated', {
                part: {
                    id: 'reasoning_part',
                    messageID: server.currentAssistantMessageId(),
                    type: 'reasoning',
                    text: '',
                },
            });
            server.emit('message.part.delta', {
                messageID: server.currentAssistantMessageId(),
                partID: 'reasoning_part',
                field: 'text',
                delta: 'MUST_NOT_RENDER_REASONING',
            });
            server.completeTurn(text === 'first prompt' ? 'first' : 'second');
        };
        await expect(session.prompt('first prompt')).resolves.toEqual({
            reason: 'stop',
        });
        await session.prompt('second prompt');
        expect(session.id).toBe('ses_native_1');
        await session.close();

        expect(server.promptBodies.map(firstPartText)).toEqual([
            'first prompt',
            'second prompt',
        ]);
        expect(server.createdSessions).toBe(1);
        const output = events.filter((event) => event.type === 'output.text');
        expect(output.map((event) => event.data.text)).toEqual(['first', 'second']);
        expect(output[0]?.data.id).toMatch(/^output_/);
        expect(output[1]?.data.id).toMatch(/^output_/);
        expect(output[0]?.data.id).not.toBe(output[1]?.data.id);
        expect(JSON.stringify(events)).not.toContain('MUST_NOT_RENDER');
        expect(JSON.stringify(events)).not.toContain('MUST_NOT_RENDER_REASONING');
    });

    test('delivers steering to the active turn through the current session API', async () => {
        const server = new FakeOpenCodeServer();
        const session = await server.adapter().start({
            workbench: workbench(),
            workspaceDirectory: '/workspace',
            environment: {},
            configuration: configuration(),
            host: {
                emit: async () => {},
                requestPermission: async () => 'reject',
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
        });
        server.onPrompt = () =>
            server.emit('session.status', { status: { type: 'busy' } });

        const turn = session.prompt('start here');
        await server.prompted;
        await session.steer?.({
            text: 'change direction',
            images: [
                {
                    data: 'aW1hZ2UtYnl0ZXM=',
                    mimeType: 'image/png',
                    name: 'direction.png',
                },
            ],
        });
        await session.cancelTurn();
        await expect(turn).resolves.toEqual({ reason: 'cancelled' });
        await session.close();

        expect(server.promptBodies[1]).toEqual({
            messageID: expect.stringMatching(/^msg_[a-f0-9]{32}$/),
            model: {
                providerID: 'openai',
                modelID: 'gpt-5.6-terra',
            },
            parts: [
                { type: 'text', text: 'change direction' },
                {
                    type: 'file',
                    mime: 'image/png',
                    url: 'data:image/png;base64,aW1hZ2UtYnl0ZXM=',
                    filename: 'direction.png',
                },
            ],
        });
    });

    test('keeps responses to original and steered input as separate output messages', async () => {
        const server = new FakeOpenCodeServer();
        const events: WorkbenchEventDraft[] = [];
        const session = await server.adapter().start({
            workbench: workbench(),
            workspaceDirectory: '/workspace',
            environment: {},
            configuration: configuration(),
            host: {
                emit: async (event) => void events.push(event),
                requestPermission: async () => 'reject',
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
        });
        server.onPrompt = () =>
            server.emit('session.status', { status: { type: 'busy' } });

        const turn = session.prompt('first input');
        await server.prompted;
        const delivery = await session.steer?.('steered input');
        if (!delivery) throw new Error('Expected tracked steering delivery');
        const originalInput = String(server.promptBodies[0]?.messageID);
        const steeredInput = String(server.promptBodies[1]?.messageID);

        server.emitAssistantText('assistant_original', originalInput, 'First reply.');
        await Bun.sleep(0);
        expect(await settled(delivery.delivered)).toBeFalse();
        server.emitAssistantText('assistant_steered', steeredInput, 'Steered reply.');
        await expect(delivery.delivered).resolves.toBeUndefined();
        server.emit('session.status', { status: { type: 'idle' } });

        await expect(turn).resolves.toEqual({ reason: 'completed' });
        await session.close();

        const output = events.filter((event) => event.type === 'output.text');
        expect(output.map((event) => event.data.text)).toEqual([
            'First reply.',
            'Steered reply.',
        ]);
        expect(output[0]?.data.id).not.toBe(output[1]?.data.id);
    });

    test('pauses for a host permission decision and replies before continuing', async () => {
        const server = new FakeOpenCodeServer();
        const requests: RunnerPermissionRequest[] = [];
        const events: WorkbenchEventDraft[] = [];
        const session = await server.adapter().start({
            workbench: workbench(),
            workspaceDirectory: '/workspace',
            environment: {},
            configuration: configuration(),
            host: {
                emit: async (event) => void events.push(event),
                requestPermission: async (request) => {
                    requests.push(request);
                    return 'allow_once';
                },
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
        });
        server.onPrompt = () => {
            server.emit('session.status', { status: { type: 'busy' } });
            server.beginAssistant();
            server.emit('message.part.updated', {
                part: toolPart('running'),
            });
            server.emit('permission.asked', {
                id: 'per_1',
                permission: 'external_directory',
                patterns: ['/outside/*'],
                always: ['/outside/*'],
            });
        };
        server.onPermissionReply = () => {
            server.emit('message.part.updated', {
                part: toolPart('completed'),
            });
            server.completeTurn('done');
        };

        await session.prompt('inspect outside');
        await session.close();

        expect(requests).toEqual([
            {
                id: 'per_1',
                action: 'external_directory',
                resources: ['/outside/*'],
                message: 'Allow external directory for /outside/*?',
                allowAlways: true,
            },
        ]);
        expect(server.permissionReplies).toEqual([{ reply: 'once' }]);
        expect(events).toContainEqual({
            type: 'tool.completed',
            data: {
                id: 'call_1',
                name: 'read',
                target: '/outside/file.ts',
                status: 'completed',
            },
        });
    });

    test('coalesces concurrent requests covered by an always decision', async () => {
        const server = new FakeOpenCodeServer();
        let prompts = 0;
        const session = await server.adapter().start({
            workbench: workbench(),
            workspaceDirectory: '/workspace',
            environment: {},
            configuration: configuration(),
            host: {
                emit: async () => {},
                requestPermission: async () => {
                    prompts += 1;
                    return 'allow_always';
                },
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
        });
        server.onPrompt = () => {
            server.emit('session.status', { status: { type: 'busy' } });
            for (const id of ['per_1', 'per_2', 'per_3']) {
                server.emit('permission.asked', {
                    id,
                    permission: 'external_directory',
                    patterns: ['/outside/*'],
                    always: ['/outside/*'],
                });
            }
        };
        server.onPermissionReply = () => server.completeTurn('done');

        await session.prompt('inspect in parallel');
        await session.close();

        expect(prompts).toBe(1);
        expect(server.permissionReplies).toEqual([{ reply: 'always' }]);
    });

    test('normalizes native questions and returns answers to OpenCode', async () => {
        const server = new FakeOpenCodeServer();
        const requests: RunnerQuestionRequest[] = [];
        const session = await server.adapter().start({
            workbench: workbench(),
            workspaceDirectory: '/workspace',
            environment: {},
            configuration: configuration(),
            host: {
                emit: async () => {},
                requestPermission: async () => 'reject',
                requestQuestion: async (request) => {
                    requests.push(request);
                    return {
                        outcome: 'answered',
                        answers: [['Production'], ['Email', 'Push']],
                    };
                },
            },
        });
        server.onPrompt = () => {
            server.emit('session.status', { status: { type: 'busy' } });
            server.emit('question.asked', {
                id: 'que_1',
                questions: [
                    {
                        header: 'Environment',
                        question: 'Where should this deploy?',
                        options: [
                            {
                                label: 'Production',
                                description: 'Deploy for customers',
                            },
                            { label: 'Staging', description: 'Test it first' },
                        ],
                        custom: false,
                    },
                    {
                        header: 'Channels',
                        question: 'Which channels should be enabled?',
                        options: [
                            { label: 'Email', description: 'Email delivery' },
                            { label: 'Push', description: 'Push delivery' },
                        ],
                        multiple: true,
                    },
                ],
            });
        };
        server.onQuestionResponse = () => server.completeTurn('configured');

        await session.prompt('configure deployment');
        await session.close();

        expect(requests).toEqual([
            {
                id: 'que_1',
                questions: [
                    {
                        header: 'Environment',
                        question: 'Where should this deploy?',
                        options: [
                            {
                                label: 'Production',
                                description: 'Deploy for customers',
                            },
                            { label: 'Staging', description: 'Test it first' },
                        ],
                        multiple: false,
                        custom: false,
                    },
                    {
                        header: 'Channels',
                        question: 'Which channels should be enabled?',
                        options: [
                            { label: 'Email', description: 'Email delivery' },
                            { label: 'Push', description: 'Push delivery' },
                        ],
                        multiple: true,
                        custom: true,
                    },
                ],
            },
        ]);
        expect(server.questionResponses).toEqual([
            {
                path: '/question/que_1/reply',
                body: { answers: [['Production'], ['Email', 'Push']] },
            },
        ]);
    });

    test('rejects a dismissed native question through OpenCode', async () => {
        const server = new FakeOpenCodeServer();
        const session = await server.adapter().start({
            workbench: workbench(),
            workspaceDirectory: '/workspace',
            environment: {},
            configuration: configuration(),
            host: {
                emit: async () => {},
                requestPermission: async () => 'reject',
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
        });
        server.onPrompt = () => {
            server.emit('session.status', { status: { type: 'busy' } });
            server.emit('question.asked', {
                id: 'que_dismissed',
                questions: [
                    {
                        question: 'Continue?',
                        options: [{ label: 'Yes' }, { label: 'No' }],
                        custom: false,
                    },
                ],
            });
        };
        server.onQuestionResponse = () => server.completeTurn('dismissed');

        await session.prompt('ask before continuing');
        await session.close();

        expect(server.questionResponses).toEqual([
            { path: '/question/que_dismissed/reject' },
        ]);
    });

    test('does not fail a turn when a permission was already resolved', async () => {
        const server = new FakeOpenCodeServer();
        server.permissionReplyStatus = 404;
        const session = await server.adapter().start({
            workbench: workbench(),
            workspaceDirectory: '/workspace',
            environment: {},
            configuration: configuration(),
            host: {
                emit: async () => {},
                requestPermission: async () => 'allow_once',
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
        });
        server.onPrompt = () => {
            server.emit('session.status', { status: { type: 'busy' } });
            server.emit('permission.asked', {
                id: 'per_stale',
                permission: 'external_directory',
                patterns: ['/outside/*'],
                always: ['/outside/*'],
            });
        };
        server.onPermissionReply = () => server.completeTurn('done');

        await expect(session.prompt('inspect')).resolves.toEqual({ reason: 'stop' });
        await session.close();
    });

    test('aborts an active turn and closes the private server idempotently', async () => {
        const server = new FakeOpenCodeServer();
        const session = await server.adapter().start({
            workbench: workbench(),
            workspaceDirectory: '/workspace',
            environment: {},
            configuration: configuration(),
            host: {
                emit: async () => {},
                requestPermission: async () => 'reject',
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
        });
        server.onPrompt = () =>
            server.emit('session.status', { status: { type: 'busy' } });

        const turn = session.prompt('wait');
        await session.cancelTurn();
        await expect(turn).resolves.toEqual({ reason: 'cancelled' });
        await session.close();
        await session.close();

        expect(server.aborts).toBe(1);
        expect(server.kills).toBe(1);
    });

    test('waits for native idle after an immediate cancellation before accepting another turn', async () => {
        const server = new FakeOpenCodeServer();
        server.autoIdleOnAbort = false;
        const events: WorkbenchEventDraft[] = [];
        const session = await server.adapter().start({
            workbench: workbench(),
            workspaceDirectory: '/workspace',
            environment: {},
            configuration: configuration(),
            host: {
                emit: async (event) => void events.push(event),
                requestPermission: async () => 'reject',
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
        });
        server.onPrompt = () => {};

        const first = session.prompt('cancel immediately');
        await server.prompted;
        let cancellationSettled = false;
        const cancellation = session.cancelTurn().then(() => {
            cancellationSettled = true;
        });
        await server.aborted;
        server.emit('session.error', {
            error: {
                name: 'MessageAbortedError',
                data: { message: 'The operation was aborted' },
            },
        });
        await Bun.sleep(0);
        expect(cancellationSettled).toBeFalse();

        server.emit('session.status', { status: { type: 'idle' } });
        await cancellation;
        await expect(first).resolves.toEqual({ reason: 'cancelled' });

        let recoveredSettled = false;
        server.onPrompt = () => {
            server.emit('session.status', { status: { type: 'busy' } });
            server.emit('session.idle', {});
            server.emit('session.status', { status: { type: 'idle' } });
        };
        const recovered = session.prompt('try again').then((result) => {
            recoveredSettled = true;
            return result;
        });
        await Bun.sleep(0);
        expect(recoveredSettled).toBeFalse();

        server.completeTurn('recovered');
        await expect(recovered).resolves.toEqual({ reason: 'stop' });
        await session.close();

        expect(events.filter((event) => event.type === 'output.text')).toEqual([
            {
                type: 'output.text',
                data: {
                    id: expect.stringMatching(/^output_/),
                    text: 'recovered',
                },
            },
        ]);
    });

    test('does not hide an unexpected native failure during cancellation', async () => {
        const server = new FakeOpenCodeServer();
        server.autoIdleOnAbort = false;
        const session = await server.adapter().start({
            workbench: workbench(),
            workspaceDirectory: '/workspace',
            environment: {},
            configuration: configuration(),
            host: {
                emit: async () => {},
                requestPermission: async () => 'reject',
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
        });
        server.onPrompt = () => {};

        const turn = session.prompt('cancel during a native failure');
        await server.prompted;
        const cancellation = session.cancelTurn();
        const failures = Promise.allSettled([turn, cancellation]);
        await server.aborted;
        server.emit('session.error', {
            error: {
                name: 'ProviderAuthError',
                data: { message: 'Authentication failed' },
            },
        });

        expect(await failures).toEqual([
            {
                status: 'rejected',
                reason: expect.objectContaining({
                    message: 'OpenCode session failed',
                }),
            },
            {
                status: 'rejected',
                reason: expect.objectContaining({
                    message: 'OpenCode session failed',
                }),
            },
        ]);
        await session.close();
    });

    test('can close while the host has not answered a permission request', async () => {
        const server = new FakeOpenCodeServer();
        let permissionRequested!: () => void;
        const requested = new Promise<void>((resolve) => {
            permissionRequested = resolve;
        });
        const session = await server.adapter().start({
            workbench: workbench(),
            workspaceDirectory: '/workspace',
            environment: {},
            configuration: configuration(),
            host: {
                emit: async () => {},
                requestPermission: () => {
                    permissionRequested();
                    return new Promise(() => {});
                },
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
        });
        server.onPrompt = () => {
            server.emit('session.status', { status: { type: 'busy' } });
            server.emit('permission.asked', {
                id: 'per_pending',
                permission: 'external_directory',
                patterns: ['/outside/*'],
                always: [],
            });
        };

        const turn = session.prompt('inspect');
        await requested;
        await session.close();
        await expect(turn).resolves.toEqual({ reason: 'cancelled' });
        expect(server.permissionReplies).toEqual([]);
    });

    test('rejects a later turn when the event stream failed while idle', async () => {
        const server = new FakeOpenCodeServer();
        const session = await server.adapter().start({
            workbench: workbench(),
            workspaceDirectory: '/workspace',
            environment: {},
            configuration: configuration(),
            host: {
                emit: async () => {},
                requestPermission: async () => 'reject',
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
        });

        server.failEventStream();
        await Bun.sleep(0);
        await expect(session.prompt('after failure')).rejects.toThrow(
            'OpenCode event stream failed'
        );
        await session.close();
    });
});

class FakeOpenCodeServer {
    readonly promptBodies: Record<string, unknown>[] = [];
    readonly permissionReplies: Record<string, unknown>[] = [];
    readonly questionResponses: Array<{
        path: string;
        body?: Record<string, unknown>;
    }> = [];
    createdSessions = 0;
    aborts = 0;
    kills = 0;
    permissionReplyStatus = 200;
    autoIdleOnAbort = true;
    spawnEnvironment: Record<string, string | undefined> = {};
    onPrompt?: (body: Record<string, unknown>) => void;
    onPermissionReply?: (body: Record<string, unknown>) => void;
    onQuestionResponse?: () => void;
    private eventController?: ReadableStreamDefaultController<Uint8Array>;
    private stdoutController?: ReadableStreamDefaultController<Uint8Array>;
    private stderrController?: ReadableStreamDefaultController<Uint8Array>;
    private exit!: (code: number) => void;
    private resolvePrompted!: () => void;
    private resolveAborted!: () => void;
    readonly prompted = new Promise<void>((resolve) => {
        this.resolvePrompted = resolve;
    });
    readonly aborted = new Promise<void>((resolve) => {
        this.resolveAborted = resolve;
    });

    adapter() {
        return new OpenCodeSessionAdapter({
            password: () => 'test-password',
            spawn: (_command, options) => {
                this.spawnEnvironment = options.env;
                return this.process();
            },
            fetch: (input, init) => this.fetch(input, init),
            startupTimeoutMs: 100,
        });
    }

    arrange(scenario: RunnerConformanceScenario) {
        if (scenario === 'streaming_text') {
            this.onPrompt = () => {
                this.emit('session.status', { status: { type: 'busy' } });
                this.beginAssistant();
                this.emit('message.part.updated', {
                    part: {
                        id: 'reasoning_contract',
                        messageID: this.currentAssistantMessageId(),
                        type: 'reasoning',
                        text: RUNNER_CONFORMANCE_UNSAFE_VALUES[0],
                        metadata: {
                            credential: RUNNER_CONFORMANCE_UNSAFE_VALUES[1],
                        },
                    },
                });
                this.emit('message.part.updated', {
                    part: {
                        id: 'text_contract',
                        messageID: this.currentAssistantMessageId(),
                        type: 'text',
                        text: '',
                    },
                });
                for (const delta of ['Hello', ' world']) {
                    this.emit('message.part.delta', {
                        messageID: this.currentAssistantMessageId(),
                        partID: 'text_contract',
                        field: 'text',
                        delta,
                    });
                }
                this.finishContractTurn();
            };
            return;
        }
        if (scenario === 'tool_events') {
            this.onPrompt = () => {
                this.emit('session.status', { status: { type: 'busy' } });
                this.beginAssistant();
                this.emit('message.part.updated', {
                    part: contractToolPart('running'),
                });
                this.emit('message.part.updated', {
                    part: contractToolPart('completed'),
                });
                this.emit('message.part.updated', {
                    part: {
                        id: 'finish_contract',
                        messageID: this.currentAssistantMessageId(),
                        type: 'step-finish',
                        reason: 'stop',
                        tokens: {
                            total: 12,
                            input: 5,
                            output: 7,
                            reasoning: 2,
                        },
                        cost: 0.001,
                    },
                });
                this.emit('session.status', { status: { type: 'idle' } });
            };
            return;
        }
        if (scenario === 'permissions') {
            this.onPrompt = () => {
                this.emit('session.status', { status: { type: 'busy' } });
                this.emit('permission.asked', {
                    id: 'permission_contract',
                    permission: 'external_directory',
                    patterns: ['/outside/*'],
                    always: ['/outside/*'],
                });
            };
            this.onPermissionReply = () => this.completeTurn('approved');
            return;
        }
        if (scenario === 'questions') {
            this.onPrompt = () => {
                this.emit('session.status', { status: { type: 'busy' } });
                this.emit('question.asked', {
                    id: 'question_contract',
                    questions: [
                        {
                            question: 'Where should this deploy?',
                            options: [
                                { label: 'Production', description: '' },
                                { label: 'Staging', description: '' },
                            ],
                            custom: false,
                        },
                    ],
                });
            };
            this.onQuestionResponse = () => this.completeTurn('configured');
            return;
        }
        if (scenario === 'multi_turn') {
            this.onPrompt = (body) => this.completeTurn(String(firstPartText(body)));
            return;
        }
        if (scenario === 'image_input') {
            this.onPrompt = () => this.completeTurn('image received');
            return;
        }
        if (scenario === 'cancellation') {
            this.onPrompt = () =>
                this.emit('session.status', { status: { type: 'busy' } });
            return;
        }
        if (scenario === 'failures') {
            this.onPrompt = () => {
                this.emit('session.status', { status: { type: 'busy' } });
                this.emit('session.error', {
                    error: RUNNER_CONFORMANCE_UNSAFE_VALUES[1],
                });
            };
            return;
        }
        this.onPrompt = () => {
            this.emit('session.status', { status: { type: 'busy' } });
            this.emit('future.event', {
                secret: RUNNER_CONFORMANCE_UNSAFE_VALUES[1],
            });
            this.completeTurn('done');
        };
    }

    emit(type: string, properties: Record<string, unknown>) {
        this.eventController?.enqueue(
            new TextEncoder().encode(
                `data: ${JSON.stringify({
                    type,
                    properties: {
                        sessionID: 'ses_native_1',
                        ...properties,
                    },
                })}\n\n`
            )
        );
    }

    failEventStream() {
        this.eventController?.error(new Error('native stream failure'));
    }

    completeTurn(text: string) {
        this.beginAssistant();
        this.emit('message.part.updated', {
            part: {
                id: `part_${this.promptBodies.length}`,
                messageID: this.currentAssistantMessageId(),
                type: 'text',
                text: '',
            },
        });
        this.emit('message.part.delta', {
            partID: `part_${this.promptBodies.length}`,
            messageID: this.currentAssistantMessageId(),
            field: 'text',
            delta: text,
        });
        this.emit('message.part.updated', {
            part: {
                id: `finish_${this.promptBodies.length}`,
                messageID: this.currentAssistantMessageId(),
                type: 'step-finish',
                reason: 'stop',
            },
        });
        this.emit('session.status', { status: { type: 'idle' } });
    }

    private finishContractTurn() {
        this.emit('message.part.updated', {
            part: {
                id: 'finish_contract',
                messageID: this.currentAssistantMessageId(),
                type: 'step-finish',
                reason: 'stop',
            },
        });
        this.emit('session.status', { status: { type: 'idle' } });
    }

    beginAssistant() {
        this.emit('message.updated', {
            info: {
                id: this.currentAssistantMessageId(),
                role: 'assistant',
                parentID: this.currentInputMessageId(),
            },
        });
    }

    emitAssistantText(messageId: string, parentId: string, text: string) {
        const partId = `part_${messageId}`;
        this.emit('message.updated', {
            info: { id: messageId, role: 'assistant', parentID: parentId },
        });
        this.emit('message.part.updated', {
            part: { id: partId, messageID: messageId, type: 'text', text: '' },
        });
        this.emit('message.part.delta', {
            messageID: messageId,
            partID: partId,
            field: 'text',
            delta: text,
        });
    }

    currentAssistantMessageId() {
        return `message_${this.promptBodies.length}`;
    }

    currentInputMessageId() {
        return String(this.promptBodies.at(-1)?.messageID);
    }

    private process() {
        const stdout = new ReadableStream<Uint8Array>({
            start: (controller) => {
                this.stdoutController = controller;
                controller.enqueue(
                    new TextEncoder().encode(
                        'opencode server listening on http://127.0.0.1:43210\n'
                    )
                );
            },
        });
        const stderr = new ReadableStream<Uint8Array>({
            start: (controller) => {
                this.stderrController = controller;
            },
        });
        const exited = new Promise<number>((resolve) => {
            this.exit = resolve;
        });
        return {
            stdout,
            stderr,
            exited,
            kill: () => {
                this.kills += 1;
                this.stdoutController?.close();
                this.stderrController?.close();
                this.exit(0);
            },
        };
    }

    private async fetch(input: string | URL | Request, init: RequestInit = {}) {
        const url = new URL(String(input));
        expect(init.headers && new Headers(init.headers).get('Authorization')).toBe(
            `Basic ${btoa('opencode:test-password')}`
        );
        if (url.pathname === '/session' && init.method === 'POST') {
            this.createdSessions += 1;
            return Response.json({ id: 'ses_native_1' });
        }
        if (url.pathname === '/event') {
            const stream = new ReadableStream<Uint8Array>({
                start: (controller) => {
                    this.eventController = controller;
                    init.signal?.addEventListener('abort', () => {
                        try {
                            controller.close();
                        } catch {
                            // The failure test has already errored this stream.
                        }
                    });
                },
            });
            return new Response(stream, { status: 200 });
        }
        if (url.pathname.endsWith('/prompt_async')) {
            const body = JSON.parse(String(init.body)) as Record<string, unknown>;
            this.promptBodies.push(body);
            this.resolvePrompted();
            queueMicrotask(() => this.onPrompt?.(body));
            return new Response(null, { status: 204 });
        }
        if (url.pathname.endsWith('/abort')) {
            this.aborts += 1;
            this.resolveAborted();
            if (this.autoIdleOnAbort) {
                queueMicrotask(() =>
                    this.emit('session.status', { status: { type: 'idle' } })
                );
            }
            return Response.json(true);
        }
        if (url.pathname.startsWith('/question/')) {
            const body = init.body
                ? (JSON.parse(String(init.body)) as Record<string, unknown>)
                : undefined;
            this.questionResponses.push({
                path: url.pathname,
                ...(body ? { body } : {}),
            });
            queueMicrotask(() => this.onQuestionResponse?.());
            return Response.json(true);
        }
        if (url.pathname.endsWith('/reply')) {
            const body = JSON.parse(String(init.body)) as Record<string, unknown>;
            this.permissionReplies.push(body);
            queueMicrotask(() => this.onPermissionReply?.(body));
            return Response.json(
                this.permissionReplyStatus === 200
                    ? true
                    : {
                          _tag: 'PermissionNotFoundError',
                          message: 'Permission request not found',
                      },
                { status: this.permissionReplyStatus }
            );
        }
        return new Response(null, { status: 404 });
    }
}

function toolPart(status: 'running' | 'completed') {
    return {
        type: 'tool',
        messageID: 'message_1',
        tool: 'read',
        callID: 'call_1',
        state: {
            status,
            input: { filePath: '/outside/file.ts' },
        },
    };
}

function contractToolPart(status: 'running' | 'completed') {
    return {
        type: 'tool',
        messageID: 'message_1',
        tool: 'write',
        callID: 'call_contract',
        state: {
            status,
            input: {
                filePath: '/workspace/output.txt',
                command: RUNNER_CONFORMANCE_UNSAFE_VALUES[2],
            },
            output: RUNNER_CONFORMANCE_UNSAFE_VALUES[3],
            time: { start: 100, end: 125 },
        },
    };
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function firstPartText(body: Record<string, unknown>) {
    const parts = Array.isArray(body.parts) ? body.parts : [];
    return record(parts[0])?.text;
}

async function settled(promise: Promise<unknown>): Promise<boolean> {
    let value = false;
    void promise.then(
        () => {
            value = true;
        },
        () => {
            value = true;
        }
    );
    await Bun.sleep(0);
    return value;
}

function workbench(): ResolvedWorkbench {
    return {
        manifestPath: '/repo/.workbenches/core/workbench.yml',
        packageDirectory: '/repo/.workbenches/core',
        repositoryDirectory: '/repo',
        instructionsPath: '/repo/.workbenches/core/instructions.md',
        skills: [],
        manifest: {
            spec: 0,
            version: '0.1.0',
            name: 'fixture-core',
            runner: 'opencode',
            model: { id: 'openai/gpt-5.6-terra' },
            instructions: './instructions.md',
            skills: [],
            tools: [],
            mcps: [],
            env: {},
            runtime: 'local',
        },
    };
}

function configuration() {
    return new ModelRouter().resolve({ workbench: workbench() });
}
