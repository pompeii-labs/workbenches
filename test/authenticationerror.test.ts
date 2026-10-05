import { describe, expect, test } from 'bun:test';
import { AuthenticationRequiredError } from '../src/connections/error.js';
import { RuntimeError } from '../src/runtimes/error.js';
import { SmokeReport } from '../src/runtimes/smokereport.js';
import type { ResolvedWorkbench } from '../src/types.js';

describe('AuthenticationRequiredError', () => {
    test('carries a stable code and exit code 3', () => {
        const error = new AuthenticationRequiredError('connect first');
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe('connect first');
        expect(error.code).toBe('authentication_required');
        expect(error.exitCode).toBe(3);
    });

    test('survives runtime error wrapping', () => {
        const error = new AuthenticationRequiredError('E2B_API_KEY is required');
        expect(RuntimeError.from('e2b', 'prepare', error)).toBe(error);
        expect(RuntimeError.from('e2b', 'prepare', new Error('boom'))).toBeInstanceOf(
            RuntimeError
        );
    });

    test('crosses a process boundary as run.failed event fields', () => {
        const error = new AuthenticationRequiredError('connect first');
        const data = {
            message: error.message,
            ...AuthenticationRequiredError.failure(error),
        };
        expect(data).toEqual({
            message: 'connect first',
            code: 'authentication_required',
            exit_code: 3,
        });
        const restored = AuthenticationRequiredError.fromFailure(data);
        expect(restored).toBeInstanceOf(AuthenticationRequiredError);
        expect(restored?.message).toBe('connect first');
        expect(AuthenticationRequiredError.exitCodeFor(data)).toBe(3);
    });

    test('adds nothing for other failures, even a runner that exits 3', () => {
        expect(AuthenticationRequiredError.failure(new Error('boom'))).toEqual({});
        const runnerExit = { message: 'opencode exited with code 3', exit_code: 3 };
        expect(AuthenticationRequiredError.fromFailure(runnerExit)).toBeUndefined();
        expect(AuthenticationRequiredError.exitCodeFor(runnerExit)).toBe(1);
        expect(AuthenticationRequiredError.exitCodeFor(undefined)).toBe(1);
    });
});

describe('SmokeReport', () => {
    const workbench = {
        manifest: { name: 'core', version: '1.2.3', runtime: 'local' },
    } as unknown as ResolvedWorkbench;

    test('maps statuses to exit codes', () => {
        const needsAuth = SmokeReport.failed(
            workbench,
            new AuthenticationRequiredError('DAYTONA_API_KEY is required')
        );
        expect(needsAuth.toJSON()).toMatchObject({
            status: 'needs-auth',
            workbench: 'core',
            version: '1.2.3',
            error: {
                code: 'authentication_required',
                message: 'DAYTONA_API_KEY is required',
            },
        });
        expect(needsAuth.exitCode).toBe(3);
        const failed = SmokeReport.failed(workbench, new Error('bad manifest'));
        expect(failed.toJSON()).toMatchObject({
            status: 'failed',
            error: { code: 'smoke_failed', message: 'bad manifest' },
        });
        expect(failed.exitCode).toBe(1);
    });
});
