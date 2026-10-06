import { ActiveModelCatalog } from '../models/index.js';
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
    /**
     * `runtime` when the runner itself listed the credential inside the
     * runtime; `stored` when only the stored entry was checked, so the first
     * run confirms it; `environment` when an inherited provider variable
     * serves the route.
     */
    verified: 'runtime' | 'stored' | 'environment';
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
 * reports whether a run can authenticate. `local` uses the runner's own host
 * sign-in. `docker` writes the runner's credential volume through the
 * Workbench image and checks it with the runner inside the container. `e2b`
 * writes the host store synced into each sandbox and is confirmed by the first
 * run, because checking it would create a billable sandbox. `daytona` has no
 * runner credential store and reads provider variables only.
 */
export class ConnectionSetup {
    readonly file: NativeCredentialFile;
    readonly #options: ConnectionSetupOptions;

    constructor(options: ConnectionSetupOptions) {
        this.#options = options;
        this.file = NativeCredentialFile.for(options.target.harness);
    }

    /** Whether Workbench can write a credential that the target runtime reads. */
    get writable(): boolean {
        const { runtime } = this.#options.target;
        return runtime === 'docker' || runtime === 'e2b';
    }

    /** The runner's own sign-in on this host for the target, when it can serve the method. */
    async hostEntry(): Promise<NativeCredentialEntry | undefined> {
        const files = this.file.host(this.#options.environment);
        if (!files) return undefined;
        const { method } = this.#options.target;
        const entry = await this.file.find(files, method.nativeProvider);
        return entry && this.file.serves(entry, method.authenticationMethod)
            ? entry
            : undefined;
    }

    /** Writes `entry` into the store the target runtime reads, then checks readiness. */
    async save(entry: NativeCredentialEntry): Promise<ConnectionReadiness> {
        const provider = this.#options.target.method.nativeProvider;
        this.#requireStore();
        if (this.#options.target.runtime === 'docker') {
            return this.#inspect((runtime) =>
                this.file.save(this.#runtimeFiles(runtime), provider, entry)
            );
        }
        await this.file.save(await this.#hostStore(true), provider, entry);
        return this.verify();
    }

    /** Checks readiness without writing anything. */
    async verify(): Promise<ConnectionReadiness> {
        const { target, workbench } = this.#options;
        const runner = harnessLabel(target.harness);
        const provider = providerLabel(target.provider);
        if ((target.runtime === 'local' || target.runtime === 'docker') && workbench) {
            return this.#inspect();
        }
        if (this.#environmentReady()) return { ready: true, verified: 'environment' };
        if (target.runtime === 'docker') {
            return {
                ready: false,
                verified: 'runtime',
                missing: `Docker keeps ${runner} credentials in a volume that is written and checked through a Workbench image`,
            };
        }
        if (target.runtime === 'daytona') {
            return {
                ready: false,
                verified: 'environment',
                missing: `Daytona has no runner credential store, so ${runner} there reads ${provider} keys only from the environment`,
            };
        }
        if (target.runtime === 'local') {
            return (await this.hostEntry())
                ? { ready: true, verified: 'stored' }
                : {
                      ready: false,
                      verified: 'stored',
                      missing: `No ${provider} credential for ${runner} on this machine`,
                  };
        }
        const entry = await this.file.find(
            await this.#hostStore(false),
            target.method.nativeProvider
        );
        return entry
            ? { ready: true, verified: 'stored' }
            : {
                  ready: false,
                  verified: 'stored',
                  missing: `No ${provider} credential is saved for ${runner} in ${runtimeLabel(target.runtime)}`,
              };
    }

    /** Removes the providers' entries from the target runtime's store, keeping others. */
    async remove(nativeProviders: string[]): Promise<boolean> {
        this.#requireStore();
        const remove = async (files: RuntimeCredentialFiles) => {
            let removed = false;
            for (const provider of nativeProviders) {
                removed = (await this.file.remove(files, provider)) || removed;
            }
            return removed;
        };
        if (this.#options.target.runtime === 'docker') {
            return this.#check().open((runtime) => remove(this.#runtimeFiles(runtime)));
        }
        return remove(await this.#hostStore(true));
    }

    async #inspect(
        before?: (runtime: PreparedRuntime) => Promise<void>
    ): Promise<ConnectionReadiness> {
        const { target } = this.#options;
        const status = await this.#check().inspect({
            selection: {
                provider: target.provider,
                nativeProvider: target.method.nativeProvider,
                authenticationMethod: target.method.authenticationMethod,
            },
            ...(before ? { before } : {}),
        });
        const ready = status.connections.some(
            (connection) => connection.provider === target.provider
        );
        return ready
            ? { ready, verified: 'runtime' }
            : {
                  ready,
                  verified: 'runtime',
                  missing: `${harnessLabel(target.harness)} in ${runtimeLabel(target.runtime)} has no ${providerLabel(target.provider)} credential`,
              };
    }

    #requireStore(): void {
        const { target } = this.#options;
        if (this.writable) return;
        throw new Error(
            target.runtime === 'local'
                ? `The local runtime uses your own ${harnessLabel(target.harness)} sign-in; manage it with ${harnessLabel(target.harness)} itself`
                : `${runtimeLabel(target.runtime)} has no runner credential store; provider keys reach it only from the environment`
        );
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

    /** The host store a remote runtime syncs. Only writes create its private directories. */
    async #hostStore(create: boolean): Promise<RuntimeCredentialFiles> {
        const { target, home } = this.#options;
        const store = new RunnerCredentialStore(home);
        return create
            ? store.files(target.runtime, target.harness)
            : new HostCredentialFiles(
                  store.binding(target.runtime, target.harness).directory
              );
    }

    /** Inherited provider variables win over stored entries, as they do for a run. */
    #environmentReady(): boolean {
        const names =
            ActiveModelCatalog.current().providers[this.#options.target.provider]
                ?.env ?? [];
        return names.some((name) => Boolean(this.#options.environment[name]?.trim()));
    }
}
