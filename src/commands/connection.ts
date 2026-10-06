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
    readonly #environment: Record<string, string | undefined>;
    readonly #interactive: boolean;

    constructor(options: ModelConnectionOptions) {
        this.#options = options;
        this.#environment = options.environment ?? process.env;
        this.#interactive =
            options.interactive ?? Boolean(process.stdin.isTTY && process.stderr.isTTY);
        this.#setup =
            options.setup ??
            new ConnectionSetup({
                home: options.home,
                target: options.target,
                environment: this.#environment,
                store: new ConnectionStore(options.home),
                ...(options.workbench ? { workbench: options.workbench } : {}),
            });
    }

    /**
     * Saves the preferred route, fills the runtime's credential store, and
     * prints readiness. Throws `AuthenticationRequiredError` (exit 3) with the
     * missing piece and the command that fixes it when a run could not
     * authenticate.
     */
    async connect(flags: { stdin: boolean; yes: boolean }): Promise<void> {
        const { target, home } = this.#options;
        await new ConnectionStore(home).save(
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
        if (!this.#setup.writable && (flags.stdin || flags.yes)) {
            throw new Error(
                target.runtime === 'local'
                    ? `--stdin and --yes fill docker and e2b; local uses your own ${this.#runner} sign-in`
                    : `--stdin and --yes fill docker and e2b; Daytona reads provider keys only from the environment`
            );
        }
        if (target.runtime === 'local') {
            this.#report(await this.#setup.verify(), this.#localAdvice());
            return;
        }
        if (target.runtime === 'daytona') {
            this.#report(
                await this.#setup.verify(),
                `Set ${this.#variables() || 'the provider key'} where wb runs`
            );
            return;
        }
        if (target.runtime === 'docker' && !this.#options.workbench) {
            this.#report(await this.#setup.verify(), `Run ${this.#placeholder()}`);
            return;
        }
        const source = await this.#source(flags);
        if ('advice' in source) {
            this.#report(await this.#setup.verify(), source.advice);
            return;
        }
        this.#options.output.progress(
            `Writing the ${this.#provider} credential for ${this.#runner} in ${this.#runtime}`
        );
        this.#report(
            await this.#setup.save(source.entry),
            this.#options.workbench
                ? `Check what the runner reports with wb smoke ${this.#options.workbench.reference} --runtime ${target.runtime}`
                : `Run ${this.#command()} again`
        );
    }

    /** Removes the target provider's entries from the runtime's store, keeping others. */
    async remove(methods: ConnectionAuthenticationMethod[]): Promise<void> {
        const { target, output } = this.#options;
        if (target.runtime === 'docker' && !this.#options.workbench) {
            throw new Error(
                `Docker credentials are changed through a Workbench image. Run ${this.#placeholder(['--remove'])}`
            );
        }
        // Local and Daytona have no store Workbench writes, so `remove` refuses them with the reason.
        const removed = await this.#setup.remove([
            ...new Set(methods.map((method) => method.nativeProvider)),
        ]);
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

    async #source(flags: { stdin: boolean; yes: boolean }): Promise<CredentialSource> {
        const { target } = this.#options;
        const method = target.method.authenticationMethod;
        if (flags.stdin) {
            if (method === 'oauth') {
                throw new Error(
                    `--stdin reads an API key, but ${target.method.label} is a sign-in. Choose an API-key method with --method`
                );
            }
            return {
                entry: this.#setup.file.apiKey(
                    await (this.#options.readKey ?? (() => Bun.stdin.text()))()
                ),
            };
        }
        const host = await this.#setup.hostEntry();
        if (host && flags.yes) return { entry: host };
        if (host && !this.#interactive) {
            return {
                advice: `Copy your local ${this.#runner} ${this.#provider} credential with ${this.#command(['--yes'])}`,
            };
        }
        if (host) {
            const reuse = await confirm({
                message: `Use your local ${this.#provider} credential in ${this.#runtime}?`,
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

    #report(readiness: ConnectionReadiness, advice: string): void {
        const { target, output } = this.#options;
        if (!readiness.ready) {
            throw new AuthenticationRequiredError(
                `${readiness.missing ?? `${this.#provider} is not connected`}. ${advice}. For one run, --env-file also works.`
            );
        }
        // A remote store is only read back on the host; the first run confirms it.
        const saved = readiness.verified === 'stored' && target.runtime !== 'local';
        output.record({
            machine: [
                saved ? 'saved' : 'ready',
                target.runtime,
                target.harness,
                target.provider,
            ],
            title: `${saved ? 'Saved' : 'Ready'}: ${this.#provider} for ${this.#runner} in ${this.#runtime}`,
            details: saved
                ? ['the first run confirms it']
                : readiness.verified === 'environment'
                  ? [`from ${this.#variables()} in the environment`]
                  : [],
        });
    }

    /** OAuth with no host sign-in available: the one place that can still finish it. */
    #signInAdvice(): string {
        const { target, workbench } = this.#options;
        if (target.harness === 'pi') {
            return `Pi has no command-line sign-in. Sign in with pi on this machine (/login), then run ${this.#command(['--yes'])}`;
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
    #command(extra: string[] = [], base = this.#base()): string {
        const { target } = this.#options;
        return [
            base,
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

    /** The command for a runtime that needs a Workbench the user has not named. */
    #placeholder(extra: string[] = []): string {
        return this.#command(
            extra,
            `wb connect <workbench> --runtime ${this.#options.target.runtime}`
        );
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
