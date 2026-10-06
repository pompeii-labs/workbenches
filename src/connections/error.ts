/**
 * No authenticated model route or runtime credential is available. The CLI
 * exits 3 for this error so automation can tell "connect first" from a failure.
 */
export class AuthenticationRequiredError extends Error {
    static readonly code = 'authentication_required';
    static readonly exitCode = 3;

    readonly code = AuthenticationRequiredError.code;
    readonly exitCode = AuthenticationRequiredError.exitCode;

    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'AuthenticationRequiredError';
    }

    /**
     * Event fields that let another process restore this error from a failed
     * run. Any other error contributes nothing.
     */
    static failure(error: unknown): { code?: string; exit_code?: number } {
        return error instanceof AuthenticationRequiredError
            ? { code: AuthenticationRequiredError.code, exit_code: error.exitCode }
            : {};
    }

    /** Restores the error from a `run.failed` event payload, if it carries one. */
    static fromFailure(data: unknown): AuthenticationRequiredError | undefined {
        if (typeof data !== 'object' || data === null) return undefined;
        if (Reflect.get(data, 'code') !== AuthenticationRequiredError.code) {
            return undefined;
        }
        const message = Reflect.get(data, 'message');
        return new AuthenticationRequiredError(
            typeof message === 'string' ? message : 'Authentication is required'
        );
    }

    /** The process exit code for a failed run's event payload. */
    static exitCodeFor(data: unknown): number {
        return AuthenticationRequiredError.fromFailure(data)?.exitCode ?? 1;
    }
}
