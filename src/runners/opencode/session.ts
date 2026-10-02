import { join } from 'node:path';
import type { RunnerContext } from '../context/files.js';
import { runtimeContext } from '../context/runtime.js';
import type {
    RunnerInput,
    RunnerInputDelivery,
    RunnerResumeOptions,
    RunnerSession,
    RunnerSessionStartOptions,
    RunnerTurnResult,
} from '../session.js';
import { normalizeRunnerInput } from '../session.js';
import { OpenCodeAuthentication } from './authentication.js';
import { OpenCodeChildren } from './children.js';
import { openCodeParts } from './input.js';
import { buildOpenCodeServerInvocation } from './invocation.js';
import { record, string } from './json.js';
import { type OpenCodeProgress, TurnProgress } from './progress.js';
import { TurnRecovery } from './recovery.js';
import { OpenCodeInputRequests } from './requests.js';
import { OpenCodeEventRouter } from './router.js';
import type { OpenCodeFetch, OpenCodeServerLauncher } from './server.js';
import { OpenCodeServer } from './server.js';
import { OpenCodeSessionState } from './state.js';
import { withTimeout } from './timing.js';
import { type ActiveTurn, createActiveTurn, OpenCodeMessageIds } from './turn.js';

export interface OpenCodeServerSessionOptions extends RunnerSessionStartOptions {
    context?: RunnerContext;
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
    private readonly state = new OpenCodeSessionState();
    private readonly server: OpenCodeServer;
    private readonly emitted: TurnProgress;
    private readonly messageIds = new OpenCodeMessageIds();
    private readonly router: OpenCodeEventRouter;
    private readonly recovery: TurnRecovery;

    constructor(options: OpenCodeServerSessionOptions) {
        this.options = options;
        this.emitted = new TurnProgress(options.host);
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
        const children = new OpenCodeChildren(this.server, () => this.state.sessionId);
        this.router = new OpenCodeEventRouter(
            this.server,
            options.host,
            this.state,
            children,
            new OpenCodeInputRequests(
                this.server,
                options.host,
                children,
                options.environment,
                this.state
            ),
            this.emitted
        );
        this.recovery = new TurnRecovery(
            this.server,
            this.state,
            this.router,
            this.emitted
        );
    }

    get id(): string | undefined {
        return this.state.sessionId;
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
            (error) => this.state.fail(error)
        );

        if (this.options.authentication)
            await withTimeout(
                new OpenCodeAuthentication(this.server, this.options.host).complete(
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
        this.state.sessionId = sessionId;
        await this.router.subscribe();
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
        const state = this.state;
        state.assertOpen();
        if (state.failure) throw state.failure;
        if (state.active)
            throw new Error('runner session is already processing a turn');
        const sessionId = state.requireSessionId();
        const messageId = this.messageIds.next();
        const turn = createActiveTurn(messageId);
        this.emitted.begin(messageId);
        state.begin(turn);
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
            state.failTurn(asError(error));
        }
        return turn.promise.finally(() => state.release(turn));
    }

    async steer(input: RunnerInput): Promise<RunnerInputDelivery> {
        const state = this.state;
        state.assertOpen();
        if (state.failure) throw state.failure;
        const active = state.active;
        if (!active) throw new Error('runner session is not processing a turn');
        const normalized = normalizeRunnerInput(input);
        const messageId = this.messageIds.next();
        active.inputMessageIds.add(messageId);
        const delivered = active.steering.add(messageId);
        void this.dispatchSteering(active, messageId, normalized);
        return { delivered };
    }

    async cancelTurn(): Promise<void> {
        const active = this.state.active;
        if (!active || this.state.closed) return;
        active.cancelRequested = true;
        try {
            await this.server.request(
                `/session/${encodeURIComponent(this.state.requireSessionId())}/abort`,
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
     * activity, and usage produced while disconnected are emitted and then it
     * follows the turn live until it completes. The returned promise settles like
     * the original `prompt` would have.
     *
     * The turn is the one a `prompt` is still waiting on, which the catch-up then
     * settles, or else the latest one this session started, or the one that began
     * at `inputMessageId`, or the one the restored progress names, or, on a
     * session that has none of these, the latest user message in the transcript.
     * It covers the turn's steering inputs and their answers. Output text is
     * emitted only past what this session already emitted; a fresh session has
     * emitted nothing, so it replays the whole turn, and events carry
     * `message_id`, `part_id`, and `offset` so a consumer that kept what it saw
     * can skip the overlap.
     *
     * A call made while another is running returns that call's promise. A
     * catch-up that fails leaves the session failed, so a later one can retry,
     * and what it already emitted is not emitted again. Text that arrives at the
     * moment of reconnection is reported at most once, but a repeated delta that
     * matches the transcript's tail can be mistaken for one the transcript
     * already holds. Closing the session while a catch-up runs ends it with an
     * error and starts nothing.
     */
    resumeTurn(options: RunnerResumeOptions = {}): Promise<RunnerTurnResult> {
        return this.recovery.resume(options);
    }

    async close(): Promise<void> {
        if (this.state.closed) return;
        this.state.closed = true;
        this.state.finish('cancelled');
        await this.server.close();
        await this.options.cleanup();
    }

    /**
     * What this session has emitted, to save while a turn runs and hand to
     * `restoreProgress` on the session started after a restart. See
     * `OpenCodeProgress` for what a host must keep and must not edit.
     */
    progress(): OpenCodeProgress {
        return this.emitted.snapshot(this.state.requireSessionId());
    }

    /**
     * Loads progress saved by `progress()`. Call it before `resumeTurn`. It
     * rejects progress saved for another session or another turn.
     */
    restoreProgress(progress: OpenCodeProgress): void {
        this.emitted.restore(
            progress,
            this.state.requireSessionId(),
            this.state.last?.inputMessageId
        );
    }

    private async dispatchSteering(
        active: ActiveTurn,
        messageId: string,
        input: ReturnType<typeof normalizeRunnerInput>
    ): Promise<void> {
        if (this.state.active !== active || active.settled) return;
        try {
            await this.server.request(
                `/session/${encodeURIComponent(this.state.requireSessionId())}/prompt_async`,
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
            active.steering.drop(messageId, asError(error));
        }
    }
}

/** Splits `provider/model` into the ids OpenCode's prompt API takes. */
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

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
