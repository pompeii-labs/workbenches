import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HostCredentialFiles } from './credentials.js';
import {
    type NativeCredentialEntry,
    NativeCredentialFile,
} from './nativecredentials.js';
import type { ConnectionTarget } from './targets.js';

export interface HostSignInDependencies {
    which?: (name: string) => string | null;
    /** Runs a command attached to this terminal and resolves its exit code. */
    interact?: (
        command: string[],
        env: Record<string, string | undefined>
    ) => Promise<number>;
}

/**
 * Runs a runner's documented command-line login on this host against a private
 * temporary data home, then keeps only the target provider's entry. The
 * user's own runner sign-in is never touched. Only OpenCode has a
 * command-line login; Pi signs in from inside its interactive session.
 */
export class HostSignIn {
    readonly #which: NonNullable<HostSignInDependencies['which']>;
    readonly #interact: NonNullable<HostSignInDependencies['interact']>;

    constructor(dependencies: HostSignInDependencies = {}) {
        this.#which = dependencies.which ?? Bun.which;
        this.#interact =
            dependencies.interact ??
            ((command, env) =>
                Bun.spawn(command, {
                    env,
                    stdin: 'inherit',
                    stdout: 'inherit',
                    stderr: 'inherit',
                }).exited);
    }

    available(target: ConnectionTarget): boolean {
        return target.harness === 'opencode' && Boolean(this.#which('opencode'));
    }

    /** The provider's entry from a fresh login, or undefined when none was made. */
    async run(
        target: ConnectionTarget,
        environment: Record<string, string | undefined>
    ): Promise<NativeCredentialEntry | undefined> {
        const executable = this.#which('opencode');
        if (target.harness !== 'opencode' || !executable) {
            throw new Error(
                `${target.harness} has no command-line sign-in on this machine`
            );
        }
        // mkdtemp creates the directory 0700, so the login's files stay private.
        const directory = await mkdtemp(join(tmpdir(), 'workbench-signin-'));
        // Ctrl-C reaches the login in the same process group and ends it. wb
        // ignores the signal meanwhile, so the cleanup below always runs.
        const ignore = () => {};
        process.on('SIGINT', ignore);
        process.on('SIGTERM', ignore);
        try {
            const code = await this.#interact(
                [
                    executable,
                    'auth',
                    'login',
                    '--provider',
                    target.method.nativeProvider,
                    ...(target.method.nativeMethod
                        ? ['--method', target.method.nativeMethod]
                        : []),
                ],
                { ...environment, XDG_DATA_HOME: directory }
            );
            if (code !== 0) return undefined;
            return await NativeCredentialFile.for('opencode').find(
                new HostCredentialFiles(directory),
                target.method.nativeProvider
            );
        } finally {
            await rm(directory, { recursive: true, force: true }).finally(() => {
                process.off('SIGINT', ignore);
                process.off('SIGTERM', ignore);
            });
        }
    }
}
