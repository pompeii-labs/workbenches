import type { WorkbenchEventDraft } from '../../runs/events.js';
import type {
    NormalizedRunnerInput,
    RunnerInput,
    RunnerInputDelivery,
    RunnerSession,
    RunnerSessionAdapter,
    RunnerSessionStartOptions,
    RunnerTurnResult,
} from '../session.js';
import { normalizeRunnerInput } from '../session.js';
import { CLAUDE_CODE_SESSION_DECLARATION } from './capabilities.js';
import { ClaudeCodeCost } from './cost.js';
import { ClaudeCodeEventAdapter, failureMessage, record, string } from './events.js';
import { buildClaudeCodeInvocation, type ClaudeCodeStagedPaths } from './invocation.js';
import {
    type ClaudeCodeChild,
    ClaudeCodeProcess,
    type ClaudeCodeSpawn,
} from './process.js';
import { ClaudeCodeInputRequests } from './requests.js';
import { ClaudeCodeSteering, ClaudeCodeTurn } from './turn.js';

/** What a session needs from staging, routing, and the runtime before it starts. */
export interface PreparedClaudeCodeSession {
    paths: ClaudeCodeStagedPaths;
    /** The `--settings` value: a settings file or its JSON text. */
    settings: string;
    /** Directories outside the workspace the tools may reach. */
    additionalDirectories?: string[] | undefined;
    /** The credential and route variables of the selected connection. */
    routeEnvironment: Record<string, string>;
    secureStorageDirectory: string;
    scrubSubprocessEnvironment: boolean;
    /** The host answers permissions and questions. Otherwise they are denied. */
    answersPrompts: boolean;
    maxTurns?: number | undefined;
    /** Per-turn cost from the native cumulative total. Without it, a fresh metered count. */
    cost?: ClaudeCodeCost | undefined;
    /** How this session's child starts, such as inside a runtime. Defaults to the adapter's. */
    spawn?: ClaudeCodeSpawn | undefined;
}

export interface ClaudeCodeSessionDependencies {
    /** Prepares a session the adapter starts itself with `start`. */
    prepare(options: RunnerSessionStartOptions): Promise<{
        session: PreparedClaudeCodeSession;
        cleanup(): Promise<void>;
    }>;
    spawn?: ClaudeCodeSpawn;
    /** How long a stopping child has after SIGTERM before SIGKILL. */
    stopTimeoutMs?: number;
}

export class ClaudeCodeSessionAdapter implements RunnerSessionAdapter {
    readonly runner = 'claude-code';
    readonly declaration = CLAUDE_CODE_SESSION_DECLARATION;
    private readonly spawn: ClaudeCodeSpawn;
    private readonly stopTimeoutMs: number;

    constructor(private readonly dependencies: ClaudeCodeSessionDependencies) {
        this.spawn = dependencies.spawn ?? defaultSpawn;
        this.stopTimeoutMs = dependencies.stopTimeoutMs ?? 5_000;
    }

    async start(options: RunnerSessionStartOptions): Promise<RunnerSession> {
        const prepared = await this.dependencies.prepare(options);
        return this.open(options, prepared.session, () => prepared.cleanup());
    }

    startPrepared(
        options: RunnerSessionStartOptions,
        prepared: PreparedClaudeCodeSession
    ): Promise<RunnerSession> {
        return this.open(options, prepared, async () => {});
    }

    private async open(
        options: RunnerSessionStartOptions,
        prepared: PreparedClaudeCodeSession,
        cleanup: () => Promise<void>
    ): Promise<RunnerSession> {
        const session = new ClaudeCodeSession(
            options,
            prepared,
            { spawn: this.spawn, stopTimeoutMs: this.stopTimeoutMs },
            cleanup
        );
        try {
            session.start();
            return session;
        } catch (error) {
            await session.close().catch(() => {});
            throw error;
        }
    }
}

/**
 * One Claude Code session over one long-lived `claude` process. A host turn is
 * the command its user message became: `command_lifecycle` reports it, and the
 * `result` of a native turn closes the host turn only when that command started
 * in it. A native turn no host command started, such as one Claude Code runs
 * after a background task finishes, is session activity, never a reply.
 */
class ClaudeCodeSession implements RunnerSession {
    private readonly process: ClaudeCodeProcess;
    private readonly events: ClaudeCodeEventAdapter;
    private readonly cost: ClaudeCodeCost;
    private readonly requests: ClaudeCodeInputRequests;
    private readonly steering = new ClaudeCodeSteering();
    private readonly controls = new Map<
        string,
        { resolve: () => void; reject: (error: Error) => void }
    >();
    private readonly secrets: string[];
    private nativeSessionId: string;
    private active: ClaudeCodeTurn | undefined;
    /** The commands started in the running native turn, or undefined between turns. */
    private nativeTurn: Set<string> | undefined;
    /** Main-thread tool calls of the running native turn without a result yet. */
    private readonly toolsInFlight = new Set<string>();
    private closed = false;
    private failure: Error | undefined;

    constructor(
        private readonly options: RunnerSessionStartOptions,
        prepared: PreparedClaudeCodeSession,
        child: { spawn: ClaudeCodeSpawn; stopTimeoutMs: number },
        private readonly cleanup: () => Promise<void>
    ) {
        const resumed = options.session?.nativeSessionId;
        this.nativeSessionId = resumed ?? crypto.randomUUID();
        this.process = new ClaudeCodeProcess(
            buildClaudeCodeInvocation({
                workspaceDirectory: options.workspaceDirectory,
                environment: options.environment,
                routeEnvironment: prepared.routeEnvironment,
                model: options.configuration.nativeModel,
                paths: prepared.paths,
                settings: prepared.settings,
                additionalDirectories: prepared.additionalDirectories,
                answersPrompts: prepared.answersPrompts,
                session: { id: this.nativeSessionId, resume: Boolean(resumed) },
                maxTurns: prepared.maxTurns,
                secureStorageDirectory: prepared.secureStorageDirectory,
                scrubSubprocessEnvironment: prepared.scrubSubprocessEnvironment,
            }),
            prepared.spawn ?? child.spawn,
            child.stopTimeoutMs
        );
        this.cost = prepared.cost ?? ClaudeCodeCost.fresh();
        this.events = new ClaudeCodeEventAdapter({ cost: this.cost });
        this.requests = new ClaudeCodeInputRequests(
            options.host,
            (response) => this.write({ type: 'control_response', response }),
            prepared.answersPrompts
        );
        this.secrets = Object.values(prepared.routeEnvironment);
    }

    get id(): string {
        return this.nativeSessionId;
    }

    start(): void {
        void this.process
            .start((line) => this.consumeLine(line))
            .then((exit) => {
                if (this.closed) return;
                this.fail(
                    new Error(
                        failureMessage(
                            [
                                this.process.exitDetail(),
                                'code' in exit
                                    ? `Claude Code exited with code ${exit.code}`
                                    : `Claude Code output failed: ${exit.error.message}`,
                            ],
                            this.secrets
                        )
                    )
                );
            });
    }

    async prompt(input: RunnerInput): Promise<RunnerTurnResult> {
        if (this.closed) throw new Error('runner session is closed');
        if (this.failure) throw this.failure;
        if (this.active) throw new Error('runner session is already processing a turn');
        const normalized = normalizeRunnerInput(input);
        const turn = new ClaudeCodeTurn();
        this.active = turn;
        this.events.beginTurn();
        try {
            await this.write(userMessage(turn.command, normalized));
        } catch (error) {
            // A child that already exited fails the turn with its own reason.
            if (!this.process.exited) this.fail(asError(error));
        }
        return turn.promise.finally(() => {
            if (this.active === turn) this.active = undefined;
        });
    }

    async steer(input: RunnerInput): Promise<RunnerInputDelivery> {
        if (this.failure) throw this.failure;
        const turn = this.active;
        if (!turn || turn.settled || this.closed) {
            throw new Error('runner session is not processing a turn');
        }
        const command = crypto.randomUUID();
        const delivered = this.steering.add(
            turn,
            command,
            JSON.stringify(userMessage(command, normalizeRunnerInput(input)))
        );
        await this.writeSteering();
        return { delivered };
    }

    async cancelTurn(): Promise<void> {
        const turn = this.active;
        if (!turn || turn.settled || this.closed) return;
        turn.cancelling = true;
        try {
            await this.control({ subtype: 'interrupt', cancel_queued: true });
        } catch (error) {
            turn.cancelling = false;
            throw error;
        }
        this.endTurn(turn, 'cancelled');
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        if (this.active) this.endTurn(this.active, 'cancelled');
        this.abandon(new Error('runner session is closed'));
        try {
            await this.process.stop();
            await this.cost.flush();
        } finally {
            await this.cleanup();
        }
    }

    private async consumeLine(line: string): Promise<void> {
        let value: unknown;
        try {
            value = JSON.parse(line);
        } catch {
            value = undefined;
        }
        const event = record(value);
        if (!event) {
            await this.emit(this.events.consume(value).events);
            return;
        }
        const type = string(event.type);
        if (type === 'control_request') return this.controlRequest(event);
        if (type === 'control_cancel_request') {
            const id = string(event.request_id);
            // A host that cannot withdraw still never sends the answer.
            if (id) await this.requests.withdraw(id).catch(() => undefined);
            return;
        }
        if (type === 'control_response') return this.controlResponse(event);
        if (type === 'command_lifecycle') return this.lifecycle(event);
        if (type === 'result') return this.result(event);
        if (type === 'system' && string(event.subtype) === 'init') {
            this.nativeSessionId = string(event.session_id) ?? this.nativeSessionId;
            if (this.nativeTurn) return;
            this.nativeTurn = new Set();
            this.toolsInFlight.clear();
            await this.emit([
                { type: 'runner.event', data: { native_type: 'unprompted_turn' } },
            ]);
            return;
        }
        this.trackTools(event);
        await this.emit(this.events.consume(event, this.owned()).events);
        await this.writeSteering();
    }

    private lifecycle(event: Record<string, unknown>): void {
        const command = string(event.command_uuid);
        const state = string(event.state);
        if (!command) return;
        if (state === 'started') {
            if (!this.nativeTurn) {
                this.nativeTurn = new Set();
                this.toolsInFlight.clear();
            }
            this.nativeTurn.add(command);
            this.steering.started(command);
        } else if (state === 'cancelled') {
            this.steering.drop(
                command,
                new Error('Claude Code cancelled the steering input before taking it')
            );
            if (this.active?.command === command)
                this.endTurn(this.active, 'cancelled');
        } else if (state === 'completed' && this.active?.command === command) {
            // A result normally settles the turn first.
            this.endTurn(
                this.active,
                this.events.summary().completionReason ?? 'completed'
            );
        }
    }

    private async result(event: Record<string, unknown>): Promise<void> {
        const owned = this.owned();
        await this.emit(this.events.consume(event, owned).events);
        this.nativeSessionId = string(event.session_id) ?? this.nativeSessionId;
        this.nativeTurn = undefined;
        this.toolsInFlight.clear();
        const turn = this.active;
        if (!owned || !turn) return;
        const failure = this.events.failureDetail();
        if (turn.cancelling) this.endTurn(turn, 'cancelled');
        else if (failure) {
            this.endTurn(
                turn,
                new Error(
                    failureMessage([this.process.errorLine(), failure], this.secrets)
                )
            );
        } else {
            this.endTurn(turn, this.events.summary().completionReason ?? 'completed');
        }
    }

    private controlRequest(event: Record<string, unknown>): void {
        const id = string(event.request_id);
        const request = record(event.request);
        if (!id || !request) return;
        void this.requests.handle(id, request).catch((error) => {
            if (!this.closed) this.fail(asError(error));
        });
    }

    /** Settles a request this session sent. Anything else is Claude Code echoing a reply. */
    private controlResponse(event: Record<string, unknown>): void {
        const response = record(event.response);
        const id = string(response?.request_id);
        const pending = id ? this.controls.get(id) : undefined;
        if (!id || !pending) return;
        this.controls.delete(id);
        if (string(response?.subtype) === 'success') pending.resolve();
        else pending.reject(new Error('Claude Code rejected the interrupt'));
    }

    private async control(request: Record<string, unknown>): Promise<void> {
        const id = crypto.randomUUID();
        const acknowledged = new Promise<void>((resolve, reject) => {
            this.controls.set(id, { resolve, reject });
        });
        try {
            await this.write({ type: 'control_request', request_id: id, request });
        } catch (error) {
            this.controls.delete(id);
            throw error;
        }
        return acknowledged;
    }

    /** Writes held steering while one of the turn's tool calls is in flight. */
    private async writeSteering(): Promise<void> {
        const turn = this.active;
        if (!turn || !this.owned() || this.toolsInFlight.size === 0) return;
        for (const steer of this.steering.held(turn)) {
            this.steering.written(steer.command);
            await this.process.write(steer.line);
        }
    }

    private trackTools(event: Record<string, unknown>): void {
        if (string(event.parent_tool_use_id)) return;
        const content = record(event.message)?.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
            const value = record(block);
            if (event.type === 'assistant' && string(value?.type) === 'tool_use') {
                const id = string(value?.id);
                if (id) this.toolsInFlight.add(id);
            } else if (event.type === 'user' && string(value?.type) === 'tool_result') {
                const id = string(value?.tool_use_id);
                if (id) this.toolsInFlight.delete(id);
            }
        }
    }

    /** Whether the running native turn is the active host turn's. */
    private owned(): boolean {
        const turn = this.active;
        return Boolean(turn && !turn.settled && this.nativeTurn?.has(turn.command));
    }

    private endTurn(turn: ClaudeCodeTurn, outcome: string | Error): void {
        this.steering.turnEnded(turn);
        if (outcome instanceof Error) turn.fail(outcome);
        else turn.finish(outcome);
    }

    private async emit(drafts: WorkbenchEventDraft[]): Promise<void> {
        for (const draft of drafts) {
            if (draft.type !== 'turn.completed') await this.options.host.emit(draft);
        }
    }

    private async write(value: Record<string, unknown>): Promise<void> {
        if (this.closed) throw new Error('runner session is closed');
        await this.process.write(JSON.stringify(value));
    }

    private fail(error: Error): void {
        this.failure ??= error;
        if (this.active) this.endTurn(this.active, this.failure);
        this.abandon(this.failure);
    }

    /** Fails steering and control requests in flight and stops answering prompts. */
    private abandon(error: Error): void {
        this.steering.rejectAll(error);
        for (const pending of this.controls.values()) pending.reject(error);
        this.controls.clear();
        this.requests.close();
    }
}

/** The stream-json user message whose uuid is the host command. */
export function userMessage(command: string, input: NormalizedRunnerInput) {
    return {
        type: 'user',
        uuid: command,
        session_id: '',
        parent_tool_use_id: null,
        message: {
            role: 'user',
            content:
                input.images.length > 0
                    ? [
                          ...input.images.map((image) => ({
                              type: 'image',
                              source: {
                                  type: 'base64',
                                  media_type: image.mimeType,
                                  data: image.data,
                              },
                          })),
                          { type: 'text', text: input.text },
                      ]
                    : input.text,
        },
    };
}

/** Starts a child on this host. */
export function defaultSpawn(
    command: string[],
    options: Parameters<ClaudeCodeSpawn>[1]
): ClaudeCodeChild {
    return Bun.spawn(command, options) as unknown as ClaudeCodeChild;
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
