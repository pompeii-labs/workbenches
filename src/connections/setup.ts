import { ActiveModelCatalog, type AuthenticatedModelRoute } from '../models/index.js';
import { RunnerRegistry } from '../runners/registry.js';
import type { PreparedRuntime, RuntimeCredentialFiles } from '../runtimes/contracts.js';
import type { ResolvedWorkbench } from '../types.js';
import { ConnectionCheck, type ConnectionCheckOptions } from './check.js';
import { HostCredentialFiles, RunnerCredentialStore } from './credentials.js';
import { applyRuntimeCredentials } from './environmentcredentials.js';
import {
    type NativeCredentialEntry,
    NativeCredentialFile,
} from './nativecredentials.js';
import type { ConnectionStore } from './store.js';
import {
    type ConnectionAuthenticationMethod,
    type ConnectionTarget,
    harnessLabel,
    providerLabel,
    runtimeLabel,
} from './targets.js';

/** Whether a target can authenticate, and what is missing when it cannot. */
export interface ConnectionReadiness {
    ready: boolean;
    /** Only the host copy of a remote store was read back; the first run confirms it. */
    saved: boolean;
    /** An inherited provider variable serves the route. */
    fromEnvironment: boolean;
    missing?: string;
}

/** The Workbench a connection is made for, with the target runtime selected. */
export interface ConnectionWorkbench {
    workbench: ResolvedWorkbench;
    reference: string;
    workspaceDirectory: string;
}

export interface ConnectionSetupOptions {
    home: string;
    target: ConnectionTarget;
    environment: Record<string, string | undefined>;
    workbench?: ConnectionWorkbench;
    store?: ConnectionStore;
    check?: (
        options: ConnectionCheckOptions
    ) => Pick<ConnectionCheck, 'open' | 'inspect'>;
}

/**
 * Fills the credential store a runtime reads for one runner and provider, and
 * reports whether a run can authenticate with the chosen method. `local` uses
 * the runner's own host sign-in. `docker` writes the runner's credential
 * volume through the Workbench image and checks it with the runner inside the
 * container, so it needs a Workbench. `e2b` writes the host store synced into
 * each sandbox and is confirmed by the first run, because checking it would
 * create a billable sandbox. `daytona` has no runner credential store and
 * reads provider variables only.
 */
export class ConnectionSetup {
    readonly file: NativeCredentialFile;
    readonly #options: ConnectionSetupOptions;

    constructor(options: ConnectionSetupOptions) {
        this.#options = options;
        this.file = NativeCredentialFile.for(options.target.harness);
    }

    /** Refuses runtimes whose store Workbench does not write: `local` and `daytona`. */
    requireStore(): void {
        const { target } = this.#options;
        if (target.runtime === 'local' || target.runtime === 'daytona') {
            throw new Error(
                target.runtime === 'local'
                    ? `The local runtime uses your own ${harnessLabel(target.harness)} sign-in; Workbench neither writes nor removes it`
                    : `${runtimeLabel(target.runtime)} has no runner credential store; provider keys reach it only from the environment`
            );
        }
        if (
            RunnerRegistry.standard()
                .authentication(target.harness)
                .nativeCredentialStore(target.runtime)
        ) {
            return;
        }
        throw new Error(
            `${runtimeLabel(target.runtime)} has no runner credential store; provider keys reach it only from the environment`
        );
    }

    /** Writes `entry` into the store the target runtime reads, then checks readiness. */
    async save(entry: NativeCredentialEntry): Promise<ConnectionReadiness> {
        this.requireStore();
        const provider = this.#options.target.method.nativeProvider;
        if (this.#options.target.runtime === 'docker') {
            return this.#inspect(async (runtime) => {
                const files = this.#runtimeFiles(runtime);
                await this.file.save(files, provider, entry);
                return entry;
            });
        }
        const { target, home } = this.#options;
        const binding = await new RunnerCredentialStore(home).prepare(
            target.runtime,
            target.harness
        );
        await this.file.save(
            new HostCredentialFiles(binding.directory),
            provider,
            entry
        );
        return this.verify();
    }

    async signIn(): Promise<ConnectionReadiness> {
        const { target } = this.#options;
        const authentication = RunnerRegistry.standard().authentication(target.harness);
        const command = authentication.loginArguments?.(
            target.method.nativeProvider,
            target.method.authenticationMethod
        );
        if (!command) throw new Error('The selected connection has no native sign-in');
        const signedIn = await this.#check().open(async (runtime, runner) => {
            const invocation = runner.native(runtime, command);
            return (
                (await runtime.interact({
                    ...invocation,
                    env:
                        authentication.invocationEnvironment?.(
                            runtime.name,
                            invocation.env
                        ) ?? invocation.env,
                })) === 0
            );
        });
        if (!signedIn) {
            return this.#missing(
                `${this.#runner} sign-in did not complete for ${this.#provider}`
            );
        }
        return this.verify();
    }

    /** Checks readiness without writing anything. */
    async verify(): Promise<ConnectionReadiness> {
        const { target, workbench } = this.#options;
        if (
            RunnerRegistry.standard().authentication(target.harness).loginArguments &&
            RunnerRegistry.standard()
                .authentication(target.harness)
                .supportsNativeAuthentication(
                    target.runtime,
                    target.provider,
                    target.method.authenticationMethod
                )
        ) {
            if (!workbench) {
                return this.#missing(
                    `A Workbench is required to check ${this.#runner} sign-in`
                );
            }
            return this.#inspect().then((status) => status);
        }
        if (target.runtime === 'docker') {
            return this.#inspect(async (runtime) =>
                this.file.find(
                    this.#runtimeFiles(runtime),
                    target.method.nativeProvider
                )
            );
        }
        if (
            RunnerRegistry.standard().authentication(target.harness)
                .credentialFormat === 'provider'
        ) {
            if (this.#environmentServes()) return ready({ fromEnvironment: true });
            return this.#missing(
                `${this.#runner} in ${runtimeLabel(target.runtime)} reads ${this.#provider} keys only from the environment`
            );
        }
        // The runner itself reports its own sign-in; Workbench never reads its files.
        if (target.runtime === 'local' && workbench) return this.#inspect();
        if (target.runtime !== 'e2b') {
            return this.#environmentServes()
                ? ready({ fromEnvironment: true })
                : this.#missing(
                      target.runtime === 'local'
                          ? `Without a Workbench, wb cannot ask ${this.#runner} which providers it is signed in to, and no ${this.#provider} key is in the environment`
                          : `Daytona has no runner credential store, so ${this.#runner} there reads ${this.#provider} keys only from the environment`
                  );
        }
        // Reading must not create the store, so this skips the private-directory setup.
        const entry = await this.file.find(
            new HostCredentialFiles(
                new RunnerCredentialStore(this.#options.home).binding(
                    target.runtime,
                    target.harness
                ).directory
            ),
            target.method.nativeProvider
        );
        // Pi reads its auth.json before the environment, so a stored Pi entry decides alone.
        if (entry && target.harness === 'pi') {
            return this.#serves(entry)
                ? ready({ saved: true })
                : this.#missing(this.#mismatch(entry));
        }
        if (this.#environmentServes()) return ready({ fromEnvironment: true });
        if (entry && this.#serves(entry)) return ready({ saved: true });
        return this.#missing(
            entry
                ? this.#mismatch(entry)
                : `No ${this.#provider} credential is saved for ${this.#runner} in ${runtimeLabel(target.runtime)}`
        );
    }

    /** Removes the providers' entries from the target runtime's store, keeping others. */
    async remove(
        requested: ConnectionAuthenticationMethod[] | string[]
    ): Promise<boolean> {
        const { target } = this.#options;
        const methods: ConnectionAuthenticationMethod[] = requested.map((method) =>
            typeof method === 'string'
                ? { ...target.method, nativeProvider: method }
                : method
        );
        const authentication = RunnerRegistry.standard().authentication(target.harness);
        if (!authentication.nativeCredentialStore(target.runtime)) {
            if (target.runtime === 'local' || target.harness === 'claude-code') {
                return false;
            }
            this.requireStore();
        }
        const remove = async (files: RuntimeCredentialFiles) => {
            let removed = false;
            for (const provider of new Set(
                methods.map((method) => method.nativeProvider)
            )) {
                removed = (await this.file.remove(files, provider)) || removed;
            }
            return removed;
        };
        const { home } = this.#options;
        if (target.runtime === 'docker') {
            return this.#check().open((runtime) => remove(this.#runtimeFiles(runtime)));
        }
        const binding = await new RunnerCredentialStore(home).prepare(
            target.runtime,
            target.harness
        );
        return remove(new HostCredentialFiles(binding.directory));
    }

    /**
     * Checks inside the runtime with the inspector smoke uses. `stored` writes
     * or reads the runtime store's entry first, so a Pi entry can decide
     * readiness as it does for a run. A runtime without a store passes none.
     */
    async #inspect(
        stored?: (
            runtime: PreparedRuntime
        ) => Promise<NativeCredentialEntry | undefined>
    ): Promise<ConnectionReadiness> {
        const { target } = this.#options;
        let entry: NativeCredentialEntry | undefined;
        const status = await this.#check().inspect({
            selection: {
                provider: target.provider,
                nativeProvider: target.method.nativeProvider,
                authenticationMethod: target.method.authenticationMethod,
            },
            ...(stored
                ? {
                      before: async (runtime: PreparedRuntime) => {
                          entry = await stored(runtime);
                          await applyRuntimeCredentials(runtime, target.harness);
                      },
                  }
                : {}),
        });
        if (entry && target.harness === 'pi' && !this.#serves(entry)) {
            return this.#missing(this.#mismatch(entry));
        }
        const route = status.connections.find((connection) =>
            this.#matches(connection)
        );
        if (!route) {
            return this.#missing(
                `${this.#runner} in ${runtimeLabel(target.runtime)} has no ${this.#provider} credential for ${target.method.label}`
            );
        }
        return ready({
            fromEnvironment:
                !entry &&
                route.authenticationMethod === 'api' &&
                this.#environmentServes(),
        });
    }

    /** Whether an authenticated route serves the chosen method; `native` takes any. */
    #matches(route: AuthenticatedModelRoute): boolean {
        const { target } = this.#options;
        if (route.provider !== target.provider) return false;
        if (target.method.authenticationMethod === 'native') return true;
        return (
            route.nativeProvider === target.method.nativeProvider &&
            (!route.authenticationMethod ||
                route.authenticationMethod === target.method.authenticationMethod)
        );
    }

    #serves(entry: NativeCredentialEntry): boolean {
        return this.file.serves(
            entry,
            this.#options.target.method.authenticationMethod
        );
    }

    #mismatch(entry: NativeCredentialEntry): string {
        return `The saved ${this.#provider} credential for ${this.#runner} is ${entry.type ?? 'of an unknown type'}, not ${this.#options.target.method.label}`;
    }

    #missing(missing: string): ConnectionReadiness {
        return { ready: false, saved: false, fromEnvironment: false, missing };
    }

    #check(): Pick<ConnectionCheck, 'open' | 'inspect'> {
        const { workbench } = this.#options;
        if (!workbench) {
            throw new Error(
                `A Workbench reference is required for ${runtimeLabel(this.#options.target.runtime)} credentials`
            );
        }
        const options: ConnectionCheckOptions = {
            workbench: workbench.workbench,
            workspaceDirectory: workbench.workspaceDirectory,
            reference: workbench.reference,
            environment: this.#options.environment,
            ...(this.#options.store ? { store: this.#options.store } : {}),
        };
        return this.#options.check?.(options) ?? new ConnectionCheck(options);
    }

    #runtimeFiles(runtime: PreparedRuntime): RuntimeCredentialFiles {
        if (!runtime.credentials) {
            throw new Error(
                `${runtimeLabel(this.#options.target.runtime)} did not provide a runner credential store`
            );
        }
        return runtime.credentials;
    }

    /**
     * Inherited provider variables win over stored entries for a run, except
     * for Pi. A variable holds an API key, so it never serves a subscription.
     */
    #environmentServes(): boolean {
        if (this.#options.target.method.authenticationMethod === 'oauth') return false;
        const names =
            ActiveModelCatalog.current().providers[this.#options.target.provider]
                ?.env ?? [];
        return names.some((name) => Boolean(this.#options.environment[name]?.trim()));
    }

    get #provider(): string {
        return providerLabel(this.#options.target.provider);
    }

    get #runner(): string {
        return harnessLabel(this.#options.target.harness);
    }
}

function ready(options: {
    saved?: boolean;
    fromEnvironment?: boolean;
}): ConnectionReadiness {
    return {
        ready: true,
        saved: options.saved ?? false,
        fromEnvironment: options.fromEnvironment ?? false,
    };
}
