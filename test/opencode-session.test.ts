import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRouter } from '../src/models/index.js';
import { sessionFailure } from '../src/runners/opencode/router.js';
import type {
    RunnerPermissionRequest,
    RunnerQuestionRequest,
} from '../src/runners/session.js';
import type { WorkbenchEventDraft } from '../src/runs/index.js';
import type { ResolvedWorkbench } from '../src/types.js';
import { modelCatalogFixture } from './model-catalog-fixture.js';
import { runnerAdapterContract } from './runner-adapter-contract.js';
import {
    FakeOpenCodeServer,
    firstPartText,
    fixtureConfiguration,
    fixtureWorkbench,
    settled,
} from './runners/opencode/fixture.js';

const root = await mkdtemp(join(tmpdir(), 'opencode-session-contract-'));
const packageDirectory = join(root, '.workbenches', 'core');
await mkdir(packageDirectory, { recursive: true });
const instructionsPath = join(packageDirectory, 'instructions.md');
await writeFile(instructionsPath, '# OpenCode instructions\n');
afterAll(() => rm(root, { recursive: true, force: true }));

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
    test('releases an unanswered request on cancellation so the next turn can ask', async () => {
        const server = new FakeOpenCodeServer();
        let asked!: () => void;
        const requested = new Promise<void>((resolve) => {
            asked = resolve;
        });
        let count = 0;
        const session = await server.adapter().start({
            workbench: workbench(),
            workspaceDirectory: '/workspace',
            environment: {},
            configuration: configuration(),
            host: {
                emit: async () => {},
                requestPermission: async () => {
                    count++;
                    if (count === 1) {
                        asked();
                        return new Promise(() => {});
                    }
                    return 'allow_once';
                },
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
        });
        try {
            server.onPrompt = () =>
                server.emit('permission.asked', {
                    id: `permission_${count}`,
                    permission: 'read',
                    patterns: ['/outside'],
                });
            const first = session.prompt('first');
            await requested;
            await session.cancelTurn();
            expect(await first).toEqual({ reason: 'cancelled' });
            server.onPermissionReply = () => server.completeTurn('second');
            await session.prompt('second');
            expect(count).toBe(2);
            expect(server.permissionReplies).toEqual([{ reply: 'once' }]);
        } finally {
            await session.close();
        }
    });

    test('keeps streaming child usage while a sibling permission is unanswered', async () => {
        const server = new FakeOpenCodeServer();
        let answer!: (decision: 'allow_once') => void;
        const decision = new Promise<'allow_once'>((resolve) => {
            answer = resolve;
        });
        let observed!: () => void;
        const usage = new Promise<void>((resolve) => {
            observed = resolve;
        });
        const session = await server.adapter().start({
            workbench: workbench(),
            workspaceDirectory: '/workspace',
            environment: {},
            configuration: configuration(),
            host: {
                emit: async (event) => {
                    if (event.type === 'usage.updated') observed();
                },
                requestPermission: async () => decision,
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
        });
        try {
            server.onPrompt = () => {
                server.emit('session.created', {
                    info: { id: 'ses_child', parentID: 'ses_native_1' },
                });
                server.emit('permission.asked', {
                    id: 'pending',
                    permission: 'read',
                    patterns: ['/outside'],
                });
                server.emit('message.part.updated', {
                    sessionID: 'ses_child',
                    part: {
                        id: 'step_1',
                        type: 'step-finish',
                        cost: 0.5,
                        tokens: { total: 100 },
                    },
                });
            };
            server.onPermissionReply = () => server.completeTurn('done');
            const result = session.prompt('parallel branches');
            await usage;
            expect(server.permissionReplies).toEqual([]);
            answer('allow_once');
            await result;
        } finally {
            await session.close();
        }
    });

    test('streams descendant spend and tools once without completing or replacing the parent reply', async () => {
        const server = new FakeOpenCodeServer();
        const emitted: WorkbenchEventDraft[] = [];
        let observed!: () => void;
        const childUsage = new Promise<void>((resolve) => {
            observed = resolve;
        });
        const session = await server.adapter().start({
            workbench: workbench(),
            workspaceDirectory: '/workspace',
            environment: {},
            configuration: configuration(),
            host: {
                emit: async (event) => {
                    emitted.push(event);
                    if (event.type === 'usage.updated') observed();
                },
                requestPermission: async () => 'reject',
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
        });
        try {
            server.onPrompt = () => {
                server.emit('session.created', {
                    info: { id: 'ses_child', parentID: 'ses_native_1' },
                });
                server.emit('session.created', {
                    info: { id: 'ses_grandchild', parentID: 'ses_child' },
                });
                server.emit('message.part.updated', {
                    sessionID: 'ses_grandchild',
                    part: { type: 'text', text: 'Not the parent answer' },
                });
                server.emit('message.part.updated', {
                    sessionID: 'ses_grandchild',
                    part: toolPart('completed'),
                });
                const step = {
                    sessionID: 'ses_grandchild',
                    part: {
                        id: 'step_child',
                        type: 'step-finish',
                        reason: 'stop',
                        cost: 0.5,
                        tokens: { total: 100 },
                    },
                };
                server.emit('message.part.updated', step);
                server.emit('message.part.updated', step);
                server.emit('session.status', {
                    sessionID: 'ses_grandchild',
                    status: { type: 'idle' },
                });
                server.emit('message.part.updated', {
                    sessionID: 'ses_unrelated',
                    part: { ...step.part, cost: 100 },
                });
            };
            let completed = false;
            const result = session.prompt('delegate').then((value) => {
                completed = true;
                return value;
            });
            await childUsage;
            await Bun.sleep(10);
            expect(completed).toBe(false);
            expect(emitted.filter((event) => event.type === 'usage.updated')).toEqual([
                {
                    type: 'usage.updated',
                    data: {
                        kind: 'delta',
                        total_tokens: 100,
                        cost_usd: 0.5,
                        native_session_id: 'ses_grandchild',
                    },
                },
            ]);
            expect(
                emitted.find((event) => event.type === 'tool.completed')?.data.id
            ).toBe('ses_grandchild:call_1');
            expect(emitted.some((event) => event.type === 'output.text')).toBe(false);
            server.completeTurn('Parent answer');
            expect(await result).toMatchObject({ reason: 'stop' });
            expect(
                emitted
                    .filter((event) => event.type === 'output.text')
                    .map((event) => event.data.text)
                    .join('')
            ).toBe('Parent answer');
        } finally {
            await session.close();
        }
    });

    test('resolves resumed child ancestry and surfaces its permissions and questions', async () => {
        const server = new FakeOpenCodeServer();
        server.sessions.set('ses_child', { id: 'ses_child', parentID: 'ses_native_1' });
        const requests: string[] = [];
        const session = await server.adapter().start({
            workbench: workbench(),
            workspaceDirectory: '/workspace',
            environment: {},
            configuration: configuration(),
            host: {
                emit: async () => {},
                requestPermission: async (request) => {
                    requests.push(request.id);
                    return 'allow_once';
                },
                requestQuestion: async (request) => {
                    requests.push(request.id);
                    return { outcome: 'rejected' };
                },
            },
        });
        try {
            server.onPrompt = () => {
                server.emit('permission.asked', {
                    sessionID: 'ses_child',
                    id: 'child_permission',
                    permission: 'external_directory',
                    patterns: ['/outside/*'],
                    always: [],
                });
                server.emit('question.asked', {
                    sessionID: 'ses_child',
                    id: 'child_question',
                    questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }],
                });
            };
            server.onQuestionResponse = () => server.completeTurn('done');
            await session.prompt('delegate');
            expect(requests).toEqual(['child_permission', 'child_question']);
            expect(server.permissionReplies).toEqual([{ reply: 'once' }]);
            expect(server.questionResponses).toEqual([
                { path: '/question/child_question/reject' },
            ]);
        } finally {
            await session.close();
        }
    });

    test('rejects unrelated and cyclic session ancestry without admitting their spend', async () => {
        const server = new FakeOpenCodeServer();
        server.sessions.set('ses_other', { id: 'ses_other' });
        server.sessions.set('ses_cycle', { id: 'ses_cycle', parentID: 'ses_cycle' });
        const emitted: WorkbenchEventDraft[] = [];
        const session = await server.adapter().start({
            workbench: workbench(),
            workspaceDirectory: '/workspace',
            environment: {},
            configuration: configuration(),
            host: {
                emit: async (event) => {
                    emitted.push(event);
                },
                requestPermission: async () => {
                    throw new Error('unrelated permission');
                },
                requestQuestion: async () => {
                    throw new Error('unrelated question');
                },
            },
        });
        try {
            server.onPrompt = () => {
                for (const sessionID of ['ses_other', 'ses_cycle']) {
                    server.emit('permission.asked', {
                        sessionID,
                        id: 'permission_other',
                        permission: 'read',
                        patterns: ['/outside'],
                    });
                    server.emit('message.part.updated', {
                        sessionID,
                        part: {
                            id: 'step_other',
                            type: 'step-finish',
                            cost: 100,
                            tokens: { total: 100 },
                        },
                    });
                }
                server.completeTurn('done');
            };
            await session.prompt('work');
            expect(emitted.filter((event) => event.type === 'usage.updated')).toEqual(
                []
            );
            expect(server.permissionReplies).toEqual([]);
        } finally {
            await session.close();
        }
    });

    for (const [action, resources, allowed] of [
        ['external_directory', ['/outbox/*'], true],
        ['external_directory', ['/outbox/reports/*'], true],
        ['external_directory', ['/*'], false],
        ['external_directory', ['/outbox-other/*'], false],
        ['external_directory', ['/outbox/../secrets/*'], false],
        ['external_directory', ['/outbox/*', '/secrets/*'], false],
        ['edit', ['/outbox/*'], false],
    ] as const) {
        test(`keeps native ${action} permission for ${resources.join(', ')} ${allowed ? 'inside the outbox contract' : 'under host control'}`, async () => {
            const server = new FakeOpenCodeServer();
            let requested = 0;
            const session = await server.adapter().start({
                workbench: workbench(),
                workspaceDirectory: '/workspace',
                environment: { WORKBENCH_OUTPUT_DIR: '/outbox' },
                configuration: configuration(),
                host: {
                    emit: async () => {},
                    requestPermission: async () => {
                        requested += 1;
                        return 'reject';
                    },
                    requestQuestion: async () => ({ outcome: 'rejected' }),
                },
            });
            try {
                server.onPrompt = () =>
                    server.emit('permission.asked', {
                        id: 'per_outbox',
                        permission: action,
                        patterns: resources,
                    });
                server.onPermissionReply = () => server.completeTurn('done');
                await session.prompt('return a report');
                expect(requested).toBe(allowed ? 0 : 1);
                expect(server.permissionReplies).toEqual([
                    { reply: allowed ? 'once' : 'reject' },
                ]);
            } finally {
                await session.close();
            }
        });
    }

    test('does not answer outbox permission requests belonging to another native session', async () => {
        const server = new FakeOpenCodeServer();
        let requested = 0;
        const session = await server.adapter().start({
            workbench: workbench(),
            workspaceDirectory: '/workspace',
            environment: { WORKBENCH_OUTPUT_DIR: '/outbox' },
            configuration: configuration(),
            host: {
                emit: async () => {},
                requestPermission: async () => {
                    requested += 1;
                    return 'reject';
                },
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
        });
        try {
            server.onPrompt = () => {
                server.emit('permission.asked', {
                    sessionID: 'ses_other',
                    id: 'per_other',
                    permission: 'external_directory',
                    patterns: ['/outbox/*'],
                });
                server.completeTurn('done');
            };
            await session.prompt('return a report');
            expect(requested).toBe(0);
            expect(server.permissionReplies).toEqual([]);
        } finally {
            await session.close();
        }
    });

    test('bounds startup through native session creation', async () => {
        const server = new FakeOpenCodeServer();
        server.stallSessionCreation = true;

        await expect(
            server.adapter().start({
                workbench: workbench(),
                workspaceDirectory: '/workspace',
                environment: {},
                configuration: configuration(),
                host: {
                    emit: async () => {},
                    requestPermission: async () => 'reject',
                    requestQuestion: async () => ({ outcome: 'rejected' }),
                },
            })
        ).rejects.toThrow('OpenCode session did not become ready in time');
        expect(server.kills).toBe(1);
    });

    test('uses the prepared cloud readiness budget through native session creation and still bounds a stalled startup', async () => {
        const server = new FakeOpenCodeServer();
        const adapter = server.adapter();
        const options = {
            workbench: workbench(),
            workspaceDirectory: '/workspace',
            environment: {},
            configuration: configuration(),
            host: {
                emit: async () => {},
                requestPermission: async () => 'reject' as const,
                requestQuestion: async () => ({ outcome: 'rejected' as const }),
            },
        };
        server.sessionCreationDelayMs = 150;
        const prepared = {
            startupTimeoutMs: 500,
            launch: () => server.launch(),
        };
        const session = await adapter.startPrepared(options, prepared);
        expect(session.id).toBeDefined();
        await session.close();
        server.stallSessionCreation = true;
        await expect(adapter.startPrepared(options, prepared)).rejects.toThrow(
            'OpenCode session did not become ready in time'
        );
        expect(server.kills).toBe(2);
    });

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
                configuration: new ModelRouter(modelCatalogFixture).resolve({
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

    test('completes configured headless authentication in the run server before creating a session', async () => {
        const server = new FakeOpenCodeServer();
        const events: WorkbenchEventDraft[] = [];
        const session = await server.adapter().start({
            workbench: workbench(),
            workspaceDirectory: '/workspace',
            environment: {},
            configuration: configuration(),
            authentication: {
                provider: 'openai',
                nativeProvider: 'openai',
                authenticationMethod: 'oauth',
                method: 'chatgpt',
                nativeMethod: 'ChatGPT Pro/Plus (headless)',
            },
            host: {
                emit: async (event) => void events.push(event),
                requestPermission: async () => 'reject',
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
        });

        expect(server.authenticationRequests).toEqual([
            'methods',
            'authorize:openai:0',
            'callback:openai:0',
        ]);
        expect(server.createdSessions).toBe(1);
        expect(events).toEqual([
            {
                type: 'authentication.requested',
                data: {
                    provider: 'openai',
                    native_provider: 'openai',
                    url: 'https://auth.example/device',
                    instructions: 'Enter code: TEST-CODE',
                },
            },
            {
                type: 'authentication.completed',
                data: {
                    provider: 'openai',
                    native_provider: 'openai',
                },
            },
        ]);
        await session.close();
    });

    test('does not spend the native startup budget while waiting for device authentication', async () => {
        const server = new FakeOpenCodeServer();
        server.authenticationDelayMs = 150;
        const session = await server.adapter().start({
            workbench: workbench(),
            workspaceDirectory: '/workspace',
            environment: {},
            configuration: configuration(),
            authentication: {
                provider: 'openai',
                nativeProvider: 'openai',
                authenticationMethod: 'oauth',
                method: 'chatgpt',
                nativeMethod: 'ChatGPT Pro/Plus (headless)',
            },
            host: {
                emit: async () => {},
                requestPermission: async () => 'reject',
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
        });

        expect(session.id).toBeDefined();
        expect(server.createdSessions).toBe(1);
        await session.close();
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

    test('reopens a persisted native session instead of creating another', async () => {
        const server = new FakeOpenCodeServer();
        const session = await server.adapter().start({
            workbench: workbench(),
            workspaceDirectory: '/workspace',
            environment: {
                WORKBENCH_OUTPUT_DIR: '/current-attempt/outbox',
                OPENAI_API_KEY: 'must-not-enter-native-prompt',
            },
            configuration: configuration(),
            session: {
                id: 'wb_resumetest123456789012',
                directory: '/private/workbench/session/native',
                nativeSessionId: 'ses_native_1',
            },
            host: {
                emit: async () => {},
                requestPermission: async () => 'reject',
                requestQuestion: async () => ({ outcome: 'rejected' }),
            },
        });

        expect(session.id).toBe('ses_native_1');
        expect(server.createdSessions).toBe(0);
        expect(server.resumedSessions).toBe(1);
        expect(server.spawnEnvironment.OPENCODE_DB).toBe(
            '/private/workbench/session/native/opencode.sqlite'
        );
        server.onPrompt = () => server.completeTurn('done');
        await session.prompt('return the revised report');
        const prompt = server.promptBodies.at(-1);
        expect(prompt?.parts).toEqual([
            {
                type: 'text',
                synthetic: true,
                text: expect.stringContaining('path="/current-attempt/outbox"'),
            },
            { type: 'text', text: 'return the revised report' },
        ]);
        expect(JSON.stringify(prompt)).not.toContain('must-not-enter-native-prompt');
        await session.prompt('then summarize');
        expect(server.promptBodies.at(-1)?.parts).toEqual([
            { type: 'text', text: 'then summarize' },
        ]);
        await session.close();
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
            messageID: expect.stringMatching(/^msg_[a-f0-9]{26}$/),
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

    test('flushes queued steering as one ordered OpenCode batch', async () => {
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

        const turn = session.prompt('original input');
        await server.prompted;
        const first = await session.steer?.('first steering input');
        const second = await session.steer?.('second steering input');
        const third = await session.steer?.('third steering input');
        if (!first || !second || !third) {
            throw new Error('Expected tracked steering delivery');
        }
        await Bun.sleep(0);

        expect(server.promptBodies.map(firstPartText)).toEqual([
            'original input',
            'first steering input',
            'second steering input',
            'third steering input',
        ]);
        const inputIds = server.promptBodies.map((body) => String(body.messageID));
        expect(inputIds).toEqual([...inputIds].sort());
        expect(await settled(first.delivered)).toBeFalse();
        expect(await settled(second.delivered)).toBeFalse();
        expect(await settled(third.delivered)).toBeFalse();

        const batchBoundary = String(server.promptBodies[3]?.messageID);
        server.emitAssistantText('assistant_steering_batch', batchBoundary, 'Done.');
        await expect(
            Promise.all([first.delivered, second.delivered, third.delivered])
        ).resolves.toEqual([undefined, undefined, undefined]);
        server.emit('session.status', { status: { type: 'idle' } });
        await expect(turn).resolves.toEqual({ reason: 'completed' });
        await session.close();
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
                title: 'Read',
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
                    message:
                        'OpenCode session failed: ProviderAuthError: Authentication failed',
                }),
            },
            {
                status: 'rejected',
                reason: expect.objectContaining({
                    message:
                        'OpenCode session failed: ProviderAuthError: Authentication failed',
                }),
            },
        ]);
        await session.close();
    });

    test('reports the native failure text with token-like values redacted', () => {
        expect(
            sessionFailure({
                name: 'APIError',
                data: {
                    message:
                        'Invalid key sk-or-v1-0123456789abcdef0123456789abcdef\nfor   user',
                },
            })
        ).toBe('OpenCode session failed: APIError: Invalid key [redacted] for user');
        expect(
            sessionFailure({ name: 'APIError', data: { message: 'word '.repeat(200) } })
        ).toHaveLength('OpenCode session failed: '.length + 300);
        expect(sessionFailure(undefined)).toBe('OpenCode session failed');
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

function workbench(): ResolvedWorkbench {
    return fixtureWorkbench(packageDirectory, root);
}

function configuration() {
    return fixtureConfiguration(workbench());
}
