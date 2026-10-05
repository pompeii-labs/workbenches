import { AuthenticationRequiredError } from '../connections/error.js';
import type { RuntimePhase } from './contracts.js';

export class RuntimeError extends Error {
    readonly runtime: string;
    readonly phase: RuntimePhase;

    constructor(
        runtime: string,
        phase: RuntimePhase,
        message: string,
        options?: ErrorOptions
    ) {
        super(message, options);
        this.name = 'RuntimeError';
        this.runtime = runtime;
        this.phase = phase;
    }

    static from(
        runtime: string,
        phase: RuntimePhase,
        error: unknown
    ): RuntimeError | AuthenticationRequiredError {
        if (error instanceof AuthenticationRequiredError) return error;
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
