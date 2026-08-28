import type { RuntimePhase } from './contracts.js';

export class RuntimeError extends Error {
    readonly runtime: string;
    readonly phase: RuntimePhase;

    constructor(runtime: string, phase: RuntimePhase, message: string) {
        super(message);
        this.name = 'RuntimeError';
        this.runtime = runtime;
        this.phase = phase;
    }

    static from(runtime: string, phase: RuntimePhase, error: unknown): RuntimeError {
        if (
            error instanceof RuntimeError &&
            error.runtime === runtime &&
            error.phase === phase
        ) {
            return error;
        }
        return new RuntimeError(
            runtime,
            phase,
            error instanceof Error ? error.message : String(error)
        );
    }
}
