import { buildOpenCodeServerInvocation } from './opencode.js';
import { OpenCodeEventAdapter } from './opencode-events.js';
import { stageOpenCodeSkills } from './run.js';
import type {
    RunnerAdapterDeclaration,
    RunnerPermissionDecision,
    RunnerSession,
    RunnerSessionAdapter,
    RunnerSessionStartOptions,
    RunnerTurnResult,
} from './runner-session.js';

export const OPENCODE_SESSION_DECLARATION: RunnerAdapterDeclaration = {
    native: {
        command: 'opencode',
        verified: [{ version: '1.18.18', surfaces: ['server'] }],
    },
    capabilities: {
        streaming_text: { status: 'supported' },
        tool_events: { status: 'supported' },
        file_events: { status: 'supported' },
        usage: { status: 'supported' },
        permissions: { status: 'supported' },
        multi_turn: { status: 'supported' },
        cancellation: { status: 'supported' },
        failures: { status: 'supported' },
        unknown_events: { status: 'supported' },
    },
};

interface SpawnedRunner {
    exited: Promise<number>;
    stdout?: ReadableStream<Uint8Array>;
    stderr?: ReadableStream<Uint8Array>;
    kill(): void;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface OpenCodeSessionDependencies {
    spawn?: (
        command: string[],
        options: {
            cwd: string;
            env: Record<string, string | undefined>;
            stdin: 'ignore';
            stdout: 'pipe';
            stderr: 'pipe';
        }
    ) => SpawnedRunner;
    fetch?: Fetch;
    password?: () => string;
    startupTimeoutMs?: number;
}

export class OpenCodeSessionAdapter implements RunnerSessionAdapter {
    readonly runner = 'opencode';
    readonly declaration = OPENCODE_SESSION_DECLARATION;
    private readonly dependencies: Required<OpenCodeSessionDependencies>;

    constructor(dependencies: OpenCodeSessionDependencies = {}) {
        this.dependencies = {
            spawn: dependencies.spawn ?? defaultSpawn,
            fetch: dependencies.fetch ?? globalThis.fetch,
            password: dependencies.password ?? (() => crypto.randomUUID()),
            startupTimeoutMs: dependencies.startupTimeoutMs ?? 10_000,
        };
    }

    async start(options: RunnerSessionStartOptions): Promise<RunnerSession> {
        const staged = await stageOpenCodeSkills(options.workbench);
        const session = new OpenCodeServerSession({
            ...options,
            ...this.dependencies,
            ...(staged?.directory ? { configDirectory: staged.directory } : {}),
            cleanup: staged?.cleanup ?? (async () => {}),
        });
        try {
            await session.start();
            return session;
        } catch (error) {
            await session.close().catch(() => {});
            throw error;
        }
    }
}

interface ActiveTurn {
    adapter: OpenCodeEventAdapter;
    promise: Promise<RunnerTurnResult>;
    resolve: (result: RunnerTurnResult) => void;
    reject: (error: Error) => void;
    seenActivity: boolean;
    settled: boolean;
}

interface AlwaysPermission {
    action: string;
    resources: Set<string>;
}

class OpenCodeServerSession implements RunnerSession {
    private readonly options: RunnerSessionStartOptions &
        Required<OpenCodeSessionDependencies> & {
            configDirectory?: string;
            cleanup: () => Promise<void>;
        };
    private readonly eventAbort = new AbortController();
    private readonly closing = deferred<void>();
    private readonly streamedTextParts = new Set<string>();
    private readonly assistantTextParts = new Set<string>();
    private readonly assistantMessages = new Set<string>();
    private readonly alwaysPermissions: AlwaysPermission[] = [];
    private child: SpawnedRunner | undefined;
    private serverUrl: string | undefined;
    private nativeSessionId: string | undefined;
    private passwordValue: string | undefined;
    private eventLoop: Promise<void> | undefined;
    private stdoutLoop: Promise<void> | undefined;
    private stderrLoop: Promise<string> | undefined;
    private active: ActiveTurn | undefined;
    private closed = false;

    constructor(
        options: RunnerSessionStartOptions &
            Required<OpenCodeSessionDependencies> & {
                configDirectory?: string;
                cleanup: () => Promise<void>;
            }
    ) {
        this.options = options;
    }

    get id(): string | undefined {
        return this.nativeSessionId;
    }

    async start(): Promise<void> {
        const password = this.options.password();
        if (!password) throw new Error('OpenCode server password must not be empty');
        this.passwordValue = password;
        const invocation = buildOpenCodeServerInvocation(
            this.options.workbench,
            password,
            this.options.environment,
            this.options.configDirectory,
            this.options.workspaceDirectory
        );
        const child = this.options.spawn(invocation.command, {
            cwd: invocation.cwd,
            env: invocation.env,
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
        });
        this.child = child;
        this.stderrLoop = readLimitedText(child.stderr, 64 * 1024);
        const ready = deferred<string>();
        this.stdoutLoop = consumeLines(child.stdout, async (line) => {
            const url = line.match(/https?:\/\/127\.0\.0\.1:\d+/)?.[0];
            if (url) ready.resolve(url);
        });
        const timeout = setTimeout(
            () =>
                ready.reject(new Error('OpenCode server did not become ready in time')),
            this.options.startupTimeoutMs
        );
        void child.exited.then((code) => {
            if (!this.closed && !this.serverUrl) {
                ready.reject(new Error(`OpenCode server exited with code ${code}`));
            } else if (!this.closed) {
                this.failActive(new Error(`OpenCode server exited with code ${code}`));
            }
        });
        try {
            this.serverUrl = await ready.promise;
        } finally {
            clearTimeout(timeout);
        }

        const model = parseModel(this.options.workbench.manifest.model);
        const created = await this.requestJson('/session', {
            method: 'POST',
            body: JSON.stringify({
                title: `Workbench: ${this.options.workbench.manifest.name}`,
                model: { id: model.modelID, providerID: model.providerID },
            }),
        });
        const sessionId = string(record(created)?.id);
        if (!sessionId) throw new Error('OpenCode did not create a session');
        this.nativeSessionId = sessionId;
        await this.subscribe();
    }

    async prompt(input: string): Promise<RunnerTurnResult> {
        if (this.closed) throw new Error('runner session is closed');
        if (this.active) throw new Error('runner session is already processing a turn');
        const sessionId = this.requireSessionId();
        const turn = createActiveTurn();
        this.active = turn;
        const model = parseModel(this.options.workbench.manifest.model);
        try {
            await this.request(
                `/session/${encodeURIComponent(sessionId)}/prompt_async`,
                {
                    method: 'POST',
                    body: JSON.stringify({
                        model,
                        parts: [{ type: 'text', text: input }],
                    }),
                }
            );
        } catch (error) {
            this.failActive(asError(error));
        }
        return turn.promise.finally(() => {
            if (this.active === turn) this.active = undefined;
        });
    }

    async cancelTurn(): Promise<void> {
        if (!this.active || this.closed) return;
        await this.request(
            `/session/${encodeURIComponent(this.requireSessionId())}/abort`,
            { method: 'POST' }
        );
        this.finishActive('cancelled');
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        this.closing.resolve(undefined);
        this.finishActive('cancelled');
        this.eventAbort.abort();
        this.child?.kill();
        await Promise.allSettled([
            this.eventLoop,
            this.stdoutLoop,
            this.stderrLoop,
            this.child?.exited,
        ]);
        await this.options.cleanup();
    }

    private async subscribe(): Promise<void> {
        const response = await this.authFetch(this.endpoint('/event'), {
            signal: this.eventAbort.signal,
        });
        if (!response.ok || !response.body) {
            throw new Error(
                `OpenCode event stream failed with HTTP ${response.status}`
            );
        }
        this.eventLoop = consumeSse(response.body, async (value) => {
            await this.consumeEvent(value);
        }).catch((error) => {
            if (!this.closed && !isAbortError(error)) this.failActive(asError(error));
        });
    }

    private async consumeEvent(value: unknown): Promise<void> {
        const event = record(value);
        const type = string(event?.type);
        const properties = record(event?.properties);
        if (!type || !properties) return;

        if (type === 'permission.asked') {
            await this.answerPermission(properties);
            return;
        }

        const sessionId = string(properties.sessionID);
        if (!sessionId || sessionId !== this.nativeSessionId) return;
        if (type === 'message.updated') {
            const info = record(properties.info);
            const messageId = string(info?.id);
            if (messageId && info?.role === 'assistant') {
                this.assistantMessages.add(messageId);
            }
            return;
        }
        if (!this.active) return;
        if (type === 'session.error') {
            this.failActive(new Error('OpenCode session failed'));
            return;
        }
        if (type === 'session.status') {
            const status = string(record(properties.status)?.type);
            if (status === 'busy') this.active.seenActivity = true;
            if (status === 'idle' && this.active.seenActivity) {
                this.finishActive(this.active.adapter.summary().completionReason);
            }
            return;
        }
        if (type === 'session.idle' && this.active.seenActivity) {
            this.finishActive(this.active.adapter.summary().completionReason);
            return;
        }
        if (type === 'message.part.delta') {
            const partId = string(properties.partID);
            if (
                !this.isAssistantMessage(properties.messageID) ||
                !partId ||
                !this.assistantTextParts.has(partId)
            ) {
                return;
            }
            if (properties.field !== 'text') return;
            const delta = string(properties.delta);
            if (!delta) return;
            this.active.seenActivity = true;
            this.streamedTextParts.add(partId);
            await this.options.host.emit({
                type: 'output.text',
                data: { text: delta },
            });
            return;
        }
        if (type !== 'message.part.updated') {
            await this.options.host.emit({
                type: 'runner.event',
                data: { native_type: type },
            });
            return;
        }
        const part = record(properties.part);
        const partType = string(part?.type);
        if (!part || !partType) return;
        if (!this.isAssistantMessage(part.messageID)) return;
        this.active.seenActivity = true;
        if (partType === 'text') {
            const partId = string(part.id);
            if (partId) this.assistantTextParts.add(partId);
            const text = string(part.text);
            if (text && (!partId || !this.streamedTextParts.has(partId))) {
                await this.options.host.emit({
                    type: 'output.text',
                    data: { text },
                });
            }
            return;
        }
        const nativeType = partType.replaceAll('-', '_');
        const result = this.active.adapter.consume({
            type: nativeType === 'tool' ? 'tool_use' : nativeType,
            sessionID: sessionId,
            part,
        });
        for (const draft of result.events) {
            if (draft.type !== 'turn.completed') {
                await this.options.host.emit(draft);
            }
        }
    }

    private async answerPermission(properties: Record<string, unknown>) {
        const id = string(properties.id);
        const action = string(properties.permission);
        const sessionId = string(properties.sessionID);
        if (!id || !action || !sessionId) return;
        const resources = stringArray(properties.patterns);
        if (this.isAlwaysAllowed(action, resources)) return;
        const always = stringArray(properties.always);
        const decision = await Promise.race([
            this.options.host.requestPermission({
                id,
                action,
                resources,
                message: permissionMessage(action, resources),
                allowAlways: always.length > 0,
            }),
            this.closing.promise.then(() => undefined),
        ]);
        if (!decision || this.closed) return;
        const replied = await this.replyPermission(id, decision);
        if (replied && decision === 'allow_always') {
            this.alwaysPermissions.push({
                action,
                resources: new Set(always.length > 0 ? always : resources),
            });
        }
    }

    private async replyPermission(
        id: string,
        decision: RunnerPermissionDecision
    ): Promise<boolean> {
        const response = await this.authFetch(
            this.endpoint(`/permission/${encodeURIComponent(id)}/reply`),
            {
                method: 'POST',
                body: JSON.stringify({ reply: permissionReply(decision) }),
            }
        );
        if (response.status === 404) return false;
        if (!response.ok) {
            throw new Error(
                `OpenCode permission reply failed with HTTP ${response.status}`
            );
        }
        return true;
    }

    private isAlwaysAllowed(action: string, resources: string[]): boolean {
        if (resources.length === 0) return false;
        return this.alwaysPermissions.some(
            (permission) =>
                permission.action === action &&
                resources.every((resource) => permission.resources.has(resource))
        );
    }

    private finishActive(reason = 'completed') {
        const active = this.active;
        if (!active || active.settled) return;
        active.settled = true;
        active.resolve({ reason });
    }

    private failActive(error: Error) {
        const active = this.active;
        if (!active || active.settled) return;
        active.settled = true;
        active.reject(error);
    }

    private requireSessionId(): string {
        if (!this.nativeSessionId) throw new Error('OpenCode session is not ready');
        return this.nativeSessionId;
    }

    private isAssistantMessage(value: unknown): boolean {
        const messageId = string(value);
        return messageId !== undefined && this.assistantMessages.has(messageId);
    }

    private endpoint(path: string): URL {
        if (!this.serverUrl) throw new Error('OpenCode server is not ready');
        const url = new URL(path, this.serverUrl);
        url.searchParams.set('directory', this.options.workspaceDirectory);
        return url;
    }

    private authFetch(input: string | URL | Request, init: RequestInit = {}) {
        if (!this.passwordValue) throw new Error('OpenCode server is not ready');
        const headers = new Headers(init.headers);
        headers.set('Authorization', `Basic ${btoa(`opencode:${this.passwordValue}`)}`);
        if (init.body) headers.set('Content-Type', 'application/json');
        return this.options.fetch(input, { ...init, headers });
    }

    private async request(path: string, init: RequestInit): Promise<Response> {
        const response = await this.authFetch(this.endpoint(path), init);
        if (!response.ok) {
            throw new Error(`OpenCode request failed with HTTP ${response.status}`);
        }
        return response;
    }

    private async requestJson(path: string, init: RequestInit): Promise<unknown> {
        const response = await this.request(path, init);
        return response.json();
    }
}

function createActiveTurn(): ActiveTurn {
    let resolve!: (result: RunnerTurnResult) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<RunnerTurnResult>((accepted, rejected) => {
        resolve = accepted;
        reject = rejected;
    });
    return {
        adapter: new OpenCodeEventAdapter(),
        promise,
        resolve,
        reject,
        seenActivity: false,
        settled: false,
    };
}

function permissionReply(decision: RunnerPermissionDecision) {
    if (decision === 'allow_once') return 'once';
    if (decision === 'allow_always') return 'always';
    return 'reject';
}

function permissionMessage(action: string, resources: string[]) {
    const label = action.replaceAll('_', ' ');
    return resources.length
        ? `Allow ${label} for ${resources.join(', ')}?`
        : `Allow ${label}?`;
}

function parseModel(model: string) {
    const separator = model.indexOf('/');
    if (separator < 1 || separator === model.length - 1) {
        throw new Error(`OpenCode model must include a provider: ${model}`);
    }
    return {
        providerID: model.slice(0, separator),
        modelID: model.slice(separator + 1),
    };
}

function defaultSpawn(
    command: string[],
    options: {
        cwd: string;
        env: Record<string, string | undefined>;
        stdin: 'ignore';
        stdout: 'pipe';
        stderr: 'pipe';
    }
): SpawnedRunner {
    return Bun.spawn(command, options);
}

async function consumeLines(
    stream: ReadableStream<Uint8Array> | undefined,
    consume: (line: string) => Promise<void>
): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    for (;;) {
        const next = await reader.read();
        if (next.done) break;
        pending += decoder.decode(next.value, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) if (line.trim()) await consume(line);
    }
    pending += decoder.decode();
    if (pending.trim()) await consume(pending);
}

async function consumeSse(
    stream: ReadableStream<Uint8Array>,
    consume: (value: unknown) => Promise<void>
) {
    let data = '';
    await consumeLines(stream, async (line) => {
        if (!line.startsWith('data:')) return;
        data += line.slice(5).trimStart();
        if (!data) return;
        try {
            await consume(JSON.parse(data));
            data = '';
        } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
        }
    });
}

async function readLimitedText(
    stream: ReadableStream<Uint8Array> | undefined,
    limit: number
): Promise<string> {
    if (!stream) return '';
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let output = '';
    for (;;) {
        const next = await reader.read();
        if (next.done) break;
        if (output.length < limit) output += decoder.decode(next.value);
    }
    return output.slice(0, limit);
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((accepted, rejected) => {
        resolve = accepted;
        reject = rejected;
    });
    return { promise, resolve, reject };
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function string(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : [];
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

function isAbortError(error: unknown) {
    return error instanceof Error && error.name === 'AbortError';
}
