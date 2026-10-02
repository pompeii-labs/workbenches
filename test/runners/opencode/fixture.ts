import { expect } from 'bun:test';
import { join } from 'node:path';

import { ModelRouter } from '../../../src/models/index.js';
import { RunnerContextStaging } from '../../../src/runners/context/stage.js';
import { DiskRunnerFiles } from '../../../src/runners/files/disk.js';
import { OpenCodeSessionAdapter } from '../../../src/runners/opencode/adapter.js';
import { OpenCodeSkillStaging } from '../../../src/runners/opencode/skills.js';
import type { ResolvedWorkbench } from '../../../src/types.js';
import { modelCatalogFixture } from '../../model-catalog-fixture.js';
import {
    RUNNER_CONFORMANCE_UNSAFE_VALUES,
    type RunnerConformanceScenario,
} from '../../runner-adapter-contract.js';

/** An OpenCode server that answers over `fetch` and streams events the test emits. */
export class FakeOpenCodeServer {
    readonly sessions = new Map<string, Record<string, unknown>>();
    readonly promptBodies: Record<string, unknown>[] = [];
    readonly permissionReplies: Record<string, unknown>[] = [];
    readonly questionResponses: Array<{
        path: string;
        body?: Record<string, unknown>;
    }> = [];
    readonly authenticationRequests: string[] = [];
    createdSessions = 0;
    resumedSessions = 0;
    aborts = 0;
    kills = 0;
    permissionReplyStatus = 200;
    autoIdleOnAbort = true;
    stallSessionCreation = false;
    sessionCreationDelayMs = 0;
    authenticationDelayMs = 0;
    spawnEnvironment: Record<string, string | undefined> = {};
    /** What `GET /session/:id/message` returns: messages with their parts. */
    transcript: Array<{ info: Record<string, unknown>; parts: unknown[] }> = [];
    eventSubscriptions = 0;
    /** Event streams opened and not yet closed or aborted. */
    openEventStreams = 0;
    transcriptReads = 0;
    /** The status the event stream answers with. */
    eventStatus = 200;
    /** Holds each transcript read until this settles. */
    transcriptGate: Promise<void> | undefined;
    onTranscriptRead?: (() => void) | undefined;
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
        const files = new DiskRunnerFiles();
        return new OpenCodeSessionAdapter({
            skills: new OpenCodeSkillStaging(files, new RunnerContextStaging(files)),
            password: () => 'test-password',
            spawn: (_command, options) => {
                this.spawnEnvironment = options.env;
                return this.process();
            },
            fetch: (input, init) => this.fetch(input, init),
            startupTimeoutMs: 100,
            authenticationTimeoutMs: 500,
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

    /** Ends the stream without an error, as a proxy that drops an idle connection does. */
    endEventStream() {
        this.eventController?.close();
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

    launch() {
        return {
            process: this.process(),
            resolveUrl: async (url: string) => url,
        };
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
        if (url.pathname === '/provider/auth' && init.method === 'GET') {
            this.authenticationRequests.push('methods');
            return Response.json({
                openai: [
                    {
                        type: 'oauth',
                        label: 'ChatGPT Pro/Plus (headless)',
                    },
                ],
            });
        }
        if (
            url.pathname === '/provider/openai/oauth/authorize' &&
            init.method === 'POST'
        ) {
            const body = JSON.parse(String(init.body)) as { method: number };
            this.authenticationRequests.push(`authorize:openai:${body.method}`);
            return Response.json({
                method: 'auto',
                url: 'https://auth.example/device',
                instructions: 'Enter code: TEST-CODE',
            });
        }
        if (
            url.pathname === '/provider/openai/oauth/callback' &&
            init.method === 'POST'
        ) {
            const body = JSON.parse(String(init.body)) as { method: number };
            this.authenticationRequests.push(`callback:openai:${body.method}`);
            if (this.authenticationDelayMs) await Bun.sleep(this.authenticationDelayMs);
            return Response.json({});
        }
        if (url.pathname === '/session' && init.method === 'POST') {
            this.createdSessions += 1;
            if (this.sessionCreationDelayMs)
                await Bun.sleep(this.sessionCreationDelayMs);
            if (this.stallSessionCreation) {
                await new Promise<void>((_, reject) => {
                    init.signal?.addEventListener(
                        'abort',
                        () => reject(new DOMException('Aborted', 'AbortError')),
                        { once: true }
                    );
                });
            }
            return Response.json({ id: 'ses_native_1' });
        }
        if (url.pathname === '/session/ses_native_1' && init.method === 'GET') {
            this.resumedSessions += 1;
            return Response.json({ id: 'ses_native_1' });
        }
        if (url.pathname === '/session/ses_native_1/message' && init.method === 'GET') {
            this.transcriptReads += 1;
            this.onTranscriptRead?.();
            await this.transcriptGate;
            return Response.json(this.transcript);
        }
        if (url.pathname.startsWith('/session/') && init.method === 'GET') {
            const info = this.sessions.get(
                decodeURIComponent(url.pathname.slice('/session/'.length))
            );
            return info ? Response.json(info) : new Response(null, { status: 404 });
        }
        if (url.pathname === '/event') {
            this.eventSubscriptions += 1;
            if (this.eventStatus !== 200) {
                return new Response(null, { status: this.eventStatus });
            }
            this.openEventStreams += 1;
            let open = true;
            const closed = () => {
                if (open) this.openEventStreams -= 1;
                open = false;
            };
            const stream = new ReadableStream<Uint8Array>({
                start: (controller) => {
                    this.eventController = controller;
                    init.signal?.addEventListener('abort', () => {
                        closed();
                        try {
                            controller.close();
                        } catch {
                            // The failure test has already errored this stream.
                        }
                    });
                },
                cancel: closed,
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

export function contractToolPart(status: 'running' | 'completed') {
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

export function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

export function firstPartText(body: Record<string, unknown>) {
    const parts = Array.isArray(body.parts) ? body.parts : [];
    return record(parts[0])?.text;
}

/** Whether the promise has settled yet, after one turn of the event loop. */
export async function settled(promise: Promise<unknown>): Promise<boolean> {
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

/** A Workbench package for the OpenCode runner, with its files under the given directories. */
export function fixtureWorkbench(
    packageDirectory: string,
    repositoryDirectory: string
): ResolvedWorkbench {
    return {
        manifestPath: join(packageDirectory, 'workbench.yml'),
        packageDirectory,
        repositoryDirectory,
        instructionsPath: join(packageDirectory, 'instructions.md'),
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

export function fixtureConfiguration(workbench: ResolvedWorkbench) {
    return new ModelRouter(modelCatalogFixture).resolve({ workbench });
}
