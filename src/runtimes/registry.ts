import type {
    CollectedOutput,
    OutcomeSink,
    RuntimeOutcomeCollection,
} from '../outcomes/collection.js';
import type {
    ResolvedWorkbench,
    RunnerInvocation,
    SpawnedRunner,
    WorkbenchWorkspaceBinding,
} from '../types.js';
import { type HostDescriber, NodeHost } from '../workbench/host.js';
import type { PreflightResult } from '../workbench/preflight.js';
import { RequirementsPreflight } from '../workbench/requirements.js';
import type {
    PreparedRuntime,
    RuntimeCommandOptions,
    RuntimeCommandResult,
    RuntimeCredentialFiles,
    RuntimeInfrastructureMetadata,
    RuntimePlacement,
    RuntimePreparation,
    RuntimePrepareRequest,
    RuntimeProvider,
    RuntimeService,
    RuntimeServiceBinding,
    RuntimeSessionOptions,
} from './contracts.js';
import {
    DaytonaConnector,
    type DaytonaRuntimeDependencies,
    DaytonaRuntimeProvider,
} from './daytona/index.js';
import {
    type DockerRuntimeDependencies,
    DockerRuntimeProvider,
} from './docker/index.js';
import { type E2BRuntimeDependencies, E2BRuntimeProvider } from './e2b/index.js';
import { RuntimeError } from './error.js';
import { type LocalRuntimeDependencies, LocalRuntimeProvider } from './local.js';
import { DiskTransfer } from './remote/disk/transfer.js';
import { RuntimeSecretStore } from './secrets.js';
import { DiskAssetSource } from './staging/disk.js';
import { TransferRules } from './staging/rules.js';

export interface RuntimeDependencies extends Partial<LocalRuntimeDependencies> {
    docker?: Omit<DockerRuntimeDependencies, 'host'>;
    /** Anything left out is wired here: assets are read from the local disk. */
    e2b?: Partial<E2BRuntimeDependencies>;
    /**
     * Anything left out is wired here: files are read and staged through the
     * local disk, the key comes from the environment or the saved runtime key,
     * and clients send requests through the platform `fetch`.
     */
    daytona?: Partial<DaytonaRuntimeDependencies>;
}

export class RuntimeRegistry {
    private readonly providers = new Map<string, RuntimeProvider>();
    /** Checks Workbench requirements against `host`, the machine the providers run on. */
    readonly requirements: RequirementsPreflight;

    constructor(providers: RuntimeProvider[], host?: HostDescriber) {
        this.requirements = new RequirementsPreflight(host);
        for (const provider of providers) {
            const name = provider.name.trim();
            if (!name) throw new Error('Runtime provider name must not be empty');
            if (this.providers.has(name)) {
                throw new Error(`Duplicate runtime provider: ${name}`);
            }
            this.providers.set(name, provider);
        }
    }

    static standard(dependencies: RuntimeDependencies = {}): RuntimeRegistry {
        const disk = new DiskAssetSource();
        const host = dependencies.host ?? new NodeHost();
        return new RuntimeRegistry(
            [
                new LocalRuntimeProvider({ ...dependencies, host }),
                new DockerRuntimeProvider({ ...dependencies.docker, host }),
                new E2BRuntimeProvider({
                    assets: disk,
                    local: disk,
                    ...dependencies.e2b,
                }),
                new DaytonaRuntimeProvider({
                    transfer: new DiskTransfer(
                        disk,
                        disk,
                        new TransferRules('Daytona')
                    ),
                    assets: disk,
                    keys: RuntimeSecretStore,
                    connector: new DaytonaConnector(fetch),
                    clock: {
                        now: () => new Date(),
                        sleep: (milliseconds) =>
                            new Promise((resolve) => setTimeout(resolve, milliseconds)),
                    },
                    ...dependencies.daytona,
                }),
            ],
            host
        );
    }

    resolve(name: string): RuntimeProvider {
        const provider = this.providers.get(name);
        if (!provider) {
            throw new RuntimeError(name, 'resolve', `Unsupported runtime: ${name}`);
        }
        return new GuardedRuntimeProvider(provider);
    }
}

class GuardedRuntimeProvider implements RuntimeProvider {
    readonly name: string;
    readonly placement: RuntimePlacement;

    constructor(private readonly provider: RuntimeProvider) {
        this.name = provider.name;
        this.placement = provider.placement;
    }

    async prepare(request: RuntimePrepareRequest): Promise<PreparedRuntime> {
        try {
            const runtime = await this.provider.prepare(request);
            if (runtime.name !== this.name) {
                throw new Error(
                    `Runtime provider ${this.name} prepared mismatched runtime: ${runtime.name}`
                );
            }
            return new GuardedRuntime(runtime);
        } catch (error) {
            throw RuntimeError.from(this.name, 'prepare', error);
        }
    }
}

class GuardedRuntime implements PreparedRuntime {
    constructor(private readonly runtime: PreparedRuntime) {}

    get name(): string {
        return this.runtime.name;
    }

    get workbench(): ResolvedWorkbench {
        return this.runtime.workbench;
    }

    get workspaceDirectory(): string {
        return this.runtime.workspaceDirectory;
    }

    get environment(): Record<string, string | undefined> {
        return this.runtime.environment;
    }

    get workspaces(): WorkbenchWorkspaceBinding[] {
        return this.runtime.workspaces;
    }

    get preparation(): RuntimePreparation {
        return this.runtime.preparation ?? { kind: 'host' };
    }

    get nativeAuthentication(): 'persistent' | 'unavailable' {
        return this.runtime.nativeAuthentication;
    }

    get sandboxId(): string | undefined {
        return this.runtime.sandboxId;
    }

    get credentials(): RuntimeCredentialFiles | undefined {
        return this.runtime.credentials;
    }

    pathFor(hostPath: string): string {
        try {
            return this.runtime.pathFor(hostPath);
        } catch (error) {
            throw RuntimeError.from(this.name, 'prepare', error);
        }
    }

    async preflight(): Promise<PreflightResult> {
        try {
            return await this.runtime.preflight();
        } catch (error) {
            throw RuntimeError.from(this.name, 'preflight', error);
        }
    }

    async execute(
        invocation: RunnerInvocation,
        options?: RuntimeCommandOptions
    ): Promise<RuntimeCommandResult> {
        try {
            return await this.runtime.execute(invocation, options);
        } catch (error) {
            throw RuntimeError.from(this.name, 'launch', error);
        }
    }

    async interact(invocation: RunnerInvocation): Promise<number> {
        try {
            return await this.runtime.interact(invocation);
        } catch (error) {
            throw RuntimeError.from(this.name, 'launch', error);
        }
    }

    launch(invocation: RunnerInvocation): SpawnedRunner {
        try {
            return this.runtime.launch(invocation);
        } catch (error) {
            throw RuntimeError.from(this.name, 'launch', error);
        }
    }

    launchSession(
        invocation: RunnerInvocation,
        options: RuntimeSessionOptions
    ): SpawnedRunner {
        try {
            return this.runtime.launchSession(invocation, options);
        } catch (error) {
            throw RuntimeError.from(this.name, 'launch', error);
        }
    }

    launchService(
        buildInvocation: (binding: RuntimeServiceBinding) => RunnerInvocation
    ): RuntimeService {
        try {
            return this.runtime.launchService(buildInvocation);
        } catch (error) {
            throw RuntimeError.from(this.name, 'launch', error);
        }
    }

    cancel(process: SpawnedRunner): void {
        try {
            this.runtime.cancel(process);
        } catch (error) {
            throw RuntimeError.from(this.name, 'cancel', error);
        }
    }

    async infrastructure(): Promise<RuntimeInfrastructureMetadata | undefined> {
        try {
            return await this.runtime.infrastructure?.();
        } catch (error) {
            throw RuntimeError.from(this.name, 'cleanup', error);
        }
    }

    async collectOutcome(
        store: OutcomeSink
    ): Promise<RuntimeOutcomeCollection | undefined> {
        try {
            return await this.runtime.collectOutcome?.(store);
        } catch (error) {
            throw RuntimeError.from(this.name, 'collect', error);
        }
    }

    async collectOutput(store: OutcomeSink): Promise<CollectedOutput | undefined> {
        try {
            return await this.runtime.collectOutput?.(store);
        } catch (error) {
            throw RuntimeError.from(this.name, 'collect', error);
        }
    }

    async snapshotRepository(
        store: OutcomeSink
    ): Promise<RuntimeOutcomeCollection | undefined> {
        try {
            return await this.runtime.snapshotRepository?.(store);
        } catch (error) {
            throw RuntimeError.from(this.name, 'collect', error);
        }
    }

    async finalizeOutcome(): Promise<void> {
        await this.runtime.finalizeOutcome?.();
    }

    async cleanup(): Promise<void> {
        try {
            await this.runtime.cleanup();
        } catch (error) {
            throw RuntimeError.from(this.name, 'cleanup', error);
        }
    }
}
