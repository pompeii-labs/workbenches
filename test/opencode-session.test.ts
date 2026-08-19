import { describe, expect, test } from 'bun:test';

import type { WorkbenchEventDraft } from '../src/execution.js';
import { OpenCodeSessionAdapter } from '../src/opencode-session.js';
import type { RunnerPermissionRequest } from '../src/runner-session.js';
import type { ResolvedWorkbench } from '../src/types.js';

describe('OpenCode interactive server adapter', () => {
    test('keeps context in one native server session across streamed turns', async () => {
        const server = new FakeOpenCodeServer();
        const events: WorkbenchEventDraft[] = [];
        const adapter = server.adapter();
        const session = await adapter.start({
            workbench: workbench(),
            workspaceDirectory: '/workspace',
            environment: {},
            host: {
                emit: async (event) => void events.push(event),
                requestPermission: async () => 'reject',
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
        expect(events.filter((event) => event.type === 'output.text')).toEqual([
            { type: 'output.text', data: { text: 'first' } },
            { type: 'output.text', data: { text: 'second' } },
        ]);
        expect(JSON.stringify(events)).not.toContain('MUST_NOT_RENDER');
        expect(JSON.stringify(events)).not.toContain('MUST_NOT_RENDER_REASONING');
    });

    test('pauses for a host permission decision and replies before continuing', async () => {
        const server = new FakeOpenCodeServer();
        const requests: RunnerPermissionRequest[] = [];
        const events: WorkbenchEventDraft[] = [];
        const session = await server.adapter().start({
            workbench: workbench(),
            workspaceDirectory: '/workspace',
            environment: {},
            host: {
                emit: async (event) => void events.push(event),
                requestPermission: async (request) => {
                    requests.push(request);
                    return 'allow_once';
                },
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
            host: {
                emit: async () => {},
                requestPermission: async () => {
                    prompts += 1;
                    return 'allow_always';
                },
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

    test('does not fail a turn when a permission was already resolved', async () => {
        const server = new FakeOpenCodeServer();
        server.permissionReplyStatus = 404;
        const session = await server.adapter().start({
            workbench: workbench(),
            workspaceDirectory: '/workspace',
            environment: {},
            host: {
                emit: async () => {},
                requestPermission: async () => 'allow_once',
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
            host: {
                emit: async () => {},
                requestPermission: async () => 'reject',
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
            host: {
                emit: async () => {},
                requestPermission: () => {
                    permissionRequested();
                    return new Promise(() => {});
                },
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
});

class FakeOpenCodeServer {
    readonly promptBodies: Record<string, unknown>[] = [];
    readonly permissionReplies: Record<string, unknown>[] = [];
    createdSessions = 0;
    aborts = 0;
    kills = 0;
    permissionReplyStatus = 200;
    onPrompt?: (body: Record<string, unknown>) => void;
    onPermissionReply?: (body: Record<string, unknown>) => void;
    private eventController?: ReadableStreamDefaultController<Uint8Array>;
    private stdoutController?: ReadableStreamDefaultController<Uint8Array>;
    private stderrController?: ReadableStreamDefaultController<Uint8Array>;
    private exit!: (code: number) => void;

    adapter() {
        return new OpenCodeSessionAdapter({
            password: () => 'test-password',
            spawn: () => this.process(),
            fetch: (input, init) => this.fetch(input, init),
            startupTimeoutMs: 100,
        });
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

    beginAssistant() {
        this.emit('message.updated', {
            info: {
                id: this.currentAssistantMessageId(),
                role: 'assistant',
            },
        });
    }

    currentAssistantMessageId() {
        return `message_${this.promptBodies.length}`;
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
                    init.signal?.addEventListener('abort', () => controller.close());
                },
            });
            return new Response(stream, { status: 200 });
        }
        if (url.pathname.endsWith('/prompt_async')) {
            const body = JSON.parse(String(init.body)) as Record<string, unknown>;
            this.promptBodies.push(body);
            queueMicrotask(() => this.onPrompt?.(body));
            return new Response(null, { status: 204 });
        }
        if (url.pathname.endsWith('/abort')) {
            this.aborts += 1;
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

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function firstPartText(body: Record<string, unknown>) {
    const parts = Array.isArray(body.parts) ? body.parts : [];
    return record(parts[0])?.text;
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
            model: 'openrouter/openai/gpt-5.6-terra',
            instructions: './instructions.md',
            skills: [],
            tools: [],
            mcps: [],
            env: {},
            runtime: 'local',
        },
    };
}
