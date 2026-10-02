import type { ActiveTurn } from './turn.js';

/**
 * What a session is doing: the turn in flight, the latest turn kept after it
 * settles, and whether the session is closed or failed. The session, its event
 * router, and its recovery share one instance, and every change to a turn's
 * outcome goes through it.
 */
export class OpenCodeSessionState {
    /** The native session id, once the session is open. */
    sessionId: string | undefined;
    active: ActiveTurn | undefined;
    /** The latest turn, kept so a catch-up continues it after it settled or failed. */
    last: ActiveTurn | undefined;
    closed = false;
    failure: Error | undefined;
    /** Whether `failure` came from losing the event stream, which a catch-up can recover. */
    streamFailure = false;

    assertOpen(): void {
        if (this.closed) throw new Error('runner session is closed');
    }

    begin(turn: ActiveTurn): void {
        this.active = turn;
        this.last = turn;
    }

    /** Stops treating `turn` as in flight. */
    release(turn: ActiveTurn): void {
        if (this.active === turn) this.active = undefined;
    }

    finish(reason = 'completed'): void {
        const active = this.active;
        if (!active || active.settled) return;
        active.steering.rejectAll(
            new Error('OpenCode completed before consuming steering input')
        );
        active.settled = true;
        active.resolve({ reason });
    }

    failTurn(error: Error): void {
        const active = this.active;
        if (!active || active.settled) return;
        active.steering.rejectAll(error);
        active.settled = true;
        active.reject(error);
    }

    /** Fails the session, and the turn in flight, unless it has already failed. */
    fail(error: Error): void {
        this.failure ??= error;
        this.failTurn(this.failure);
    }

    /** The newest stream's failure replaces an older stream failure. */
    streamFailed(error: Error): void {
        if (this.streamFailure) this.failure = undefined;
        this.streamFailure = true;
        this.fail(error);
    }

    requireSessionId(): string {
        if (!this.sessionId) throw new Error('OpenCode session is not ready');
        return this.sessionId;
    }
}
