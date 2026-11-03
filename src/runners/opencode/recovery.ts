import type { RunnerResumeOptions, RunnerTurnResult } from '../session.js';
import type { TurnProgress } from './progress.js';
import { type OpenCodeEventRouter, sessionFailure } from './router.js';
import type { OpenCodeServer } from './server.js';
import type { OpenCodeSessionState } from './state.js';
import { OpenCodeTranscript, type TranscriptTurn } from './transcript.js';
import { type ActiveTurn, createActiveTurn } from './turn.js';

/**
 * Picks a turn back up after the event stream was lost or the engine restarted.
 * It subscribes again, reads the session's transcript, emits what the transcript
 * holds past what was already emitted, replays the events that arrived while it
 * read, and then follows the turn live until it settles. One recovery runs at a
 * time: a call made while another is running returns the same promise.
 */
export class TurnRecovery {
    private inflight: Promise<RunnerTurnResult> | undefined;
    private catching: Promise<ActiveTurn> | undefined;

    constructor(
        private readonly server: Pick<
            OpenCodeServer,
            'requestJson' | 'pendingRequests'
        >,
        private readonly state: OpenCodeSessionState,
        private readonly router: OpenCodeEventRouter,
        private readonly emitted: TurnProgress
    ) {}

    resume(options: RunnerResumeOptions): Promise<RunnerTurnResult> {
        this.inflight ??= this.catchUp(options)
            .then((turn) => turn.promise.finally(() => this.state.release(turn)))
            .finally(() => {
                this.inflight = undefined;
            });
        return this.inflight;
    }

    /**
     * Catches the turn up and resolves once it follows the turn live, without
     * waiting for it to settle, so a turn whose stream goes quiet again later
     * can be caught up again.
     */
    catchUp(options: RunnerResumeOptions = {}): Promise<ActiveTurn> {
        this.catching ??= this.run(options).finally(() => {
            this.catching = undefined;
        });
        return this.catching;
    }

    private async run(options: RunnerResumeOptions): Promise<ActiveTurn> {
        const state = this.state;
        state.assertOpen();
        if (state.failure && !state.streamFailure) throw state.failure;
        const sessionId = state.requireSessionId();
        const stale = state.failure;
        const waiting = state.active;
        this.router.hold();
        let turn: ActiveTurn | undefined;
        try {
            const messages = await this.read(sessionId, stale);
            const previous = state.last;
            const inputId =
                options.inputMessageId ??
                waiting?.inputMessageId ??
                previous?.inputMessageId ??
                this.emitted.inputMessageId ??
                messages.latestUserMessageId();
            if (!inputId) throw new Error('OpenCode session has no turn to resume');
            const inputIds =
                waiting?.inputMessageIds ??
                (previous?.inputMessageId === inputId ? previous.inputMessageIds : []);
            // Reading the turn first means a bad input id changes nothing.
            const replay = messages.turnOf(inputId, inputIds);
            turn = waiting ?? this.begin(inputId, inputIds);
            await this.replay(turn, replay, sessionId);
            // A request asked before the stream was lost is still waiting, and
            // the new stream will not repeat it. Unlisted, nothing changes.
            for (const request of await this.server.pendingRequests().catch(() => [])) {
                await this.router.handle(request);
                state.assertOpen();
            }
            let batch = messages.withoutCoveredDeltas(this.router.take());
            while (batch.length > 0) {
                for (const value of batch) {
                    await this.router.handle(value);
                    state.assertOpen();
                }
                batch = this.router.take();
            }
        } catch (error) {
            // A turn this call began fails with it, so nothing waits on it. One a
            // prompt is waiting on is that prompt's to settle.
            if (turn && !waiting) {
                state.failTurn(
                    error instanceof Error ? error : new Error(String(error))
                );
                state.release(turn);
            }
            throw error;
        } finally {
            this.router.release();
        }
        return turn as ActiveTurn;
    }

    /** Listens first and reads second, so nothing between the two is missed. */
    private async read(
        sessionId: string,
        stale: Error | undefined
    ): Promise<OpenCodeTranscript> {
        const state = this.state;
        let body: unknown;
        try {
            await this.router.subscribe();
            state.assertOpen();
            body = await this.server.requestJson(
                `/session/${encodeURIComponent(sessionId)}/message`,
                { method: 'GET' }
            );
        } catch (error) {
            // A session that closed meanwhile did not fail.
            state.assertOpen();
            // Without a stream and a transcript the session cannot report
            // progress, so it stays failed and a later catch-up can retry.
            state.failure = undefined;
            state.streamFailure = true;
            state.fail(error instanceof Error ? error : new Error(String(error)));
            throw error;
        }
        state.assertOpen();
        // Only now is the earlier failure over. One the new stream raised meanwhile stands.
        if (state.failure === stale) {
            state.failure = undefined;
            state.streamFailure = false;
        } else if (state.failure) {
            throw state.failure;
        }
        return new OpenCodeTranscript(body);
    }

    /** Starts tracking a turn that began before this call. */
    private begin(inputId: string, inputIds: Iterable<string>): ActiveTurn {
        const turn = createActiveTurn(inputId);
        for (const id of inputIds) turn.inputMessageIds.add(id);
        // Nothing awaits a turn that fails with its recovery.
        void turn.promise.catch(() => {});
        this.emitted.begin(inputId);
        this.state.begin(turn);
        return turn;
    }

    /** Emits what the transcript holds of the turn and settles it if it is over. */
    private async replay(
        turn: ActiveTurn,
        replay: TranscriptTurn,
        sessionId: string
    ): Promise<void> {
        await this.router.emitAnswers(turn, replay.answers, sessionId);
        const end = replay.end;
        if (end?.kind === 'cancelled') this.state.finish('cancelled');
        else if (end?.kind === 'failed') {
            this.state.failTurn(new Error(sessionFailure(end.error)));
        } else if (end?.kind === 'completed') {
            this.state.finish(this.emitted.completionReason() ?? end.finish);
        }
    }
}
