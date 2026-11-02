import type { OpenCodeServer } from './server.js';
import type { OpenCodeSessionState } from './state.js';
import type { ActiveTurn } from './turn.js';

/**
 * How long the event stream may carry nothing during a turn before it counts as
 * lost. OpenCode writes to an open stream even when nothing happens: OpenCode 1
 * sends a `server.heartbeat` event every 10 seconds and OpenCode 2 a
 * `: heartbeat` comment every 15 seconds. A minute is four missed heartbeats
 * from the slower of the two, so a stream that has been silent that long is
 * stalled, not waiting on a slow model or tool.
 */
const silenceMs = 60_000;

/** How often a turn's stream is checked, so a stall is caught at most one check after the window. */
const checkMs = 10_000;

/**
 * Notices an event stream that stays open but stops delivering while a turn
 * runs, and hands the turn to a catch-up, which subscribes again and emits what
 * the transcript holds. Without a turn in flight a quiet stream changes nothing.
 */
export class StreamWatchdog {
    private timer: ReturnType<typeof setInterval> | undefined;
    private watched: ActiveTurn | undefined;
    /** When the watched turn began to be watched or was last caught up. */
    private since = 0;
    private recovering = false;

    constructor(
        private readonly server: Pick<OpenCodeServer, 'lastStreamActivity'>,
        private readonly state: OpenCodeSessionState,
        private readonly recover: () => Promise<unknown>
    ) {}

    start(): void {
        this.timer ??= setInterval(() => this.check(), checkMs);
        this.timer.unref();
    }

    stop(): void {
        clearInterval(this.timer);
        this.timer = undefined;
    }

    private check(): void {
        const state = this.state;
        const active = state.active;
        if (this.recovering) return;
        if (!active || active.settled || state.closed || state.failure) {
            this.watched = undefined;
            return;
        }
        const now = Date.now();
        if (this.watched !== active) {
            this.watched = active;
            this.since = now;
        }
        if (now - Math.max(this.since, this.server.lastStreamActivity) < silenceMs)
            return;
        this.recovering = true;
        // A catch-up that cannot read the session fails the turn as a lost stream.
        void this.recover()
            .catch(() => {})
            .finally(() => {
                this.recovering = false;
                this.since = Date.now();
            });
    }
}
