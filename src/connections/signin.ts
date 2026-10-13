import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchEnvironment } from '../platform/environment.js';
import { hostCommand } from '../platform/process.js';

import { RunnerRegistry } from '../runners/registry.js';
import type { RunnerCredentials, RunnerHostSignIn } from '../runners/runner.js';
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
    runners?: Pick<RunnerRegistry, 'find'>;
    version?: (command: string[]) => Promise<string>;
}

/**
 * Runs a runner's documented command-line login on this host against a private
 * temporary data home, then keeps only the target provider's entry. The
 * user's own runner sign-in is never touched. Only a runner that declares a
 * host sign-in has one; others must be configured separately.
 */
export class HostSignIn {
    readonly #which: NonNullable<HostSignInDependencies['which']>;
    readonly #interact: NonNullable<HostSignInDependencies['interact']>;
    readonly #runners: Pick<RunnerRegistry, 'find'>;
    readonly #version: NonNullable<HostSignInDependencies['version']>;

    constructor(dependencies: HostSignInDependencies = {}) {
        this.#which = dependencies.which ?? Bun.which;
        this.#runners = dependencies.runners ?? RunnerRegistry.standard();
        this.#version =
            dependencies.version ??
            (async (command) => {
                const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'ignore' });
                const output = await new Response(child.stdout).text();
                if ((await child.exited) !== 0)
                    throw new Error('Could not determine runner version');
                return output.trim();
            });
        this.#interact =
            dependencies.interact ??
            ((command, env) =>
                Bun.spawn(hostCommand(command, env), {
                    env: launchEnvironment(env),
                    stdin: 'inherit',
                    stdout: 'inherit',
                    stderr: 'inherit',
                }).exited);
    }

    available(target: ConnectionTarget): boolean {
        return Boolean(this.#login(target));
    }

    /** The provider's entry from a fresh login, or undefined when none was made. */
    async run(
        target: ConnectionTarget,
        environment: Record<string, string | undefined>
    ): Promise<NativeCredentialEntry | undefined> {
        const login = this.#login(target);
        if (!login) {
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
            const version = login.signIn.versionCommand
                ? await this.#version([
                      login.executable,
                      ...login.signIn.versionCommand,
                  ])
                : '';
            const env = { ...environment, ...login.credentials.environment(directory) };
            const code = await this.#interact(
                [
                    login.executable,
                    ...login.signIn.arguments(
                        target.method.nativeProvider,
                        target.method.nativeMethod,
                        version
                    ),
                ],
                env
            );
            if (code !== 0) return undefined;
            if (login.signIn.exportCredential) {
                const value = await login.signIn.exportCredential(
                    login.executable,
                    env,
                    target.method.nativeProvider,
                    version
                );
                if (value)
                    return {
                        type: typeof value.type === 'string' ? value.type : undefined,
                        value,
                    };
            }
            return await NativeCredentialFile.for(target.harness, this.#runners).find(
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

    /** The target runner's host login and the executable found for it, when it has both. */
    #login(target: ConnectionTarget):
        | {
              executable: string;
              signIn: RunnerHostSignIn;
              credentials: RunnerCredentials;
          }
        | undefined {
        const runner = this.#runners.find(target.harness);
        const signIn = runner?.connection.hostSignIn;
        const credentials = runner?.credentials;
        if (!signIn || !credentials) return undefined;
        const executable = this.#which(signIn.executable);
        return executable ? { executable, signIn, credentials } : undefined;
    }
}
