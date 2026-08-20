import { type DockerRuntimeDependencies, DockerRuntimeProvider } from './docker.js';
import { type PreflightResult, preflightWorkbench } from './preflight.js';
import type { ResolvedWorkbench, RunnerInvocation, SpawnedRunner } from './types.js';

export type RuntimePhase =
    | 'resolve'
    | 'prepare'
    | 'mount'
    | 'bind'
    | 'preflight'
    | 'launch'
    | 'cancel'
    | 'cleanup';

export interface RuntimeAsset {
    path: string;
    access: 'read-only' | 'read-write';
}

export interface RuntimePrepareRequest {
    workbench: ResolvedWorkbench;
    workspaceDirectory: string;
    environment: Record<string, string | undefined>;
    assets: RuntimeAsset[];
}

export interface PreparedRuntime {
    readonly name: string;
    readonly workbench: ResolvedWorkbench;
    readonly workspaceDirectory: string;
    readonly environment: Record<string, string | undefined>;
    readonly preparation?: RuntimePreparation;
    pathFor(hostPath: string): string;
    preflight(): Promise<PreflightResult>;
    launch(invocation: RunnerInvocation): SpawnedRunner;
    cancel(process: SpawnedRunner): void;
    cleanup(): Promise<void>;
}

export interface RuntimePreparation {
    kind: 'host' | 'image';
    reference?: string;
    immutableReference?: string;
    action?: 'pulled' | 'built' | 'cache-hit';
    cacheKey?: string;
    excludedPaths?: string[];
}

export interface RuntimeProvider {
    readonly name: string;
    prepare(request: RuntimePrepareRequest): Promise<PreparedRuntime>;
}

export class RuntimeProviderRegistry {
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

    resolve(name: string): RuntimeProvider {
        const provider = this.providers.get(name);
        if (!provider) {
            throw new RuntimeError(name, 'resolve', `Unsupported runtime: ${name}`);
        }
        return new NormalizedRuntimeProvider(provider);
    }
}

export interface LocalRuntimeDependencies {
    findExecutable?: (name: string) => string | null;
    spawn?: (
        command: string[],
        options: {
            cwd: string;
            env: Record<string, string | undefined>;
            stdin: 'ignore';
            stdout: 'pipe';
            stderr: 'pipe';
        }
    ) => SpawnedRunner;
}

export interface RuntimeProviderDependencies extends LocalRuntimeDependencies {
    docker?: DockerRuntimeDependencies;
}

export function createRuntimeProviderRegistry(
    dependencies: RuntimeProviderDependencies = {}
): RuntimeProviderRegistry {
    return new RuntimeProviderRegistry([
        new LocalRuntimeProvider(dependencies),
        new DockerRuntimeProvider(dependencies.docker),
    ]);
}

export async function smokeWorkbenchRuntime(options: {
    workbench: ResolvedWorkbench;
    workspaceDirectory?: string;
    environment?: Record<string, string | undefined>;
    registry?: RuntimeProviderRegistry;
}): Promise<PreflightResult> {
    const environment = options.environment ?? process.env;
    const workspaceDirectory =
        options.workspaceDirectory ?? options.workbench.repositoryDirectory;
    const registry = options.registry ?? createRuntimeProviderRegistry();
    const runtime = await registry.resolve(options.workbench.manifest.runtime).prepare({
        workbench: options.workbench,
        workspaceDirectory,
        environment,
        assets: [
            { path: workspaceDirectory, access: 'read-write' },
            {
                path: options.workbench.packageDirectory,
                access: 'read-only',
            },
        ],
    });
    try {
        return await runtime.preflight();
    } finally {
        await runtime.cleanup();
    }
}

export class LocalRuntimeProvider implements RuntimeProvider {
    readonly name = 'local';
    private readonly findExecutable: (name: string) => string | null;
    private readonly spawn: NonNullable<LocalRuntimeDependencies['spawn']>;

    constructor(dependencies: LocalRuntimeDependencies = {}) {
        this.findExecutable = dependencies.findExecutable ?? Bun.which;
        this.spawn = dependencies.spawn ?? defaultSpawn;
    }

    async prepare(request: RuntimePrepareRequest): Promise<PreparedRuntime> {
        if (request.workbench.manifest.image) {
            throw new RuntimeError(
                this.name,
                'prepare',
                'image is not supported with the local runtime'
            );
        }
        return new LocalPreparedRuntime(request, this.findExecutable, this.spawn);
    }
}

export class RuntimeError extends Error {
    readonly runtime: string;
    readonly phase: RuntimePhase;

    constructor(runtime: string, phase: RuntimePhase, message: string) {
        super(message);
        this.name = 'RuntimeError';
        this.runtime = runtime;
        this.phase = phase;
    }
}

class LocalPreparedRuntime implements PreparedRuntime {
    readonly name = 'local';
    readonly workbench: ResolvedWorkbench;
    readonly workspaceDirectory: string;
    readonly environment: Record<string, string | undefined>;
    readonly preparation = { kind: 'host' as const };
    private readonly findExecutable: (name: string) => string | null;
    private readonly spawn: NonNullable<LocalRuntimeDependencies['spawn']>;
    private ready = false;
    private cleaned = false;

    constructor(
        request: RuntimePrepareRequest,
        findExecutable: (name: string) => string | null,
        spawn: NonNullable<LocalRuntimeDependencies['spawn']>
    ) {
        this.workbench = request.workbench;
        this.workspaceDirectory = request.workspaceDirectory;
        this.environment = request.environment;
        this.findExecutable = findExecutable;
        this.spawn = spawn;
    }

    pathFor(hostPath: string): string {
        return hostPath;
    }

    async preflight(): Promise<PreflightResult> {
        if (this.cleaned) {
            throw new RuntimeError(
                this.name,
                'preflight',
                'Runtime has already been cleaned up'
            );
        }
        try {
            const result = preflightWorkbench(this.workbench, {
                env: this.environment,
                findExecutable: this.findExecutable,
            });
            this.ready = true;
            return result;
        } catch (error) {
            throw normalizeRuntimeError(this.name, 'preflight', error);
        }
    }

    launch(invocation: RunnerInvocation): SpawnedRunner {
        if (!this.ready) {
            throw new RuntimeError(
                this.name,
                'launch',
                'Runtime preflight must succeed before launch'
            );
        }
        if (this.cleaned) {
            throw new RuntimeError(
                this.name,
                'launch',
                'Runtime has already been cleaned up'
            );
        }
        try {
            return this.spawn(invocation.command, {
                cwd: invocation.cwd,
                env: invocation.env,
                stdin: 'ignore',
                stdout: 'pipe',
                stderr: 'pipe',
            });
        } catch (error) {
            throw normalizeRuntimeError(this.name, 'launch', error);
        }
    }

    cancel(process: SpawnedRunner): void {
        try {
            process.kill?.();
        } catch (error) {
            throw normalizeRuntimeError(this.name, 'cancel', error);
        }
    }

    async cleanup(): Promise<void> {
        this.cleaned = true;
    }
}

class NormalizedRuntimeProvider implements RuntimeProvider {
    readonly name: string;
    private readonly provider: RuntimeProvider;

    constructor(provider: RuntimeProvider) {
        this.name = provider.name;
        this.provider = provider;
    }

    async prepare(request: RuntimePrepareRequest): Promise<PreparedRuntime> {
        try {
            const runtime = await this.provider.prepare(request);
            if (runtime.name !== this.name) {
                throw new Error(
                    `Runtime provider ${this.name} prepared mismatched runtime: ${runtime.name}`
                );
            }
            return new NormalizedPreparedRuntime(runtime);
        } catch (error) {
            throw normalizeRuntimeError(this.name, 'prepare', error);
        }
    }
}

class NormalizedPreparedRuntime implements PreparedRuntime {
    private readonly runtime: PreparedRuntime;

    constructor(runtime: PreparedRuntime) {
        this.runtime = runtime;
    }

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

    get preparation(): RuntimePreparation {
        return this.runtime.preparation ?? { kind: 'host' };
    }

    pathFor(hostPath: string): string {
        try {
            return this.runtime.pathFor(hostPath);
        } catch (error) {
            throw normalizeRuntimeError(this.name, 'prepare', error);
        }
    }

    async preflight(): Promise<PreflightResult> {
        try {
            return await this.runtime.preflight();
        } catch (error) {
            throw normalizeRuntimeError(this.name, 'preflight', error);
        }
    }

    launch(invocation: RunnerInvocation): SpawnedRunner {
        try {
            return this.runtime.launch(invocation);
        } catch (error) {
            throw normalizeRuntimeError(this.name, 'launch', error);
        }
    }

    cancel(process: SpawnedRunner): void {
        try {
            this.runtime.cancel(process);
        } catch (error) {
            throw normalizeRuntimeError(this.name, 'cancel', error);
        }
    }

    async cleanup(): Promise<void> {
        try {
            await this.runtime.cleanup();
        } catch (error) {
            throw normalizeRuntimeError(this.name, 'cleanup', error);
        }
    }
}

function normalizeRuntimeError(
    runtime: string,
    phase: RuntimePhase,
    error: unknown
): RuntimeError {
    if (
        error instanceof RuntimeError &&
        error.runtime === runtime &&
        error.phase === phase
    ) {
        return error;
    }
    return new RuntimeError(
        runtime,
        phase,
        error instanceof Error ? error.message : String(error)
    );
}

function defaultSpawn(
    command: string[],
    options: {
        cwd: string;
        env: Record<string, string | undefined>;
        stdin: 'ignore';
        stdout: 'pipe';
        stderr: 'pipe';
    }
): SpawnedRunner {
    return Bun.spawn(command, options);
}
