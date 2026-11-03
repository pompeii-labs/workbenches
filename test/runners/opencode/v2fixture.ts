import { expect } from 'bun:test';

import { RunnerContextStaging } from '../../../src/runners/context/stage.js';
import { DiskRunnerFiles } from '../../../src/runners/files/disk.js';
import { OpenCodeSessionAdapter } from '../../../src/runners/opencode/adapter.js';
import { OpenCodeSkillStaging } from '../../../src/runners/opencode/skills.js';
import {
    RUNNER_CONFORMANCE_SHELL_COMMAND,
    RUNNER_CONFORMANCE_UNSAFE_VALUES,
    type RunnerConformanceScenario,
} from '../../runner-adapter-contract.js';
import { record } from './fixture.js';

const STEP_USAGE = {
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
};

export interface V2Request {
    path: string;
    method: string;
    query: URLSearchParams;
    body: Record<string, unknown>;
}

/**
 * An OpenCode 2.2.2 server that answers over `fetch` and streams the events the
 * test emits: `/api` routes, the workspace as `location[directory]`, events as
 * `{type, data}`, and projected messages read in pages behind a cursor.
 */
export class FakeOpenCodeV2Server {
    readonly requests: V2Request[] = [];
    readonly promptBodies: Record<string, unknown>[] = [];
    readonly permissionReplies: Array<{ path: string; body: Record<string, unknown> }> =
        [];
    readonly formReplies: Array<{
        path: string;
        method: string;
        body?: Record<string, unknown>;
    }> = [];
    readonly authenticationRequests: string[] = [];
    /**
     * Claude Agent's integration as `/integration` lists it, with the
     * connections that record a choice of Claude Code. Undefined leaves it out,
     * as OpenCode does where it cannot start a local `claude`.
     */
    claudeAgent: { connections: unknown[] } | undefined = { connections: [] };
    /** Sessions other than the native one, by id, as `GET /session/:id` answers. */
    readonly sessions = new Map<string, Record<string, unknown>>();
    /** What `/api/info` reports. */
    version = '2.2.2';
    createdSessions = 0;
    resumedSessions = 0;
    interrupts = 0;
    kills = 0;
    eventSubscriptions = 0;
    openEventStreams = 0;
    transcriptReads = 0;
    /** The status the event stream answers with. */
    eventStatus = 200;
    permissionReplyStatus = 200;
    autoInterruptOnRequest = true;
    authenticationDelayMs = 0;
    spawnEnvironment: Record<string, string | undefined> = {};
    /** The session's projected messages, oldest first, served this many to a page. */
    transcript: Record<string, unknown>[] = [];
    pageSize = 2;
    /** What `/permission/request` and `/form` list as still waiting. */
    pendingPermissions: Record<string, unknown>[] = [];
    pendingForms: Record<string, unknown>[] = [];
    config: unknown[] = [];
    mcp: unknown[][] = [];
    /** Holds each transcript read until this settles. */
    transcriptGate: Promise<void> | undefined;
    onTranscriptRead?: (() => void) | undefined;
    onPrompt?: (body: Record<string, unknown>) => void;
    onPermissionReply?: (body: Record<string, unknown>) => void;
    onFormReply?: () => void;
    private eventController?: ReadableStreamDefaultController<Uint8Array>;
    private stdoutController?: ReadableStreamDefaultController<Uint8Array>;
    private stderrController?: ReadableStreamDefaultController<Uint8Array>;
    private exit!: (code: number) => void;
    private resolvePrompted!: () => void;
    private resolveInterrupted!: () => void;
    readonly prompted = new Promise<void>((resolve) => {
        this.resolvePrompted = resolve;
    });
    readonly interrupted = new Promise<void>((resolve) => {
        this.resolveInterrupted = resolve;
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
            startupTimeoutMs: 1000,
            authenticationTimeoutMs: 1000,
        });
    }

    launch() {
        return {
            process: this.process(),
            resolveUrl: async (url: string) => url,
        };
    }

    /** The fake's `fetch`, for a session built without the adapter. */
    readonly fetcher = (input: string | URL | Request, init?: RequestInit) =>
        this.fetch(input, init);

    arrange(scenario: RunnerConformanceScenario) {
        if (scenario === 'streaming_text') {
            this.onPrompt = () => {
                const answer = this.begin();
                this.emit('session.reasoning.started', {
                    assistantMessageID: answer,
                    ordinal: 0,
                });
                this.emit('session.reasoning.ended', {
                    assistantMessageID: answer,
                    ordinal: 0,
                    text: RUNNER_CONFORMANCE_UNSAFE_VALUES[0],
                });
                this.emit('session.text.started', {
                    assistantMessageID: answer,
                    ordinal: 1,
                });
                for (const delta of ['Hello', ' world'])
                    this.emit('session.text.delta', {
                        assistantMessageID: answer,
                        ordinal: 1,
                        delta,
                    });
                this.emit('session.text.ended', {
                    assistantMessageID: answer,
                    ordinal: 1,
                    text: 'Hello world',
                });
                this.finish(answer);
                this.emit('session.execution.succeeded', {});
            };
            return;
        }
        if (scenario === 'tool_events') {
            this.onPrompt = () => {
                const answer = this.begin();
                this.tool(answer, 'call_contract', 'write', {
                    filePath: '/workspace/output.txt',
                    command: RUNNER_CONFORMANCE_UNSAFE_VALUES[2],
                });
                this.tool(answer, 'call_shell', 'bash', {
                    command: RUNNER_CONFORMANCE_SHELL_COMMAND,
                });
                this.finish(answer, {
                    tokens: { total: 12, input: 5, output: 7, reasoning: 2 },
                    cost: 0.001,
                });
                this.emit('session.execution.succeeded', {});
            };
            return;
        }
        if (scenario === 'permissions') {
            this.onPrompt = () =>
                this.emit('permission.asked', {
                    id: 'permission_contract',
                    action: 'external_directory',
                    resources: ['/outside/*'],
                    save: ['/outside/*'],
                });
            this.onPermissionReply = () => this.completeTurn('approved');
            return;
        }
        if (scenario === 'questions') {
            this.onPrompt = () =>
                this.emitForm('question_contract', [
                    {
                        key: 'target',
                        type: 'string',
                        title: 'Where should this deploy?',
                        custom: false,
                        options: [
                            { value: 'production', label: 'Production' },
                            { value: 'staging', label: 'Staging' },
                        ],
                    },
                ]);
            this.onFormReply = () => this.completeTurn('configured');
            return;
        }
        if (scenario === 'multi_turn') {
            this.onPrompt = (body) => this.completeTurn(String(body.text));
            return;
        }
        if (scenario === 'image_input') {
            this.onPrompt = () => this.completeTurn('image received');
            return;
        }
        if (scenario === 'cancellation' || scenario === 'steering') {
            this.onPrompt = () => this.emit('session.status', { status: 'busy' });
            return;
        }
        if (scenario === 'failures') {
            this.onPrompt = () =>
                this.emit('session.execution.failed', {
                    error: RUNNER_CONFORMANCE_UNSAFE_VALUES[1],
                });
            return;
        }
        this.onPrompt = () => {
            this.emit('future.event', { secret: RUNNER_CONFORMANCE_UNSAFE_VALUES[1] });
            this.completeTurn('done');
        };
    }

    emit(type: string, data: Record<string, unknown>) {
        this.eventController?.enqueue(
            new TextEncoder().encode(
                `event: ${type}\ndata: ${JSON.stringify({
                    type,
                    data: { sessionID: 'ses_native_1', ...data },
                })}\n\n`
            )
        );
    }

    emitForm(
        id: string,
        fields: Record<string, unknown>[],
        sessionID = 'ses_native_1'
    ) {
        this.emit('form.created', {
            sessionID,
            form: { id, sessionID, title: 'Choose', fields },
        });
    }

    failEventStream() {
        this.eventController?.error(new Error('native stream failure'));
    }

    /** Writes the comment OpenCode 2 sends to an open stream every 15 seconds. */
    heartbeat() {
        this.eventController?.enqueue(new TextEncoder().encode(': heartbeat\n\n'));
    }

    /** Ends the stream without an error, as a proxy that drops an idle connection does. */
    endEventStream() {
        this.eventController?.close();
    }

    /**
     * Takes up `input` and starts the assistant message that answers it,
     * returning that message's id.
     */
    begin(input = this.currentInputMessageId(), answer = this.answerFor(input)) {
        this.emit('session.inbox.delivered', { inboxID: input });
        this.emit('session.step.started', { assistantMessageID: answer });
        return answer;
    }

    /** Streams a whole text part of `answer` as deltas. */
    text(answer: string, ordinal: number, text: string, deltas = [text]) {
        this.emit('session.text.started', { assistantMessageID: answer, ordinal });
        for (const delta of deltas)
            this.emit('session.text.delta', {
                assistantMessageID: answer,
                ordinal,
                delta,
            });
        this.emit('session.text.ended', { assistantMessageID: answer, ordinal, text });
    }

    /** A tool call of `answer` from its first input to its result. */
    tool(
        answer: string,
        id: string,
        name: string,
        input: Record<string, unknown>,
        outcome: 'success' | 'failed' | 'running' = 'success'
    ) {
        this.emit('session.tool.input.started', {
            assistantMessageID: answer,
            id,
            name,
        });
        this.emit('session.tool.called', { assistantMessageID: answer, id, input });
        if (outcome === 'running') return;
        this.emit(`session.tool.${outcome}`, {
            assistantMessageID: answer,
            id,
            ...(outcome === 'success'
                ? {
                      content: [
                          { type: 'text', text: RUNNER_CONFORMANCE_UNSAFE_VALUES[3] },
                      ],
                  }
                : { error: 'permission rejected' }),
        });
    }

    /** Ends the step of `answer`. OpenCode reports the step's usage with it. */
    finish(
        answer: string,
        usage: Record<string, unknown> = STEP_USAGE,
        finish = 'stop'
    ) {
        this.emit('session.step.ended', {
            assistantMessageID: answer,
            finish,
            ...usage,
        });
    }

    /** Answers `input`, by default the latest prompt, with `text` and finishes the turn. */
    completeTurn(
        text: string,
        input = this.currentInputMessageId(),
        usage: Record<string, unknown> = STEP_USAGE
    ) {
        const answer = this.begin(input);
        this.text(answer, 0, text);
        this.finish(answer, usage);
        this.emit('session.execution.succeeded', {});
    }

    currentInputMessageId() {
        return String(this.promptBodies.at(-1)?.id);
    }

    answerFor(input: string) {
        return `answer_${input}`;
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
        const path = url.pathname;
        const method = init.method ?? 'GET';
        const body: Record<string, unknown> = init.body
            ? (record(JSON.parse(String(init.body))) ?? {})
            : {};
        this.requests.push({ path, method, query: url.searchParams, body });
        expect(new Headers(init.headers).get('Authorization')).toBe(
            `Basic ${btoa('opencode:test-password')}`
        );
        if (path === '/api/info') return Response.json({ version: this.version });
        if (path === '/api/config') return Response.json({ data: this.config });
        if (path === '/api/mcp') {
            const data = this.mcp.shift() ?? [];
            // A later listing stands for a server whose status changes next.
            if (this.mcp.length > 0)
                setTimeout(() =>
                    this.emit('mcp.status.changed', { server: 'fixture' })
                );
            return Response.json({ location: { directory: '/workspace' }, data });
        }
        if (path === '/api/credential') return Response.json({ data: [] });
        if (path === '/api/permission/request')
            return Response.json({ data: this.pendingPermissions });
        if (path === '/api/form') return Response.json({ data: this.pendingForms });
        if (path === '/api/integration') {
            this.authenticationRequests.push('methods');
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
                    ...(this.claudeAgent
                        ? [
                              {
                                  id: 'claude-agent',
                                  name: 'Claude Agent',
                                  methods: [
                                      {
                                          id: 'claude-login',
                                          type: 'external',
                                          label: 'Claude Code login (claude auth login)',
                                      },
                                  ],
                                  connections: this.claudeAgent.connections,
                              },
                          ]
                        : []),
                ],
            });
        }
        if (path === '/api/integration/claude-agent/connect/external') {
            this.claudeAgent?.connections.push({
                type: 'credential',
                method: 'external',
            });
            return new Response(null, { status: 204 });
        }
        if (path === '/api/integration/openai/connect/oauth') {
            this.authenticationRequests.push(`authorize:${body.methodID}`);
            return Response.json({
                data: {
                    attemptID: 'attempt_1',
                    url: 'https://auth.example/device',
                    instructions: 'Enter code: TEST-CODE',
                    mode: 'auto',
                },
            });
        }
        if (path === '/api/integration/openai/connect/oauth/attempt_1') {
            this.authenticationRequests.push('status');
            if (this.authenticationDelayMs) await Bun.sleep(this.authenticationDelayMs);
            return Response.json({ data: { status: 'complete' } });
        }
        if (path === '/api/session' && method === 'POST') {
            this.createdSessions += 1;
            return Response.json({ data: { id: 'ses_native_1' } });
        }
        if (path === '/api/session/ses_native_1' && method === 'GET') {
            this.resumedSessions += 1;
            return Response.json({ data: { id: 'ses_native_1' } });
        }
        if (path === '/api/session/ses_native_1/message') {
            this.transcriptReads += 1;
            this.onTranscriptRead?.();
            await this.transcriptGate;
            const page = Number(url.searchParams.get('cursor') ?? '0');
            const start = page * this.pageSize;
            return Response.json({
                data: this.transcript.slice(start, start + this.pageSize),
                cursor: {
                    next:
                        start + this.pageSize < this.transcript.length
                            ? String(page + 1)
                            : null,
                },
            });
        }
        if (path === '/api/session/ses_native_1/prompt') {
            this.promptBodies.push(body);
            this.resolvePrompted();
            queueMicrotask(() => this.onPrompt?.(body));
            return Response.json({ data: { id: body.id } });
        }
        if (path === '/api/session/ses_native_1/interrupt') {
            this.interrupts += 1;
            this.resolveInterrupted();
            if (this.autoInterruptOnRequest)
                queueMicrotask(() =>
                    this.emit('session.execution.interrupted', { reason: 'user' })
                );
            return Response.json({ data: {} });
        }
        if (/^\/api\/session\/[^/]+\/permission\/[^/]+\/reply$/.test(path)) {
            this.permissionReplies.push({ path, body });
            queueMicrotask(() => this.onPermissionReply?.(body));
            return new Response(null, { status: this.permissionReplyStatus });
        }
        if (/^\/api\/session\/[^/]+\/form\/[^/]+(?:\/reply)?$/.test(path)) {
            this.formReplies.push({
                path,
                method,
                ...(init.body ? { body } : {}),
            });
            queueMicrotask(() => this.onFormReply?.());
            return new Response(null, { status: 204 });
        }
        if (path === '/api/event') {
            this.eventSubscriptions += 1;
            if (this.eventStatus !== 200)
                return new Response(null, { status: this.eventStatus });
            this.openEventStreams += 1;
            let open = true;
            const closed = () => {
                if (open) this.openEventStreams -= 1;
                open = false;
            };
            return new Response(
                new ReadableStream<Uint8Array>({
                    start: (controller) => {
                        this.eventController = controller;
                        init.signal?.addEventListener(
                            'abort',
                            () => {
                                closed();
                                try {
                                    controller.close();
                                } catch {
                                    // A failure test has already errored this stream.
                                }
                            },
                            { once: true }
                        );
                    },
                    cancel: closed,
                })
            );
        }
        if (path.startsWith('/api/session/') && method === 'GET') {
            const info = this.sessions.get(
                decodeURIComponent(path.slice('/api/session/'.length))
            );
            return info
                ? Response.json({ data: info })
                : new Response(null, { status: 404 });
        }
        return new Response(null, { status: 404 });
    }
}
