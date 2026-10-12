import type { RunnerTurnResult } from '../session.js';

/**
 * One host turn: the user message Claude Code knows as a command, and the
 * promise `prompt` returns. It settles once.
 */
export class ClaudeCodeTurn {
    readonly command = crypto.randomUUID();
    readonly promise: Promise<RunnerTurnResult>;
    cancelling = false;
    private done = false;
    private resolve!: (result: RunnerTurnResult) => void;
    private reject!: (error: Error) => void;

    constructor() {
        this.promise = new Promise((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
        });
    }

    get settled(): boolean {
        return this.done;
    }

    finish(reason: string): void {
        if (this.done) return;
        this.done = true;
        this.resolve({ reason });
    }

    fail(error: Error): void {
        if (this.done) return;
        this.done = true;
        this.reject(error);
    }
}

interface Steer {
    turn: ClaudeCodeTurn;
    line: string;
    written: boolean;
    resolve: () => void;
    reject: (error: Error) => void;
}

/**
 * Steering inputs by command id. Claude Code folds a message into the running
 * turn only at a tool-result boundary, so a steer is written only while a tool
 * call is in flight and is otherwise held. It is delivered when Claude Code
 * starts it. A held steer fails when its turn ends, which hands it back to the
 * host's own follow-up queue instead of silently becoming a later turn.
 */
export class ClaudeCodeSteering {
    private readonly steers = new Map<string, Steer>();

    add(turn: ClaudeCodeTurn, command: string, line: string): Promise<void> {
        let resolve!: () => void;
        let reject!: (error: Error) => void;
        const delivered = new Promise<void>((accepted, rejected) => {
            resolve = accepted;
            reject = rejected;
        });
        // A caller that never awaits the delivery must not surface its failure.
        void delivered.catch(() => {});
        this.steers.set(command, { turn, line, written: false, resolve, reject });
        return delivered;
    }

    /** The turn's steers not written yet, in order, each with its command id. */
    held(turn: ClaudeCodeTurn): Array<{ command: string; line: string }> {
        return [...this.steers.entries()]
            .filter(([, steer]) => steer.turn === turn && !steer.written)
            .map(([command, steer]) => ({ command, line: steer.line }));
    }

    written(command: string): void {
        const steer = this.steers.get(command);
        if (steer) steer.written = true;
    }

    started(command: string): void {
        const steer = this.steers.get(command);
        if (!steer) return;
        this.steers.delete(command);
        steer.resolve();
    }

    drop(command: string, error: Error): void {
        const steer = this.steers.get(command);
        if (!steer) return;
        this.steers.delete(command);
        steer.reject(error);
    }

    /** Fails the turn's held steers. A written steer still settles natively. */
    turnEnded(turn: ClaudeCodeTurn): void {
        for (const { command } of this.held(turn)) {
            this.drop(
                command,
                new Error(
                    'The turn ended before Claude Code could take the steering input'
                )
            );
        }
    }

    rejectAll(error: Error): void {
        for (const command of [...this.steers.keys()]) this.drop(command, error);
    }
}
