import type { RuntimeProcessHandle } from '../../types.js';
import type { RunnerSessionHost } from '../session.js';

export interface StdinProgress {
    sessionId?: string;
    handle?: RuntimeProcessHandle;
    stdoutBytes: number;
    /** How many events of the line after `stdoutBytes` the host already received. */
    lineEvents: number;
    /** The output identity of this process across attachments. */
    outputId: string;
    answeredRequests: string[];
    turns: Array<{ offset: number; command: string }>;
    activeTurn?: string;
}

/**
 * The delivered position and host side effects of a replayable JSONL process.
 * The position is the complete lines consumed plus the events of the next line
 * whose host `emit` resolved, so progress read after any `emit` resolves counts
 * exactly the events the host received.
 */
export class StdinReplay {
    handle: RuntimeProcessHandle | undefined;
    activeTurn: string | undefined;
    readonly host: RunnerSessionHost;
    readonly outputId: string;
    private offset = 0;
    private committed: number;
    /** Events of the line being consumed that reached the host. */
    private delivered = 0;
    /** Events of the first live line that an earlier process already delivered. */
    private skip: number;
    private readonly answered: Set<string>;
    private readonly turns: Array<{ offset: number; command: string }>;
    private readonly savedTurns: number;
    private nextTurn = 0;
    private readonly waiting = new Map<string, () => void>();
    /** Requests that ran out of time while no host was attached, to withdraw once live. */
    private readonly expired: string[] = [];
    private readonly ready = Promise.withResolvers<void>();
    private replaying: boolean;
    private lineEnd: number | undefined;
    private readonly commits: Array<() => void> = [];
    private replayed: (() => void) | undefined;
    private readonly outputs = new Map<string, string>();

    /** `openTurn` rebuilds each saved turn when replay reaches its input. */
    constructor(
        private readonly target: RunnerSessionHost,
        saved: StdinProgress | undefined,
        private readonly openTurn: (command: string) => void
    ) {
        this.handle = saved?.handle;
        this.outputId = saved?.outputId ?? crypto.randomUUID();
        this.committed = saved?.stdoutBytes ?? 0;
        this.skip = saved?.lineEvents ?? 0;
        this.activeTurn = saved?.activeTurn;
        this.answered = new Set(saved?.answeredRequests);
        this.turns = saved?.turns.map((turn) => ({ ...turn })) ?? [];
        this.savedTurns = this.turns.length;
        this.replaying = this.committed > 0;
        if (!this.replaying) this.ready.resolve();
        // A start that fails first, as when the saved process is gone, never
        // waits for replay, so its failure must not go unhandled. Every caller
        // of `caughtUp` still receives it.
        void this.ready.promise.catch(() => {});
        this.host = {
            emit: async (event) => {
                if (event.type === 'output.text' && typeof event.data.id === 'string') {
                    const native = event.data.id;
                    let id = this.outputs.get(native);
                    if (!id) {
                        id = `output_${this.outputId}_${this.outputs.size}`;
                        this.outputs.set(native, id);
                    }
                    event = { ...event, data: { ...event.data, id } };
                }
                if (this.replaying) return;
                if (this.lineEnd === undefined) return target.emit(event);
                if (this.skip > 0) this.skip--;
                else await target.emit(event);
                this.delivered++;
            },
            requestPermission: (request) =>
                this.request(request.id, () => target.requestPermission(request)),
            requestQuestion: (request) =>
                this.request(request.id, () => target.requestQuestion(request)),
            withdrawRequest: async (id) => {
                this.waiting.delete(id);
                if (!this.replaying) await target.withdrawRequest?.(id);
            },
        };
    }

    get silent(): boolean {
        return this.replaying;
    }
    hasAnswer(id: string): boolean {
        return this.answered.has(id);
    }
    answeredRequest(id: string): void {
        this.answered.add(id);
    }
    caughtUp(): Promise<void> {
        return this.ready.promise;
    }

    /** The shared part of the session's progress. */
    progress(): Omit<StdinProgress, 'sessionId'> {
        return {
            ...(this.handle ? { handle: { ...this.handle } } : {}),
            stdoutBytes: this.committed,
            lineEvents: this.delivered,
            outputId: this.outputId,
            answeredRequests: [...this.answered],
            turns: this.turns.map((turn) => ({ ...turn })),
            ...(this.activeTurn ? { activeTurn: this.activeTurn } : {}),
        };
    }

    /** Opens the saved turns whose input came before any output. */
    start(): void {
        this.openSavedTurns();
    }

    /**
     * Withdraws a request the host was offered by an earlier process and that
     * timed out while no host was attached. Replay holds other withdrawals,
     * because the earlier process already sent them.
     */
    async expire(id: string): Promise<void> {
        this.waiting.delete(id);
        if (this.replaying) this.expired.push(id);
        else await this.target.withdrawRequest?.(id);
    }

    /** Runs `action` once replay reaches the saved position, or now when live. */
    afterReplay(action: () => void): void {
        if (this.replaying) this.replayed = action;
        else action();
    }

    /** Records a turn whose input is written now, at the current output position. */
    startTurn(command: string): void {
        this.turns.push({ offset: this.lineEnd ?? this.offset, command });
        this.activeTurn = command;
    }

    endTurn(command: string): void {
        this.commit(() => {
            if (this.activeTurn === command) this.activeTurn = undefined;
        });
    }

    /** Runs `action` once the line being consumed is counted, or now between lines. */
    commit(action: () => void): void {
        if (this.lineEnd === undefined) action();
        else this.commits.push(action);
    }

    /** Consumes one output line of `bytes`; a blank line only advances the position. */
    async line(
        line: string,
        bytes: number,
        consume: (line: string) => Promise<void>
    ): Promise<void> {
        this.lineEnd = this.offset + bytes;
        try {
            await this.consume(line, bytes, consume);
        } finally {
            this.lineEnd = undefined;
        }
    }

    private async consume(
        line: string,
        bytes: number,
        consume: (line: string) => Promise<void>
    ): Promise<void> {
        this.openSavedTurns();
        if (this.replaying && this.offset + bytes > this.committed) {
            throw new Error('Saved stdout progress must end at a complete line');
        }
        if (line.trim()) await consume(line);
        this.offset += bytes;
        this.delivered = 0;
        if (!this.replaying) {
            this.committed = this.offset;
            this.skip = 0;
        }
        for (const commit of this.commits.splice(0)) commit();
        this.openSavedTurns();
        if (this.replaying && this.offset === this.committed) {
            this.replaying = false;
            this.replayed?.();
            this.replayed = undefined;
            this.ready.resolve();
            for (const raise of this.waiting.values()) raise();
            this.waiting.clear();
            for (const id of this.expired.splice(0))
                void Promise.resolve(this.target.withdrawRequest?.(id)).catch(() => {});
        }
    }

    end(): void {
        if (this.replaying)
            this.ready.reject(
                new Error('Command output ended before saved stdout progress')
            );
    }

    fail(error: Error): void {
        this.ready.reject(error);
    }

    private openSavedTurns(): void {
        for (;;) {
            const turn = this.turns[this.nextTurn];
            if (
                !turn ||
                this.nextTurn >= this.savedTurns ||
                turn.offset !== this.offset
            )
                return;
            this.openTurn(turn.command);
            this.nextTurn++;
        }
    }

    private request<T>(id: string, raise: () => Promise<T>): Promise<T> {
        if (this.answered.has(id)) return new Promise(() => {});
        if (!this.replaying) return raise();
        return new Promise<T>((resolve, reject) => {
            this.waiting.set(id, () => {
                void raise().then(resolve, reject);
            });
        });
    }
}
