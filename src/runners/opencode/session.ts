import { join } from 'node:path';
import type {
    RunnerInput,
    RunnerInputDelivery,
    RunnerPermissionDecision,
    RunnerQuestionPrompt,
    RunnerSession,
    RunnerSessionStartOptions,
    RunnerTurnResult,
} from '../session.js';
import { normalizeRunnerInput } from '../session.js';
import { OpenCodeEventAdapter } from './events.js';
import { buildOpenCodeServerInvocation } from './invocation.js';
import { OpenCodeQuestion } from './question.js';
import type { OpenCodeFetch, OpenCodeServerLauncher } from './server.js';
import { OpenCodeServer } from './server.js';

interface ActiveTurn {
    adapter: OpenCodeEventAdapter;
    inputMessageIds: Set<string>;
    assistantOutputIds: Map<string, string>;
    steeringDeliveries: Map<string, ReturnType<typeof deferred<void>>>;
    steeringOrder: string[];
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

export interface OpenCodeServerSessionOptions extends RunnerSessionStartOptions {
    fetch: OpenCodeFetch;
    password: () => string;
    startupTimeoutMs: number;
    configDirectory?: string;
    nativeConfigFile?: string;
    launch: OpenCodeServerLauncher;
    cleanup: () => Promise<void>;
}

export class OpenCodeServerSession implements RunnerSession {
    private readonly options: OpenCodeServerSessionOptions;
    private readonly closing = deferred<void>();
    private readonly server: OpenCodeServer;
    private readonly streamedTextParts = new Set<string>();
    private readonly assistantTextParts = new Set<string>();
    private readonly alwaysPermissions: AlwaysPermission[] = [];
    private readonly questions = new OpenCodeQuestion();
    private readonly messageIds = new OpenCodeMessageIds();
    private nativeSessionId: string | undefined;
    private active: ActiveTurn | undefined;
    private closed = false;
    private failure: Error | undefined;

    constructor(options: OpenCodeServerSessionOptions) {
        this.options = options;
        this.server = new OpenCodeServer({
            workspaceDirectory: options.workspaceDirectory,
            launch: options.launch,
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
            (password, binding) =>
                buildOpenCodeServerInvocation(
                    this.options.workbench,
                    password,
                    this.options.environment,
                    this.options.configDirectory,
                    this.options.workspaceDirectory,
                    this.options.configuration.model,
                    this.options.nativeConfigFile,
                    this.options.session
                        ? join(this.options.session.directory, 'opencode.sqlite')
                        : undefined,
                    binding
                ),
            (error) => this.fail(error)
        );

        if (this.options.authentication) {
            await this.authenticate(this.options.authentication);
        }

        const sessionId = this.options.session?.nativeSessionId
            ? await this.resume(this.options.session.nativeSessionId)
            : await this.create();
        this.nativeSessionId = sessionId;
        await this.subscribe();
    }

    private async authenticate(
        authentication: NonNullable<OpenCodeServerSessionOptions['authentication']>
    ): Promise<void> {
        if (authentication.authenticationMethod !== 'oauth') {
            throw new Error(
                `OpenCode ${authentication.authenticationMethod ?? 'native'} authentication cannot be completed during a Workbench run yet`
            );
        }
        const methods = record(await this.server.authenticationMethods());
        const available = methods?.[authentication.nativeProvider];
        if (!Array.isArray(available)) {
            throw new Error(
                `OpenCode did not expose authentication methods for ${authentication.nativeProvider}`
            );
        }
        const method = available.findIndex((value) => {
            const candidate = record(value);
            return (
                candidate?.type === 'oauth' &&
                (!authentication.nativeMethod ||
                    candidate.label === authentication.nativeMethod)
            );
        });
        if (method < 0) {
            throw new Error(
                authentication.nativeMethod
                    ? `OpenCode did not expose the configured authentication method: ${authentication.nativeMethod}`
                    : `OpenCode did not expose a compatible OAuth method for ${authentication.nativeProvider}`
            );
        }
        const authorization = record(
            await this.server.authorizeProvider(authentication.nativeProvider, method)
        );
        const url = string(authorization?.url);
        const instructions = string(authorization?.instructions);
        if (!url || authorization?.method !== 'auto') {
            throw new Error(
                `OpenCode did not expose a supported headless authentication flow for ${authentication.nativeProvider}`
            );
        }
        await this.options.host.emit({
            type: 'authentication.requested',
            data: {
                provider: authentication.provider,
                native_provider: authentication.nativeProvider,
                url,
                ...(instructions ? { instructions } : {}),
            },
        });
        await this.server.completeProviderAuthorization(
            authentication.nativeProvider,
            method
        );
        await this.options.host.emit({
            type: 'authentication.completed',
            data: {
                provider: authentication.provider,
                native_provider: authentication.nativeProvider,
            },
        });
    }

    private async create(): Promise<string> {
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
        return sessionId;
    }

    private async resume(sessionId: string): Promise<string> {
        const resumed = await this.server.requestJson(
            `/session/${encodeURIComponent(sessionId)}`,
            { method: 'GET' }
        );
        if (string(record(resumed)?.id) !== sessionId) {
            throw new Error(`OpenCode session is unavailable: ${sessionId}`);
        }
        return sessionId;
    }

    async prompt(input: RunnerInput): Promise<RunnerTurnResult> {
        if (this.closed) throw new Error('runner session is closed');
        if (this.failure) throw this.failure;
        if (this.active) throw new Error('runner session is already processing a turn');
        const sessionId = this.requireSessionId();
        const messageId = this.messageIds.next();
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

    async steer(input: RunnerInput): Promise<RunnerInputDelivery> {
        if (this.closed) throw new Error('runner session is closed');
        if (this.failure) throw this.failure;
        if (!this.active) {
            throw new Error('runner session is not processing a turn');
        }
        const normalized = normalizeRunnerInput(input);
        const messageId = this.messageIds.next();
        const delivery = deferred<void>();
        void delivery.promise.catch(() => {});
        this.active.inputMessageIds.add(messageId);
        this.active.steeringDeliveries.set(messageId, delivery);
        this.active.steeringOrder.push(messageId);
        void this.dispatchSteering(this.active, messageId, normalized);
        return { delivered: delivery.promise };
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
        if (type === 'question.asked') {
            await this.answerQuestion(properties);
            return;
        }
        if (type === 'question.replied' || type === 'question.rejected') return;

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
                const delivery = this.active.steeringDeliveries.get(parentId);
                if (delivery) {
                    this.deliverSteeringThrough(this.active, parentId);
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

    private async answerQuestion(properties: Record<string, unknown>) {
        const id = string(properties.id);
        const sessionId = string(properties.sessionID);
        if (!id || !sessionId || sessionId !== this.nativeSessionId) return;
        let questions: RunnerQuestionPrompt[];
        try {
            questions = this.questions.fromNative(properties.questions);
        } catch (error) {
            await this.server
                .replyQuestion(`/question/${encodeURIComponent(id)}/reject`)
                .catch(() => false);
            throw error;
        }
        const response = await Promise.race([
            this.options.host.requestQuestion({ id, questions }),
            this.closing.promise.then(() => undefined),
        ]);
        if (!response || this.closed) return;
        if (response.outcome === 'rejected') {
            await this.server.replyQuestion(
                `/question/${encodeURIComponent(id)}/reject`
            );
            return;
        }
        let answers: string[][];
        try {
            answers = this.questions.answers(questions, response);
        } catch (error) {
            await this.server
                .replyQuestion(`/question/${encodeURIComponent(id)}/reject`)
                .catch(() => false);
            throw error;
        }
        await this.server.replyQuestion(`/question/${encodeURIComponent(id)}/reply`, {
            answers,
        });
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
        this.rejectUndeliveredSteering(
            active,
            new Error('OpenCode completed before consuming steering input')
        );
        active.settled = true;
        active.resolve({ reason });
    }

    private failActive(error: Error) {
        const active = this.active;
        if (!active || active.settled) return;
        this.rejectUndeliveredSteering(active, error);
        active.settled = true;
        active.reject(error);
    }

    private rejectUndeliveredSteering(active: ActiveTurn, error: Error): void {
        for (const delivery of active.steeringDeliveries.values()) {
            delivery.reject(error);
        }
        active.steeringDeliveries.clear();
        active.steeringOrder.length = 0;
    }

    private deliverSteeringThrough(active: ActiveTurn, messageId: string): void {
        const boundary = active.steeringOrder.indexOf(messageId);
        if (boundary === -1) return;
        const delivered = active.steeringOrder.splice(0, boundary + 1);
        for (const deliveredId of delivered) {
            const delivery = active.steeringDeliveries.get(deliveredId);
            active.steeringDeliveries.delete(deliveredId);
            delivery?.resolve(undefined);
        }
    }

    private async dispatchSteering(
        active: ActiveTurn,
        messageId: string,
        input: ReturnType<typeof normalizeRunnerInput>
    ): Promise<void> {
        if (this.active !== active || active.settled) return;
        try {
            await this.server.request(
                `/session/${encodeURIComponent(this.requireSessionId())}/prompt_async`,
                {
                    method: 'POST',
                    body: JSON.stringify({
                        messageID: messageId,
                        model: parseModel(this.options.configuration.model),
                        parts: openCodeParts(input),
                    }),
                }
            );
        } catch (error) {
            active.inputMessageIds.delete(messageId);
            active.steeringOrder = active.steeringOrder.filter(
                (pendingId) => pendingId !== messageId
            );
            const delivery = active.steeringDeliveries.get(messageId);
            active.steeringDeliveries.delete(messageId);
            delivery?.reject(asError(error));
        }
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
        steeringDeliveries: new Map(),
        steeringOrder: [],
        promise,
        resolve,
        reject,
        cancelRequested: false,
        seenActivity: false,
        settled: false,
    };
}

class OpenCodeMessageIds {
    private timestamp = 0;
    private sequence = 0;

    next(): string {
        const timestamp = Date.now();
        if (timestamp !== this.timestamp) {
            this.timestamp = timestamp;
            this.sequence = 0;
        }
        this.sequence += 1;
        const ordered =
            (BigInt(timestamp) * 0x1000n + BigInt(this.sequence)) & 0xffffffffffffn;
        const prefix = ordered.toString(16).padStart(12, '0');
        const random = crypto.randomUUID().replaceAll('-', '').slice(0, 14);
        return `msg_${prefix}${random}`;
    }
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
