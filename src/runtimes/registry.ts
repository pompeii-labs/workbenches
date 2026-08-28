import type {
    ResolvedWorkbench,
    RunnerInvocation,
    SpawnedRunner,
    WorkbenchWorkspaceBinding,
} from '../types.js';
import type { PreflightResult } from '../workbench/index.js';
import type {
    PreparedRuntime,
    RuntimeCommandOptions,
    RuntimeCommandResult,
    RuntimePreparation,
    RuntimePrepareRequest,
    RuntimeProvider,
} from './contracts.js';
import {
    type DockerRuntimeDependencies,
    DockerRuntimeProvider,
} from './docker/index.js';
import { RuntimeError } from './error.js';
import { type LocalRuntimeDependencies, LocalRuntimeProvider } from './local.js';

export interface RuntimeDependencies extends LocalRuntimeDependencies {
    docker?: DockerRuntimeDependencies;
}

export class RuntimeRegistry {
    private readonly providers = new Map<string, RuntimeProvider>();

    constructor(providers: RuntimeProvider[]) {
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
        return new RuntimeRegistry([
            new LocalRuntimeProvider(dependencies),
            new DockerRuntimeProvider(dependencies.docker),
        ]);
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

    constructor(private readonly provider: RuntimeProvider) {
        this.name = provider.name;
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

    cancel(process: SpawnedRunner): void {
        try {
            this.runtime.cancel(process);
        } catch (error) {
            throw RuntimeError.from(this.name, 'cancel', error);
        }
    }

    async cleanup(): Promise<void> {
        try {
            await this.runtime.cleanup();
        } catch (error) {
            throw RuntimeError.from(this.name, 'cleanup', error);
        }
    }
}
