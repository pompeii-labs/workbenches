import { confirm, password } from '@clack/prompts';

import { AuthenticationRequiredError } from '../connections/error.js';
import type { NativeCredentialEntry } from '../connections/nativecredentials.js';
import {
    type ConnectionReadiness,
    ConnectionSetup,
    type ConnectionWorkbench,
} from '../connections/setup.js';
import { HostSignIn } from '../connections/signin.js';
import { ConnectionStore } from '../connections/store.js';
import {
    type ConnectionAuthenticationMethod,
    type ConnectionTarget,
    harnessLabel,
    providerLabel,
    runtimeLabel,
} from '../connections/targets.js';
import { ActiveModelCatalog, connectCommand } from '../models/index.js';
import type { CliPresenter } from './presenter.js';

export interface ModelConnectionOptions {
    home: string;
    target: ConnectionTarget;
    workbench?: ConnectionWorkbench;
    output: CliPresenter;
    environment?: Record<string, string | undefined>;
    interactive?: boolean;
    signIn?: Pick<HostSignIn, 'available' | 'run'>;
    readKey?: () => Promise<string>;
    setup?: ConnectionSetup;
}

type CredentialSource = { entry: NativeCredentialEntry } | { advice: string };

/**
 * The terminal side of connecting one model provider: it chooses where the
 * credential comes from, asks before copying or reading a secret, and reports
 * readiness. Writing and checking the runtime's store belong to
 * `ConnectionSetup`.
 */
export class ModelConnection {
    readonly #options: ModelConnectionOptions;
    readonly #setup: ConnectionSetup;
    readonly #store: ConnectionStore;
    readonly #environment: Record<string, string | undefined>;
    readonly #interactive: boolean;

    constructor(options: ModelConnectionOptions) {
        this.#options = options;
        this.#environment = options.environment ?? process.env;
        this.#interactive =
            options.interactive ?? Boolean(process.stdin.isTTY && process.stderr.isTTY);
        this.#store = new ConnectionStore(options.home);
        this.#setup =
            options.setup ??
            new ConnectionSetup({
                home: options.home,
                target: options.target,
                environment: this.#environment,
                store: this.#store,
                ...(options.workbench ? { workbench: options.workbench } : {}),
            });
    }

    /**
     * Fills the runtime's credential store, checks it, and saves the preferred
     * route only once the route is ready. Otherwise it throws
     * `AuthenticationRequiredError` (exit 3) with the missing piece and the
     * command that fixes it, and the previous default stays.
     */
    async connect(flags: { stdin: boolean; yes: boolean }): Promise<void> {
        const { target } = this.#options;
        this.#validate(flags);
        if (target.runtime === 'local') {
            await this.#report(await this.#setup.verify(), this.#localAdvice());
            return;
        }
        if (target.runtime === 'daytona') {
            await this.#report(
                await this.#setup.verify(),
                `Set ${this.#variables() || 'the provider key'} where wb runs`
            );
            return;
        }
        const source = await this.#source(flags);
        if ('advice' in source) {
            await this.#report(await this.#setup.verify(), source.advice);
            return;
        }
        this.#options.output.progress(
            `Writing the ${this.#provider} credential for ${this.#runner} in ${this.#runtime}`
        );
        await this.#report(
            await this.#setup.save(source.entry),
            this.#options.workbench
                ? `Check what the runner reports with wb smoke ${this.#options.workbench.reference} --runtime ${target.runtime}`
                : `Run ${this.#command()} again`
        );
    }

    /**
     * Removes the target provider's entries from the runtime's store, keeping
     * others, and drops the saved default when it pointed at this provider.
     */
    async remove(methods: ConnectionAuthenticationMethod[]): Promise<void> {
        const { target, output } = this.#options;
        const removed = await this.#setup.remove([
            ...new Set(methods.map((method) => method.nativeProvider)),
        ]);
        await this.#store.forget(
            { runner: target.harness, runtime: target.runtime },
            target.provider
        );
        output.record({
            machine: [
                removed ? 'removed' : 'absent',
                target.runtime,
                target.harness,
                target.provider,
            ],
            title: removed
                ? `Removed ${this.#provider} from ${this.#runner} credentials in ${this.#runtime}`
                : `No ${this.#provider} credential was saved for ${this.#runner} in ${this.#runtime}`,
            tone: removed ? 'success' : 'muted',
        });
    }

    /** Rejects flags that would have no effect, before anything is read or written. */
    #validate(flags: { stdin: boolean; yes: boolean }): void {
        const { target } = this.#options;
        if (flags.stdin || flags.yes) this.#setup.requireStore();
        if (flags.stdin && target.method.authenticationMethod === 'oauth') {
            throw new Error(
                `--stdin reads an API key, but ${target.method.label} is a sign-in. Choose an API-key method with --method`
            );
        }
        if (flags.yes && flags.stdin) {
            throw new Error(
                '--yes copies a local API key, so it cannot be combined with --stdin'
            );
        }
        if (flags.yes && target.method.authenticationMethod === 'oauth') {
            throw new Error(
                `--yes copies a local API key, but ${target.method.label} always signs in fresh`
            );
        }
    }

    async #source(flags: { stdin: boolean; yes: boolean }): Promise<CredentialSource> {
        const { target } = this.#options;
        const method = target.method.authenticationMethod;
        if (flags.stdin) {
            return { entry: this.#setup.file.apiKey(await this.#stdinKey()) };
        }
        // Only an API key is offered for copying; sign-ins below are always fresh.
        const host = await this.#setup.hostApiKey();
        if (host && flags.yes) return { entry: host };
        if (host && !this.#interactive) {
            return {
                advice: `Copy your local ${this.#runner} ${this.#provider} API key with ${this.#command(['--yes'])}`,
            };
        }
        if (host) {
            const reuse = await confirm({
                message: `Use your local ${this.#provider} API key in ${this.#runtime}?`,
                initialValue: true,
            });
            if (typeof reuse === 'symbol')
                throw new Error('Connection setup cancelled');
            if (reuse) return { entry: host };
        }
        const signIn = this.#options.signIn ?? new HostSignIn();
        const canSignIn = this.#interactive && signIn.available(target);
        if (canSignIn && method !== 'api') {
            const entry = await signIn.run(target, this.#environment);
            return entry
                ? { entry }
                : {
                      advice: `${this.#runner} sign-in saved no ${this.#provider} credential. Try again with ${this.#command()}`,
                  };
        }
        if (method === 'oauth') return { advice: this.#signInAdvice() };
        if (!this.#interactive) {
            return {
                advice: `Pass the ${this.#provider} API key on standard input: ${this.#command(['--stdin'])}`,
            };
        }
        const key = await password({
            message: `${this.#provider} API key for ${this.#runner} in ${this.#runtime}`,
            validate: (value) =>
                value?.trim() ? undefined : `Enter your ${this.#provider} API key`,
        });
        if (typeof key === 'symbol') throw new Error('Connection setup cancelled');
        return { entry: this.#setup.file.apiKey(key) };
    }

    /** The piped key, with one trailing newline removed and nothing else forgiven. */
    async #stdinKey(): Promise<string> {
        const raw = await (this.#options.readKey ?? (() => Bun.stdin.text()))();
        const key = raw.replace(/\r?\n$/, '');
        if (/\s/.test(key)) {
            throw new Error(
                'The key on standard input contains whitespace or several lines; pipe only the key value'
            );
        }
        return key;
    }

    async #report(readiness: ConnectionReadiness, advice: string): Promise<void> {
        const { target, output } = this.#options;
        if (!readiness.ready) {
            throw new AuthenticationRequiredError(
                `${readiness.missing ?? `${this.#provider} is not connected`}. ${advice}. For one run, --env-file also works.`
            );
        }
        await this.#store.save(
            { runner: target.harness, runtime: target.runtime },
            {
                provider: target.provider,
                nativeProvider: target.method.nativeProvider,
                authenticationMethod: target.method.authenticationMethod,
                method: target.method.id,
                ...(target.method.nativeMethod
                    ? { nativeMethod: target.method.nativeMethod }
                    : {}),
            }
        );
        output.record({
            machine: [
                readiness.saved ? 'saved' : 'ready',
                target.runtime,
                target.harness,
                target.provider,
            ],
            title: `${readiness.saved ? 'Saved' : 'Ready'}: ${this.#provider} for ${this.#runner} in ${this.#runtime}`,
            details: readiness.saved
                ? ['the first run confirms it']
                : readiness.fromEnvironment
                  ? [`from ${this.#variables()} in the environment`]
                  : [],
        });
    }

    /** A subscription sign-in that cannot run here: where it can still finish. */
    #signInAdvice(): string {
        const { target, workbench } = this.#options;
        if (target.harness === 'pi') {
            // Copying the user's own Pi sign-in could invalidate it, so only a key remains.
            return `Pi has no command-line sign-in, and a copied subscription sign-in could invalidate yours. Use an API key instead: ${this.#base()} --provider ${target.provider} --method api-key --stdin`;
        }
        return workbench
            ? `Run ${this.#command()} in a terminal with OpenCode installed, or start the Workbench interactively once with wb run ${workbench.reference} --runtime ${target.runtime}`
            : `Run ${this.#command()} in a terminal with OpenCode installed`;
    }

    #variables(): string {
        return (
            ActiveModelCatalog.current().providers[this.#options.target.provider]
                ?.env ?? []
        ).join(' or ');
    }

    #localAdvice(): string {
        const { target } = this.#options;
        const variables = this.#variables();
        const variable = variables ? `, or set ${variables}` : '';
        return target.harness === 'opencode'
            ? `Run opencode auth login --provider ${target.method.nativeProvider}${variable}`
            : `Run pi and sign in with /login${variable}`;
    }

    /** The `wb connect` command for this target, plus `extra` flags. */
    #command(extra: string[] = []): string {
        const { target } = this.#options;
        return [
            this.#base(),
            '--provider',
            target.provider,
            '--method',
            target.method.id,
            ...extra,
        ].join(' ');
    }

    #base(): string {
        const { target, workbench } = this.#options;
        return workbench
            ? connectCommand(workbench.reference, target.runtime)
            : `wb connect --runtime ${target.runtime} --harness ${target.harness}`;
    }

    get #provider(): string {
        return providerLabel(this.#options.target.provider);
    }

    get #runner(): string {
        return harnessLabel(this.#options.target.harness);
    }

    get #runtime(): string {
        return runtimeLabel(this.#options.target.runtime);
    }
}
