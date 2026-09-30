import { join } from 'node:path';
import { type RunnerContextFiles, runtimeContext } from '../runtime-context.js';
import type {
    RunnerInput,
    RunnerInputDelivery,
    RunnerSession,
    RunnerSessionStartOptions,
    RunnerTurnResult,
} from '../session.js';
import { normalizeRunnerInput } from '../session.js';
import { authenticateOpenCode } from './authentication.js';
import { OpenCodeChildren } from './children.js';
import type { OpenCodeAdapterProgress } from './events.js';
import { openCodeParts } from './input.js';
import { OpenCodeInputRequests } from './input-requests.js';
import { buildOpenCodeServerInvocation } from './invocation.js';
import type { OpenCodeFetch, OpenCodeServerLauncher } from './server.js';
import { OpenCodeServer } from './server.js';
import { deferred, withTimeout } from './timing.js';
import {
    assistantMessagesOf,
    latestUserMessageId,
    outputIdFor,
    turnEnd,
    withoutCoveredDeltas,
} from './transcript.js';
import { type ActiveTurn, createActiveTurn, OpenCodeMessageIds } from './turn.js';
import { asError, record, string } from './values.js';

/** What a session has emitted, keyed by native ids. See `progress()`. */
export interface OpenCodeProgress extends OpenCodeAdapterProgress {
    /** Characters emitted so far, by native text part id. */
    text: Record<string, number>;
}

export interface OpenCodeServerSessionOptions extends RunnerSessionStartOptions {
    context?: RunnerContextFiles;
    fetch: OpenCodeFetch;
    password: () => string;
    startupTimeoutMs: number;
    authenticationTimeoutMs: number;
    configDirectory?: string;
    nativeConfigFile?: string;
    launch: OpenCodeServerLauncher;
    cleanup: () => Promise<void>;
}

export class OpenCodeServerSession implements RunnerSession {
    private readonly options: OpenCodeServerSessionOptions;
    private runtimeReminder: string | undefined;
    private readonly closing = deferred<void>();
    private readonly server: OpenCodeServer;
    /** How many characters of each assistant text part have been emitted. */
    private readonly textProgress = new Map<string, number>();
    private readonly assistantTextParts = new Set<string>();
    private readonly messageIds = new OpenCodeMessageIds();
    private readonly children: OpenCodeChildren;
    private readonly input: OpenCodeInputRequests;
    private requests: Promise<void> = Promise.resolve();
    private nativeSessionId: string | undefined;
    private active: ActiveTurn | undefined;
    private closed = false;
    private failure: Error | undefined;
    /** Whether `failure` came from losing the event stream, which a catch-up can recover. */
    private streamFailure = false;
    /** The input message of the latest turn this session started. */
    private lastInputMessageId: string | undefined;
    /** The latest turn, kept so a catch-up continues its tool and usage bookkeeping. */
    private lastTurn: ActiveTurn | undefined;
    /** Events held while a catch-up reads the transcript. */
    private held: unknown[] | undefined;
    /** Tool and usage progress loaded by `restoreProgress`, for a turn not yet tracked. */
    private restoredAdapter: OpenCodeAdapterProgress = {
        startedTools: [],
        completedTools: [],
        finishedSteps: [],
    };

    constructor(options: OpenCodeServerSessionOptions) {
        this.options = options;
        // Put refreshed attempt facts beside the first resumed user input.
        this.runtimeReminder =
            options.context && options.session?.nativeSessionId
                ? runtimeContext(
                      options.workbench,
                      options.workspaceDirectory,
                      options.environment
                  )
                : undefined;
        this.server = new OpenCodeServer({
            workspaceDirectory: options.workspaceDirectory,
            launch: options.launch,
            fetch: options.fetch,
            password: options.password,
            startupTimeoutMs: options.startupTimeoutMs,
        });
        this.children = new OpenCodeChildren(this.server, () => this.nativeSessionId);
        this.input = new OpenCodeInputRequests({
            server: this.server,
            host: options.host,
            children: this.children,
            environment: options.environment,
            closing: this.closing.promise,
            active: () => this.active,
            closed: () => this.closed,
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
                    binding,
                    this.options.context
                ),
            (error) => this.fail(error)
        );

        if (this.options.authentication)
            await withTimeout(
                authenticateOpenCode(
                    this.server,
                    this.options.host,
                    this.options.authentication
                ),
                'OpenCode authentication did not complete in time',
                this.options.authenticationTimeoutMs
            );
        await withTimeout(
            this.openNativeSession(),
            'OpenCode session did not become ready in time',
            this.options.startupTimeoutMs
        );
    }

    private async openNativeSession(): Promise<void> {
        const sessionId = this.options.session?.nativeSessionId
            ? await this.resume(this.options.session.nativeSessionId)
            : await this.create();
        this.nativeSessionId = sessionId;
        await this.subscribe();
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
        this.lastTurn = turn;
        this.lastInputMessageId = messageId;
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
                        parts: openCodeParts(normalized, this.runtimeReminder),
                    }),
                }
            );
            this.runtimeReminder = undefined;
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

    /**
     * Picks a turn back up after this client lost its event stream, or after the
     * engine restarted, without sending anything to the model. It subscribes to
     * events again and reads the session's transcript, so output text, tool
     * activity, and usage produced while disconnected are emitted once and in
     * order, and then it follows the turn live until it completes. The returned
     * promise settles like the original `prompt` would have.
     *
     * The turn is the one a `prompt` is still waiting on, which the catch-up then
     * settles, or else the latest one this session started, or the one that began
     * at `inputMessageId`, or, on a session that has started none, the latest user
     * message in the transcript. Output text is emitted only past what this
     * session already emitted. A fresh session has emitted nothing, so it replays
     * the whole turn; events carry `message_id`, `part_id`, and `offset` so a
     * consumer that kept what it saw can skip the overlap.
     *
     * Text that arrives at the moment of reconnection can be reported at most
     * once, but a repeated delta that matches the transcript's tail can be
     * mistaken for one the transcript already holds. A turn that is not running
     * while the catch-up happens is replayed exactly.
     */
    async resumeTurn(
        options: { inputMessageId?: string } = {}
    ): Promise<RunnerTurnResult> {
        if (this.closed) throw new Error('runner session is closed');
        if (this.failure && !this.streamFailure) throw this.failure;
        const sessionId = this.requireSessionId();
        const held: unknown[] = [];
        this.held = held;
        this.failure = undefined;
        this.streamFailure = false;
        const waiting = this.active;
        let turn: ActiveTurn;
        try {
            // Listen first and read second, so nothing between the two is missed.
            await this.subscribe();
            const transcript = await this.server.requestJson(
                `/session/${encodeURIComponent(sessionId)}/message`,
                { method: 'GET' }
            );
            const messages = (Array.isArray(transcript) ? transcript : [])
                .map(record)
                .filter((message) => message !== undefined);
            const inputId =
                options.inputMessageId ??
                this.lastInputMessageId ??
                latestUserMessageId(messages);
            if (!inputId) throw new Error('OpenCode session has no turn to resume');
            turn = waiting ?? this.beginResumedTurn(inputId);
            await this.replayTranscript(turn, messages, inputId, sessionId);
            let batch = withoutCoveredDeltas(held.splice(0), messages);
            while (batch.length > 0) {
                for (const value of batch) await this.handleEvent(value);
                batch = held.splice(0);
            }
        } catch (error) {
            // A turn this call began is abandoned. One a prompt is waiting on is not.
            if (!waiting) this.active = undefined;
            throw error;
        } finally {
            this.held = undefined;
        }
        const resumed = turn;
        return resumed.promise.finally(() => {
            if (this.active === resumed) this.active = undefined;
        });
    }

    /** Starts tracking a turn that began before this call, sharing what was already reported. */
    private beginResumedTurn(inputId: string): ActiveTurn {
        const turn = createActiveTurn(inputId);
        const previous = this.lastTurn;
        if (previous?.inputMessageIds.has(inputId)) {
            turn.adapter = previous.adapter;
            for (const [native, output] of previous.assistantOutputIds) {
                turn.assistantOutputIds.set(native, output);
            }
        } else {
            turn.adapter.restore(this.restoredAdapter);
        }
        this.active = turn;
        this.lastTurn = turn;
        this.lastInputMessageId = inputId;
        return turn;
    }

    /** Emits what the transcript holds of one turn and settles the turn if it is over. */
    private async replayTranscript(
        turn: ActiveTurn,
        messages: Record<string, unknown>[],
        inputId: string,
        sessionId: string
    ): Promise<void> {
        const answers = assistantMessagesOf(messages, inputId);
        for (const answer of answers) {
            turn.assistantOutputIds.set(answer.id, outputIdFor(answer.id));
            turn.seenActivity = true;
            for (const part of answer.parts) {
                await this.applyPart(turn, record(part), sessionId);
            }
        }
        const last = answers.at(-1);
        const end = last && turnEnd(last.info);
        if (end?.kind === 'cancelled') this.finishActive('cancelled');
        else if (end?.kind === 'failed') {
            this.failActive(new Error('OpenCode session failed'));
        } else if (end?.kind === 'completed') {
            this.finishActive(turn.adapter.summary().completionReason ?? end.finish);
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
            (error) => {
                this.streamFailure = true;
                this.fail(error);
            }
        );
    }

    /** Holds events while a catch-up reads the transcript, then replays them in order. */
    private async consumeEvent(value: unknown): Promise<void> {
        if (this.held) {
            this.held.push(value);
            return;
        }
        await this.handleEvent(value);
    }

    private async handleEvent(value: unknown): Promise<void> {
        const event = record(value);
        const type = string(event?.type);
        const properties = record(event?.properties);
        if (!type || !properties) return;

        if (type === 'session.created' || type === 'session.updated') {
            await this.children.observe(record(properties.info));
            return;
        }

        if (type === 'permission.asked' || type === 'question.asked') {
            // An unanswered prompt must not block usage from other native branches.
            const active = this.active;
            this.requests = this.requests
                .then(async () => {
                    if (this.closed || !active || this.active !== active) return;
                    if (type === 'permission.asked')
                        await this.input.permission(properties);
                    else await this.input.question(properties);
                })
                .catch((error) => {
                    if (this.closed || this.active !== active) return;
                    this.fail(
                        error instanceof Error
                            ? error
                            : new Error('OpenCode input request failed')
                    );
                });
            return;
        }
        if (type === 'question.replied' || type === 'question.rejected') return;

        const sessionId = string(properties.sessionID);
        if (!sessionId) return;
        if (sessionId !== this.nativeSessionId) {
            if (this.active && (await this.children.owns(sessionId))) {
                const drafts = this.children.consume(type, properties, sessionId);
                for (const draft of drafts) await this.options.host.emit(draft);
            }
            return;
        }
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
                    this.active.assistantOutputIds.set(
                        messageId,
                        outputIdFor(messageId)
                    );
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
            await this.emitText(
                outputId,
                partId,
                delta,
                this.textProgress.get(partId) ?? 0
            );
            return;
        }
        if (type !== 'message.part.updated') {
            await this.options.host.emit({
                type: 'runner.event',
                data: { native_type: type },
            });
            return;
        }
        await this.applyPart(this.active, record(properties.part), sessionId);
    }

    /**
     * Translates one native part of the active turn into events. A part arrives
     * whole, from an update event or from the transcript, so text is emitted only
     * past what was already emitted and every other part goes through the
     * adapter, which reports each tool call and usage step once.
     */
    private async applyPart(
        turn: ActiveTurn,
        part: Record<string, unknown> | undefined,
        sessionId: string
    ): Promise<void> {
        const partType = string(part?.type);
        if (!part || !partType) return;
        const outputId = turn.assistantOutputIds.get(string(part.messageID) ?? '');
        if (!outputId) return;
        turn.seenActivity = true;
        if (partType === 'text') {
            const partId = string(part.id);
            if (partId) this.assistantTextParts.add(partId);
            const text = string(part.text);
            if (!text) return;
            if (!partId) {
                await this.options.host.emit({
                    type: 'output.text',
                    data: { id: outputId, text },
                });
                return;
            }
            const emitted = this.textProgress.get(partId) ?? 0;
            if (text.length > emitted) {
                await this.emitText(outputId, partId, text.slice(emitted), emitted);
            }
            return;
        }
        const nativeType = partType.replaceAll('-', '_');
        const result = turn.adapter.consume({
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

    /** Emits a piece of assistant text and records how far the part has been emitted. */
    private async emitText(
        outputId: string,
        partId: string,
        text: string,
        offset: number
    ): Promise<void> {
        this.textProgress.set(partId, offset + text.length);
        await this.options.host.emit({
            type: 'output.text',
            data: { id: outputId, text },
        });
    }

    /**
     * What this session has already emitted: characters of each assistant text
     * part, and the tool calls and usage steps reported. A host saves it as it
     * goes and hands it to `restoreProgress` on a session it starts after a
     * restart, so `resumeTurn` emits only what the host has not seen. It holds
     * native ids and counts, no content.
     */
    progress(): OpenCodeProgress {
        const adapter = this.lastTurn?.adapter.progress() ?? this.restoredAdapter;
        return {
            text: Object.fromEntries(this.textProgress),
            ...adapter,
        };
    }

    /** Loads progress saved by `progress()`. Call it before `resumeTurn`. */
    restoreProgress(state: OpenCodeProgress): void {
        for (const [part, length] of Object.entries(state.text)) {
            this.textProgress.set(
                part,
                Math.max(length, this.textProgress.get(part) ?? 0)
            );
            this.assistantTextParts.add(part);
        }
        this.restoredAdapter = {
            startedTools: [...state.startedTools],
            completedTools: [...state.completedTools],
            finishedSteps: [...state.finishedSteps],
        };
        this.lastTurn?.adapter.restore(this.restoredAdapter);
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
