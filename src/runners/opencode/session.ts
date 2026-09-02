import { lstat } from 'node:fs/promises';
import type {
    RunnerAdapterDeclaration,
    RunnerInput,
    RunnerPermissionDecision,
    RunnerSession,
    RunnerSessionAdapter,
    RunnerSessionStartOptions,
    RunnerTurnResult,
} from '../session.js';
import { normalizeRunnerInput } from '../session.js';
import { stageOpenCodeSkills } from './assets.js';
import { OpenCodeEventAdapter } from './events.js';
import { buildOpenCodeServerInvocation } from './invocation.js';
import {
    type OpenCodeFetch,
    OpenCodeServer,
    type SpawnedOpenCodeServer,
    spawnOpenCodeServer,
} from './server.js';

export const OPENCODE_SESSION_DECLARATION: RunnerAdapterDeclaration = {
    native: {
        command: 'opencode',
        verified: [{ version: '1.18.22', surfaces: ['server'] }],
    },
    capabilities: {
        streaming_text: { status: 'supported' },
        tool_events: { status: 'supported' },
        file_events: { status: 'supported' },
        usage: { status: 'supported' },
        permissions: { status: 'supported' },
        multi_turn: { status: 'supported' },
        steering: { status: 'supported' },
        image_input: { status: 'supported' },
        image_generation: {
            status: 'unsupported',
            detail: 'Workbench does not yet provide a normalized image-generation tool or image output event for OpenCode.',
        },
        cancellation: { status: 'supported' },
        failures: { status: 'supported' },
        unknown_events: { status: 'supported' },
    },
};

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
    ) => SpawnedOpenCodeServer;
    fetch?: OpenCodeFetch;
    password?: () => string;
    startupTimeoutMs?: number;
}

export class OpenCodeSessionAdapter implements RunnerSessionAdapter {
    readonly runner = 'opencode';
    readonly declaration = OPENCODE_SESSION_DECLARATION;
    private readonly dependencies: Required<OpenCodeSessionDependencies>;

    constructor(dependencies: OpenCodeSessionDependencies = {}) {
        this.dependencies = {
            spawn: dependencies.spawn ?? spawnOpenCodeServer,
            fetch: dependencies.fetch ?? globalThis.fetch,
            password: dependencies.password ?? (() => crypto.randomUUID()),
            startupTimeoutMs: dependencies.startupTimeoutMs ?? 10_000,
        };
    }

    async start(options: RunnerSessionStartOptions): Promise<RunnerSession> {
        const staged = await stageOpenCodeSkills(options.workbench);
        const nativeConfigFile =
            options.workbench.runnerConfigPath &&
            (await lstat(options.workbench.runnerConfigPath)).isFile()
                ? options.workbench.runnerConfigPath
                : undefined;
        const session = new OpenCodeServerSession({
            ...options,
            ...this.dependencies,
            ...(staged?.directory ? { configDirectory: staged.directory } : {}),
            ...(nativeConfigFile ? { nativeConfigFile } : {}),
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
    inputMessageIds: Set<string>;
    assistantOutputIds: Map<string, string>;
    promise: Promise<RunnerTurnResult>;
    resolve: (result: RunnerTurnResult) => void;
    reject: (error: Error) => void;
    cancelRequested: boolean;
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
            configuration: RunnerSessionStartOptions['configuration'];
            configDirectory?: string;
            nativeConfigFile?: string;
            cleanup: () => Promise<void>;
        };
    private readonly closing = deferred<void>();
    private readonly server: OpenCodeServer;
    private readonly streamedTextParts = new Set<string>();
    private readonly assistantTextParts = new Set<string>();
    private readonly alwaysPermissions: AlwaysPermission[] = [];
    private nativeSessionId: string | undefined;
    private active: ActiveTurn | undefined;
    private closed = false;
    private failure: Error | undefined;

    constructor(
        options: RunnerSessionStartOptions &
            Required<OpenCodeSessionDependencies> & {
                configuration: RunnerSessionStartOptions['configuration'];
                configDirectory?: string;
                nativeConfigFile?: string;
                cleanup: () => Promise<void>;
            }
    ) {
        this.options = options;
        this.server = new OpenCodeServer({
            workspaceDirectory: options.workspaceDirectory,
            spawn: options.spawn,
            fetch: options.fetch,
            password: options.password,
            startupTimeoutMs: options.startupTimeoutMs,
        });
    }

    get id(): string | undefined {
        return this.nativeSessionId;
    }

    async start(): Promise<void> {
        await this.server.start(
            (password) =>
                buildOpenCodeServerInvocation(
                    this.options.workbench,
                    password,
                    this.options.environment,
                    this.options.configDirectory,
                    this.options.workspaceDirectory,
                    this.options.configuration.model,
                    this.options.nativeConfigFile
                ),
            (error) => this.fail(error)
        );

        const model = parseModel(this.options.configuration.model);
        const created = await this.server.requestJson('/session', {
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

    async prompt(input: RunnerInput): Promise<RunnerTurnResult> {
        if (this.closed) throw new Error('runner session is closed');
        if (this.failure) throw this.failure;
        if (this.active) throw new Error('runner session is already processing a turn');
        const sessionId = this.requireSessionId();
        const messageId = createMessageId();
        const turn = createActiveTurn(messageId);
        this.active = turn;
        const model = parseModel(this.options.configuration.model);
        const normalized = normalizeRunnerInput(input);
        try {
            await this.server.request(
                `/session/${encodeURIComponent(sessionId)}/prompt_async`,
                {
                    method: 'POST',
                    body: JSON.stringify({
                        messageID: messageId,
                        model,
                        parts: openCodeParts(normalized),
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

    async steer(input: RunnerInput): Promise<void> {
        if (this.closed) throw new Error('runner session is closed');
        if (this.failure) throw this.failure;
        if (!this.active) {
            throw new Error('runner session is not processing a turn');
        }
        const normalized = normalizeRunnerInput(input);
        const messageId = createMessageId();
        this.active.inputMessageIds.add(messageId);
        try {
            await this.server.request(
                `/session/${encodeURIComponent(this.requireSessionId())}/prompt_async`,
                {
                    method: 'POST',
                    body: JSON.stringify({
                        messageID: messageId,
                        model: parseModel(this.options.configuration.model),
                        parts: openCodeParts(normalized),
                    }),
                }
            );
        } catch (error) {
            this.active.inputMessageIds.delete(messageId);
            throw error;
        }
    }

    async cancelTurn(): Promise<void> {
        const active = this.active;
        if (!active || this.closed) return;
        active.cancelRequested = true;
        try {
            await this.server.request(
                `/session/${encodeURIComponent(this.requireSessionId())}/abort`,
                { method: 'POST' }
            );
            await active.promise;
        } catch (error) {
            if (!active.settled) active.cancelRequested = false;
            throw error;
        }
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        this.closing.resolve(undefined);
        this.finishActive('cancelled');
        await this.server.close();
        await this.options.cleanup();
    }

    private async subscribe(): Promise<void> {
        await this.server.subscribe(
            async (value) => this.consumeEvent(value),
            (error) => this.fail(error)
        );
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
            const parentId = string(info?.parentID);
            if (
                this.active &&
                messageId &&
                parentId &&
                info?.role === 'assistant' &&
                this.active.inputMessageIds.has(parentId)
            ) {
                if (!this.active.assistantOutputIds.has(messageId)) {
                    this.active.assistantOutputIds.set(messageId, createOutputId());
                }
                this.active.seenActivity = true;
            }
            return;
        }
        if (!this.active) return;
        if (type === 'session.error') {
            const errorName = string(record(properties.error)?.name);
            if (this.active.cancelRequested && errorName === 'MessageAbortedError') {
                return;
            }
            this.failActive(new Error('OpenCode session failed'));
            return;
        }
        if (type === 'session.status') {
            const status = string(record(properties.status)?.type);
            if (
                status === 'idle' &&
                (this.active.seenActivity || this.active.cancelRequested)
            ) {
                this.finishActive(
                    this.active.cancelRequested
                        ? 'cancelled'
                        : this.active.adapter.summary().completionReason
                );
            }
            return;
        }
        if (type === 'session.idle') {
            // OpenCode emits this legacy event in addition to session.status=idle.
            // Treating both as completion lets a delayed duplicate from a cancelled
            // turn finish the next turn. The status event is the canonical boundary.
            return;
        }
        if (type === 'message.part.delta') {
            const partId = string(properties.partID);
            const outputId = this.assistantOutputId(properties.messageID);
            if (!outputId || !partId || !this.assistantTextParts.has(partId)) {
                return;
            }
            if (properties.field !== 'text') return;
            const delta = string(properties.delta);
            if (!delta) return;
            this.active.seenActivity = true;
            this.streamedTextParts.add(partId);
            await this.options.host.emit({
                type: 'output.text',
                data: { id: outputId, text: delta },
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
        const outputId = this.assistantOutputId(part.messageID);
        if (!outputId) return;
        this.active.seenActivity = true;
        if (partType === 'text') {
            const partId = string(part.id);
            if (partId) this.assistantTextParts.add(partId);
            const text = string(part.text);
            if (text && (!partId || !this.streamedTextParts.has(partId))) {
                await this.options.host.emit({
                    type: 'output.text',
                    data: { id: outputId, text },
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
        return this.server.replyPermission(
            `/permission/${encodeURIComponent(id)}/reply`,
            { reply: permissionReply(decision) }
        );
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

    private fail(error: Error) {
        this.failure ??= error;
        this.failActive(this.failure);
    }

    private requireSessionId(): string {
        if (!this.nativeSessionId) throw new Error('OpenCode session is not ready');
        return this.nativeSessionId;
    }

    private assistantOutputId(value: unknown): string | undefined {
        const messageId = string(value);
        return messageId ? this.active?.assistantOutputIds.get(messageId) : undefined;
    }
}

function openCodeParts(input: ReturnType<typeof normalizeRunnerInput>) {
    return [
        { type: 'text', text: input.text },
        ...input.images.map((image) => ({
            type: 'file',
            mime: image.mimeType,
            url: `data:${image.mimeType};base64,${image.data}`,
            ...(image.name ? { filename: image.name } : {}),
        })),
    ];
}

function createActiveTurn(messageId: string): ActiveTurn {
    let resolve!: (result: RunnerTurnResult) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<RunnerTurnResult>((accepted, rejected) => {
        resolve = accepted;
        reject = rejected;
    });
    return {
        adapter: new OpenCodeEventAdapter(),
        inputMessageIds: new Set([messageId]),
        assistantOutputIds: new Map(),
        promise,
        resolve,
        reject,
        cancelRequested: false,
        seenActivity: false,
        settled: false,
    };
}

function createMessageId(): string {
    return `msg_${crypto.randomUUID().replaceAll('-', '')}`;
}

function createOutputId(): string {
    return `output_${crypto.randomUUID()}`;
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
