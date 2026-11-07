import type { WorkbenchEventDraft } from '../../runs/events.js';
import { RunnerProcessExit } from '../exit.js';
import type {
    RunnerInput,
    RunnerInputDelivery,
    RunnerSession,
    RunnerSessionStartOptions,
    RunnerTurnResult,
} from '../session.js';
import { normalizeRunnerInput } from '../session.js';
import { StdinReplay } from '../stdin/progress.js';
import type { PreparedClaudeCodeSession } from './adapter.js';
import { ClaudeCodeCost } from './cost.js';
import { ClaudeCodeEventAdapter, failureMessage, record, string } from './events.js';
import { userMessage } from './input.js';
import { ClaudeCodeInterrupts } from './interrupts.js';
import { buildClaudeCodeInvocation } from './invocation.js';
import { type OpenRouterAccess, OpenRouterCharges } from './openrouter.js';
import { ClaudeCodeProcess, type ClaudeCodeSpawn } from './process.js';
import type { ClaudeCodeProgress } from './progress.js';
import { ClaudeCodeInputRequests } from './requests.js';
import { ClaudeCodeSteering, ClaudeCodeTurn } from './turn.js';

/**
 * One Claude Code session over one long-lived `claude` process. A host turn is
 * the command its user message became: `command_lifecycle` reports it, and the
 * `result` of a native turn closes the host turn only when that command started
 * in it. A native turn no host command started, such as one Claude Code runs
 * after a background task finishes, is session activity, never a reply.
 */
export class ClaudeCodeSession implements RunnerSession {
    private readonly replay: StdinReplay;
    private readonly saved: ClaudeCodeProgress | undefined;
    private readonly process: ClaudeCodeProcess;
    private readonly events: ClaudeCodeEventAdapter;
    private readonly cost: ClaudeCodeCost;
    private readonly costBaseline: number;
    private readonly charges: OpenRouterCharges | undefined;
    private readonly requests: ClaudeCodeInputRequests;
    private readonly steering = new ClaudeCodeSteering();
    private steeringWrites: Promise<void> = Promise.resolve();
    private readonly controls: ClaudeCodeInterrupts;
    private readonly secrets: string[];
    private nativeSessionId: string;
    private active: ClaudeCodeTurn | undefined;
    private resumable: ClaudeCodeTurn | undefined;
    /** The commands started in the running native turn, or undefined between turns. */
    private nativeTurn: Set<string> | undefined;
    /** Main-thread tool calls of the running native turn without a result yet. */
    private readonly toolsInFlight = new Set<string>();
    private closed = false;
    private failure: Error | undefined;

    constructor(
        options: RunnerSessionStartOptions,
        prepared: PreparedClaudeCodeSession,
        child: {
            spawn: ClaudeCodeSpawn;
            stopTimeoutMs: number;
            openRouter: OpenRouterAccess;
        },
        private readonly cleanup: () => Promise<void>
    ) {
        const saved = options.progress;
        if (saved && saved.runner !== 'claude-code')
            throw new Error('Expected Claude Code progress');
        const progress = saved as ClaudeCodeProgress | undefined;
        this.saved = progress;
        this.replay = new StdinReplay(options.host, progress, (command) => {
            this.active = new ClaudeCodeTurn(command);
            this.events.beginTurn();
        });
        const resumed = progress?.sessionId ?? options.session?.nativeSessionId;
        if (
            progress?.sessionId &&
            options.session?.nativeSessionId &&
            progress.sessionId !== options.session.nativeSessionId
        )
            throw new Error('Claude Code progress belongs to another session');
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
        this.cost =
            prepared.cost ??
            ClaudeCodeCost.fresh(prepared.openRouterKey ? 'charged' : 'metered');
        this.costBaseline = progress?.costBaseline ?? this.cost.total();
        if (progress) this.cost.replay(this.costBaseline);
        // Charges arrive between lines and only once replay is over, so they
        // reach the host directly.
        this.charges = prepared.openRouterKey
            ? new OpenRouterCharges(prepared.openRouterKey, child.openRouter, (event) =>
                  options.host.emit(event)
              )
            : undefined;
        this.events = new ClaudeCodeEventAdapter({ cost: this.cost });
        this.requests = new ClaudeCodeInputRequests(
            this.replay.host,
            async (response) => {
                if (this.replay.silent) return;
                await this.write({ type: 'control_response', response });
                this.replay.answeredRequest(response.request_id);
            },
            prepared.answersPrompts
        );
        this.controls = new ClaudeCodeInterrupts(
            (value) => this.write(value),
            (accepted) => {
                if (!this.active) return;
                if (accepted) this.endTurn(this.active, 'cancelled');
                else this.active.cancelling = false;
            }
        );
        if (progress) this.controls.restore(progress.pendingInterrupts);
        this.secrets = Object.values(prepared.routeEnvironment);
    }

    get id(): string {
        return this.nativeSessionId;
    }

    async start(): Promise<void> {
        this.replay.start();
        void this.process
            .start((line, bytes) =>
                this.replay.line(line, bytes, (value) => this.consumeLine(value))
            )
            .then((exit) => {
                this.replay.end();
                if (this.closed) return;
                this.fail(
                    new Error(
                        failureMessage(
                            [
                                this.process.exitDetail(),
                                'code' in exit
                                    ? new RunnerProcessExit('Claude Code').message(
                                          exit.code
                                      )
                                    : `Claude Code output failed: ${exit.error.message}`,
                            ],
                            this.secrets
                        )
                    )
                );
            })
            .catch((error) => {
                this.replay.fail(asError(error));
                this.fail(asError(error));
            });
        this.replay.afterReplay(() => {
            if (this.saved) {
                if (this.saved.activeTurn) this.resumable = this.active;
                else this.active = undefined;
                this.cost.commitReplay();
                if (this.active) {
                    this.active.cancelling = this.saved.cancelling;
                    this.steering.restore(this.active, this.saved.steering);
                }
                for (const ids of this.saved.pendingCharges) this.charges?.collect(ids);
                void this.writeSteering().catch((error) => this.fail(asError(error)));
            }
        });
        this.replay.handle = (await this.process.handle()) ?? this.replay.handle;
        if (this.saved) await this.replay.caughtUp();
    }

    progress(): ClaudeCodeProgress {
        if (this.replay.silent && this.saved) return structuredClone(this.saved);
        return {
            runner: 'claude-code',
            sessionId: this.id,
            ...this.replay.progress(),
            pendingCharges: this.charges?.progress() ?? [],
            allowedRequests: this.requests.progress(),
            steering: this.steering.progress(),
            cancelling: Boolean(
                this.active?.cancelling || this.controls.progress().length
            ),
            costBaseline: this.costBaseline,
            pendingInterrupts: this.controls.progress(),
        };
    }

    async resumeTurn(): Promise<RunnerTurnResult> {
        await this.replay.caughtUp();
        const turn = this.resumable ?? (this.active?.settled ? undefined : this.active);
        if (!turn) throw new Error('Claude Code has no turn to resume');
        return turn.promise.finally(() => {
            if (this.active === turn) this.active = undefined;
            if (this.resumable === turn) this.resumable = undefined;
        });
    }

    async prompt(input: RunnerInput): Promise<RunnerTurnResult> {
        if (this.closed) throw new Error('runner session is closed');
        if (this.failure) throw this.failure;
        if (this.active) throw new Error('runner session is already processing a turn');
        const normalized = normalizeRunnerInput(input);
        const turn = new ClaudeCodeTurn();
        this.replay.startTurn(turn.command);
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
            await this.controls.send({ subtype: 'interrupt', cancel_queued: true });
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
        this.rejectPending(new Error('runner session is closed'));
        try {
            await this.process.stop();
            // A turn stopped before its result was still billed for its model calls.
            const unfinished = this.events.takeGenerations();
            if (!this.replay.silent && unfinished.length > 0)
                this.charges?.collect(unfinished);
            await this.charges?.finish();
            await this.cost.flush();
        } finally {
            this.charges?.cancel();
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
        if (type === 'control_response')
            return this.controls.reply(event, (action) => this.replay.commit(action));
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
        // Written once the line is counted, so progress saved during the write
        // never holds this line's events without its offset.
        this.replay.commit(
            () => void this.writeSteering().catch((error) => this.fail(asError(error)))
        );
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
        const generations = this.events.takeGenerations();
        const owned = this.owned();
        await this.emit(this.events.consume(event, owned).events);
        this.nativeSessionId = string(event.session_id) ?? this.nativeSessionId;
        this.nativeTurn = undefined;
        this.toolsInFlight.clear();
        // A cancelled turn was billed too, so its charge is read like any other.
        if (!this.replay.silent)
            this.replay.commit(() => this.charges?.collect(generations));
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
        if (this.replay.silent && this.replay.hasAnswer(id)) {
            if (this.saved?.allowedRequests.includes(id))
                this.requests.restoreAllowed(id, request);
            return;
        }
        void this.requests.handle(id, request).catch((error) => {
            if (!this.closed && !this.process.exited) this.fail(asError(error));
        });
    }

    /**
     * Writes held steering while one of the turn's tool calls is in flight, one
     * write at a time, so steers reach Claude Code in the order they were held.
     */
    private writeSteering(): Promise<void> {
        const writing = this.steeringWrites.then(() => this.flushSteering());
        this.steeringWrites = writing.catch(() => undefined);
        return writing;
    }

    private async flushSteering(): Promise<void> {
        if (this.replay.silent) return;
        const turn = this.active;
        if (!turn || !this.owned() || this.toolsInFlight.size === 0) return;
        for (const steer of this.steering.held(turn)) {
            this.steering.sending(steer.command);
            await this.process.write(steer.line);
            this.steering.written(steer.command);
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
        this.replay.endTurn(turn.command);
        this.steering.turnEnded(turn);
        if (outcome instanceof Error) turn.fail(outcome);
        else turn.finish(outcome);
    }

    private async emit(drafts: WorkbenchEventDraft[]): Promise<void> {
        for (const draft of drafts) {
            if (draft.type !== 'turn.completed') await this.replay.host.emit(draft);
        }
    }

    private async write(value: Record<string, unknown>): Promise<void> {
        if (this.closed) throw new Error('runner session is closed');
        await this.process.write(JSON.stringify(value));
    }

    private fail(error: Error): void {
        this.failure ??= error;
        this.active?.fail(this.failure);
        this.rejectPending(this.failure, true);
    }

    /** Fails steering and control requests in flight and stops answering prompts. */
    private rejectPending(error: Error, retain = false): void {
        this.steering.rejectAll(error, retain);
        this.controls.rejectAll(error, retain);
        this.requests.close();
    }
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
