import { ActiveModelCatalog, type AuthenticatedModelRoute } from '../models/index.js';
import { RunnerRegistry } from '../runners/registry.js';
import type { PreparedRuntime, RuntimeCredentialFiles } from '../runtimes/contracts.js';
import type { ResolvedWorkbench } from '../types.js';
import { ConnectionCheck, type ConnectionCheckOptions } from './check.js';
import { HostCredentialFiles, RunnerCredentialStore } from './credentials.js';
import {
    type NativeCredentialEntry,
    NativeCredentialFile,
} from './nativecredentials.js';
import type { ConnectionStore } from './store.js';
import {
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
    /** The runners the target harness is resolved from. */
    runners?: Pick<RunnerRegistry, 'find' | 'resolve'>;
}

/**
 * Fills the credential store a runtime reads for one runner and provider, and
 * reports whether a run can authenticate with the chosen method. `local` uses
 * the runner's own host sign-in. `docker` writes the runner's credential
 * volume through the Workbench image and checks it with the runner inside the
 * container, so it needs a Workbench. `e2b` writes the host store synced into
 * each sandbox and is confirmed by the first run, because checking it would
 * create a billable sandbox. `daytona` has no runner credential store and
 * reads provider variables only. A runner without a credential file has no
 * store anywhere: Docker is checked by the runner itself, and E2B reads
 * provider variables only.
 */
export class ConnectionSetup {
    /** The runner's native credential file, or undefined for a runner Workbench keeps no credentials for. */
    readonly file: NativeCredentialFile | undefined;
    readonly #options: ConnectionSetupOptions;
    readonly #runners: Pick<RunnerRegistry, 'find' | 'resolve'>;

    constructor(options: ConnectionSetupOptions) {
        this.#options = options;
        this.#runners = options.runners ?? RunnerRegistry.standard();
        const runner = this.#runners.find(options.target.harness);
        this.file =
            runner && !runner.credentials
                ? undefined
                : NativeCredentialFile.for(options.target.harness, this.#runners);
    }

    /** Whether the target runtime has a store Workbench writes for this runner. */
    get storesCredentials(): boolean {
        const { runtime } = this.#options.target;
        return Boolean(this.file) && (runtime === 'docker' || runtime === 'e2b');
    }

    /**
     * Refuses runtimes whose store Workbench does not write: `local`, `daytona`,
     * and any runtime for a runner without a credential file.
     */
    requireStore(): void {
        if (this.storesCredentials) return;
        const { target } = this.#options;
        throw new Error(
            target.runtime === 'local'
                ? `The local runtime uses your own ${this.#runner} sign-in; Workbench neither writes nor removes it`
                : target.runtime === 'docker' || target.runtime === 'e2b'
                  ? `${this.#runner} has no credential store Workbench writes; ${this.#provider} keys reach it only from the environment or --env-file`
                  : `${runtimeLabel(target.runtime)} has no runner credential store; provider keys reach it only from the environment`
        );
    }

    /** The file of the store Workbench writes, after refusing a target without one. */
    #file(): NativeCredentialFile {
        this.requireStore();
        if (!this.file) throw new Error(`${this.#runner} has no credential file`);
        return this.file;
    }

    /** The store entry for an API key, in the runner's own format. */
    apiKey(key: string): NativeCredentialEntry {
        return this.#file().apiKey(key);
    }

    /** Writes `entry` into the store the target runtime reads, then checks readiness. */
    async save(entry: NativeCredentialEntry): Promise<ConnectionReadiness> {
        const file = this.#file();
        const provider = this.#options.target.method.nativeProvider;
        if (this.#options.target.runtime === 'docker') {
            return this.#inspect(async (runtime) => {
                const files = this.#runtimeFiles(runtime);
                await file.save(files, provider, entry);
                return entry;
            });
        }
        const { target, home } = this.#options;
        const binding = await new RunnerCredentialStore(home).prepare(
            target.runtime,
            target.harness
        );
        await file.save(new HostCredentialFiles(binding.directory), provider, entry);
        return this.verify();
    }

    /** Checks readiness without writing anything. */
    async verify(): Promise<ConnectionReadiness> {
        const { target, workbench } = this.#options;
        const file = this.file;
        if (target.runtime === 'docker') {
            if (!file) return this.#inspect();
            return this.#inspect(async (runtime) =>
                file.find(this.#runtimeFiles(runtime), target.method.nativeProvider)
            );
        }
        // The runner itself reports its own sign-in; Workbench never reads its files.
        if (target.runtime === 'local' && workbench) return this.#inspect();
        if (target.runtime !== 'e2b' || !file) {
            return this.#environmentServes()
                ? ready({ fromEnvironment: true })
                : this.#missing(
                      target.runtime === 'local'
                          ? `Without a Workbench, wb cannot ask ${this.#runner} which providers it is signed in to, and no ${this.#provider} key is in the environment`
                          : target.runtime === 'e2b'
                            ? `${this.#runner} has no credential store Workbench writes, so in E2B it reads ${this.#provider} keys only from the environment or --env-file`
                            : `Daytona has no runner credential store, so ${this.#runner} there reads ${this.#provider} keys only from the environment`
                  );
        }
        // Reading must not create the store, so this skips the private-directory setup.
        const entry = await file.find(
            new HostCredentialFiles(
                new RunnerCredentialStore(this.#options.home).binding(
                    target.runtime,
                    target.harness
                ).directory
            ),
            target.method.nativeProvider
        );
        // A runner that reads its credential file before the environment lets a stored entry decide alone.
        if (entry && file.storeFirst) {
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

    /**
     * Removes the providers' entries from the target runtime's store, keeping
     * others. A runner without a credential file has nothing saved to remove.
     */
    async remove(nativeProviders: string[]): Promise<boolean> {
        const { runtime } = this.#options.target;
        if (!this.file && (runtime === 'docker' || runtime === 'e2b')) return false;
        const file = this.#file();
        const remove = async (files: RuntimeCredentialFiles) => {
            let removed = false;
            for (const provider of nativeProviders) {
                removed = (await file.remove(files, provider)) || removed;
            }
            return removed;
        };
        const { target, home } = this.#options;
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
     * or reads the runtime store's entry first, so a store-first runner's entry
     * can decide readiness as it does for a run. A runtime without a store passes none.
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
                      },
                  }
                : {}),
        });
        if (entry && this.file?.storeFirst && !this.#serves(entry)) {
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

    /** Whether a stored entry serves the chosen method. Only a runner with a credential file has entries. */
    #serves(entry: NativeCredentialEntry): boolean {
        return (
            this.file?.serves(
                entry,
                this.#options.target.method.authenticationMethod
            ) ?? false
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
            runners: this.#runners,
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
     * for a store-first runner. A variable holds an API key, so it never serves
     * a subscription.
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
        return harnessLabel(this.#options.target.harness, this.#runners);
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
